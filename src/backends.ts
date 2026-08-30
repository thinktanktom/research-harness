import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { BACKEND_MODELS, PRO_CLI, WEB_SEARCH_TOOL } from "./config.js";
import type { UsageTracker } from "./usage.js";
import type { BackendName, UsageEvent, ConversationTurn } from "./types.js";

export type Tier = "scout" | "researcher" | "synthesizer";

export interface CallSpec {
  phase: string;
  tier: Tier;
  system: string;
  prompt: string;
  webSearch: boolean;
  maxTokens: number;
  maxSearchTurns?: number; // only meaningful when webSearch is true
  thinkingBudget?: number; // API backend only; ignored by pro
}

export interface StructuredCallSpec extends CallSpec {
  schema: Record<string, unknown>;
  toolName: string;
  toolDescription: string;
}

export interface CallResult {
  text: string;
  usage: UsageEvent;
}
export interface StructuredCallResult {
  data: any;
  usage: UsageEvent;
}

// A follow-up conversation over already-gathered research. `staticContext`
// (the report, optionally raw notes) is the expensive part — sent once and
// cached (API) or handed to a resumable session (pro) so it's never paid for
// or re-processed twice.
export interface ChatSpec {
  phase: string;
  tier: Tier;
  staticContext: string;
  history: ConversationTurn[]; // prior turns, NOT including the new question
  question: string;
  maxTokens: number;
  proSessionId?: string; // set on turn 2+ when backend is "pro", to --resume
}

export interface ChatResult {
  answer: string;
  usage: UsageEvent;
  proSessionId?: string; // pro backend only — persist this for the next turn
}

export class ProQuotaExceededError extends Error {
  constructor(message: string, public usage?: UsageEvent) {
    super(message);
  }
}
export class ProBackendUnavailableError extends Error {}
// A pro-backend call that failed for a reason other than quota — carries
// whatever usage Claude Code reported before it failed (so a crash partway
// through a tool-use loop doesn't silently disappear real spend), and the
// session_id if one was assigned, so a caller can resume instead of
// restarting from scratch.
export class ProCallFailedError extends Error {
  constructor(message: string, public usage?: UsageEvent, public sessionId?: string) {
    super(message);
  }
}

// ============================================================================
// API backend — calls the Anthropic SDK directly, billed per-token against
// your Console credit balance.
// ============================================================================

function usageFromApiResponse(phase: string, model: string, resp: Anthropic.Message): UsageEvent {
  return {
    phase,
    backend: "api",
    model,
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
    cacheReadTokens: resp.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: resp.usage.cache_creation_input_tokens ?? 0,
  };
}

export class ApiBackend {
  readonly name: BackendName = "api";
  constructor(private client: Anthropic) {}

  async completeText(spec: CallSpec): Promise<CallResult> {
    const model = BACKEND_MODELS.api[spec.tier];
    // Only the research-loop system prompt is cached: it's static across
    // every sub-question in a run, so this is where caching actually pays.
    const system =
      spec.tier === "researcher"
        ? [{ type: "text" as const, text: spec.system, cache_control: { type: "ephemeral" as const } }]
        : spec.system;
    const resp = await this.client.messages.create({
      model,
      max_tokens: spec.maxTokens,
      system,
      tools: spec.webSearch ? [WEB_SEARCH_TOOL] : undefined,
      messages: [{ role: "user", content: spec.prompt }],
    });
    const text = resp.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
    return { text, usage: usageFromApiResponse(spec.phase, model, resp) };
  }

  async completeStructured(spec: StructuredCallSpec): Promise<StructuredCallResult> {
    const model = BACKEND_MODELS.api[spec.tier];
    const tool: Anthropic.Tool = {
      name: spec.toolName,
      description: spec.toolDescription,
      input_schema: spec.schema as Anthropic.Tool.InputSchema,
    };
    const resp = await this.client.messages.create({
      model,
      max_tokens: spec.maxTokens,
      thinking: spec.thinkingBudget ? { type: "enabled", budget_tokens: spec.thinkingBudget } : undefined,
      system: spec.system,
      tools: [tool],
      tool_choice: { type: "tool", name: spec.toolName },
      messages: [{ role: "user", content: spec.prompt }],
    });
    const toolUse = resp.content.find((b) => b.type === "tool_use") as Anthropic.ToolUseBlock | undefined;
    if (!toolUse) throw new Error(`Model did not call ${spec.toolName}`);
    return { data: toolUse.input, usage: usageFromApiResponse(spec.phase, model, resp) };
  }

  // The static context (report + optional raw notes) goes in the system
  // prompt, cache_control'd — it's identical on every turn of this
  // conversation, so after turn 1 it's a 10%-cost cache read instead of
  // full-price input. History is replayed as messages, with a second cache
  // breakpoint on the last historical turn: everything up to "now" is
  // cached, only the newest question is genuinely fresh input.
  async chat(spec: ChatSpec): Promise<ChatResult> {
    const model = BACKEND_MODELS.api[spec.tier];
    const messages: Anthropic.MessageParam[] = spec.history.map((turn, i) => {
      const isLast = i === spec.history.length - 1;
      const content: Anthropic.MessageParam["content"] = isLast
        ? [{ type: "text", text: turn.content, cache_control: { type: "ephemeral" } }]
        : turn.content;
      return { role: turn.role, content };
    });
    messages.push({ role: "user", content: spec.question });
    const resp = await this.client.messages.create({
      model,
      max_tokens: spec.maxTokens,
      system: [{ type: "text", text: spec.staticContext, cache_control: { type: "ephemeral" } }],
      messages,
    });
    const answer = resp.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
    return { answer, usage: usageFromApiResponse(spec.phase, model, resp) };
  }
}

// ============================================================================
// Pro backend — shells out to `claude -p` (Claude Code headless mode),
// billed against your subscription's usage limits instead of API credits.
// ============================================================================

const QUOTA_PATTERNS = [
  /usage limit/i,
  /rate.?limit/i,
  /weekly limit/i,
  /5-hour limit/i,
  /\bquota\b/i,
  /upgrade your plan/i,
  /resets? (at|in)/i,
];

function looksLikeQuotaError(message: string): boolean {
  return QUOTA_PATTERNS.some((p) => p.test(message));
}

function runClaudeCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    // Strip any API key from the child's env so it can't silently bill your
    // Console balance behind your back — if it's not logged in via
    // `claude login`, it fails loudly instead of quietly switching billing.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const child = spawn(PRO_CLI.binary, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new ProBackendUnavailableError(`'${PRO_CLI.binary}' not found on PATH. Is Claude Code installed and logged in ('claude login')?`));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

function baseArgs(spec: CallSpec, maxTurns: number, restrictTools = true): string[] {
  const model = BACKEND_MODELS.pro[spec.tier];
  const args = [
    "-p",
    spec.prompt,
    "--model",
    model,
    "--append-system-prompt",
    spec.system,
    "--output-format",
    "json",
    "--permission-mode",
    PRO_CLI.permissionMode,
    ...(PRO_CLI.bare ? ["--bare"] : []),
    "--max-turns",
    String(maxTurns),
  ];
  // Only restrict tools for plain-text calls (plan/research). Structured
  // (--json-schema) calls skip this: blocking all tools apparently also
  // blocks whatever internal mechanism Claude Code uses to emit
  // schema-validated output — confirmed by a real failure where a synthesis
  // call with --allowedTools "" silently fell back to a plain-text
  // explanation instead of the requested JSON. --permission-mode dontAsk
  // still prevents interactive prompts either way.
  if (restrictTools) {
    args.push("--allowedTools", spec.webSearch ? "WebSearch" : "");
  }
  return args;
}

// Only throws for the two cases where there's genuinely nothing to extract:
// no output at all, or output that isn't valid JSON. A well-formed error
// result (is_error: true) is returned as-is — the caller checks that, since
// it's the caller (not this function) that knows the phase/model needed to
// build a usage event from whatever Claude Code reports it spent before failing.
function parseProResult(stdout: string, stderr: string, code: number): any {
  const trimmed = stdout.trim();
  if (!trimmed) {
    const detail = stderr.trim()
      ? `stderr: ${stderr.trim().slice(0, 500)}`
      : "stderr was also empty — process likely killed or crashed before writing anything. Try running the same call by hand (see baseArgs() for the exact flags) to see the interactive error.";
    throw new Error(`Claude Code exited with code ${code} and produced no output on stdout. ${detail}`);
  }
  const lastLine = trimmed.split("\n").filter(Boolean).pop()!;
  try {
    return JSON.parse(lastLine);
  } catch {
    const detail = stderr.trim() ? `\nstderr: ${stderr.trim().slice(0, 300)}` : "";
    throw new Error(`Claude Code returned non-JSON output (exit ${code}): ${trimmed.slice(0, 300)}${detail}`);
  }
}

// Checks a parsed result for is_error/non-zero exit. If it failed, builds a
// usage event from whatever Claude Code reported (real work isn't lost just
// because the call ultimately errored) and throws it attached to the error,
// so callers can record it before deciding whether to retry/fall back.
function checkProResult(parsed: any, code: number, stderr: string, phase: string, model: string): any {
  if (parsed.is_error || code !== 0) {
    const message = String(parsed.result ?? (stderr.trim() ? stderr.trim().slice(0, 500) : `exit code ${code}, no result field, no stderr`));
    const usage = usageFromProResult(`${phase}:failed`, model, parsed);
    if (looksLikeQuotaError(message)) throw new ProQuotaExceededError(message, usage);
    throw new ProCallFailedError(message, usage, parsed.session_id);
  }
  return parsed;
}

function usageFromProResult(phase: string, model: string, parsed: any): UsageEvent {
  return {
    phase,
    backend: "pro",
    model,
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
    cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
    equivalentCostUsd: parsed.total_cost_usd ?? 0,
  };
}

export class ProBackend {
  readonly name: BackendName = "pro";

  // If the first attempt failed but left a session_id (a "graceful" error —
  // Claude Code wrote a result, just an unsuccessful one), resume that exact
  // session with a short continuation nudge instead of resending the whole
  // original prompt. Whatever tool calls/turns already happened before the
  // failure stay in the session server-side, so we're not paying quota to
  // redo them. If there's no session_id (a silent crash — no output at
  // all), there's nothing to resume; this just rethrows and the caller's
  // own from-scratch retry (see pipeline.ts's withRetry) is the fallback.
  private async runWithResumeOnFailure(
    initialArgs: string[],
    spec: CallSpec,
    continuationNote: string,
    restrictTools = true,
    schema?: Record<string, unknown>
  ): Promise<any> {
    const model = BACKEND_MODELS.pro[spec.tier];
    try {
      const { stdout, stderr, code } = await runClaudeCli(initialArgs);
      return checkProResult(parseProResult(stdout, stderr, code), code, stderr, spec.phase, model);
    } catch (err) {
      if (!(err instanceof ProCallFailedError) || !err.sessionId) throw err;
      const resumeArgs = [
        "-p",
        continuationNote,
        "--model",
        model,
        "--output-format",
        "json",
        "--permission-mode",
        PRO_CLI.permissionMode,
        ...(restrictTools ? ["--allowedTools", spec.webSearch ? "WebSearch" : ""] : []),
        "--max-turns",
        String(spec.webSearch ? 4 : 2),
        "--resume",
        err.sessionId,
        ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
      ];
      const { stdout, stderr, code } = await runClaudeCli(resumeArgs);
      return checkProResult(parseProResult(stdout, stderr, code), code, stderr, `${spec.phase}:resumed`, model);
      // Deliberately not caught again — if the resume attempt also fails,
      // that error (with its own usage/sessionId) propagates as-is. One
      // resume attempt, not a loop; pipeline.ts's retry is the outer net.
    }
  }

  async completeText(spec: CallSpec): Promise<CallResult> {
    const maxTurns = spec.webSearch ? (spec.maxSearchTurns ?? 6) + 2 : 2;
    const parsed = await this.runWithResumeOnFailure(
      baseArgs(spec, maxTurns),
      spec,
      "The previous attempt was interrupted before finishing. Please continue from where you left off " +
        "and give your complete answer now — don't repeat searches or work you already did."
    );
    return { text: String(parsed.result ?? ""), usage: usageFromProResult(spec.phase, BACKEND_MODELS.pro[spec.tier], parsed) };
  }

  async completeStructured(spec: StructuredCallSpec): Promise<StructuredCallResult> {
    const args = [...baseArgs(spec, 2, /* restrictTools */ false), "--json-schema", JSON.stringify(spec.schema)];
    const parsed = await this.runWithResumeOnFailure(
      args,
      spec,
      "The previous attempt was interrupted before you submitted your result. Please continue and " +
        "call the required tool now with your complete answer — don't repeat work you already did.",
      /* restrictTools */ false,
      spec.schema
    );
    if (!parsed.structured_output) {
      throw new Error(
        `Claude Code returned no structured_output for a --json-schema call (result was: ` +
          `${String(parsed.result ?? "").slice(0, 200)}). The model likely couldn't fulfill the schema — ` +
          `check the system/prompt for this phase.`
      );
    }
    return { data: parsed.structured_output, usage: usageFromProResult(spec.phase, BACKEND_MODELS.pro[spec.tier], parsed) };
  }

  // Turn 1: send the static context + question together, capture the
  // returned session_id. Turn 2+: --resume that session with just the new
  // question — Claude Code keeps the prior context (and its own internal
  // caching) server-side, so we never resend the report or earlier turns.
  async chat(spec: ChatSpec): Promise<ChatResult> {
    const model = BACKEND_MODELS.pro[spec.tier];
    const isFirstTurn = !spec.proSessionId;
    const prompt = isFirstTurn ? `${spec.staticContext}\n\n---\n\nQuestion: ${spec.question}` : spec.question;
    const args = [
      "-p",
      prompt,
      "--model",
      model,
      "--output-format",
      "json",
      "--permission-mode",
      PRO_CLI.permissionMode,
      ...(PRO_CLI.bare ? ["--bare"] : []),
      "--allowedTools",
      "",
      "--max-turns",
      "2",
      ...(spec.proSessionId ? ["--resume", spec.proSessionId] : []),
    ];
    const { stdout, stderr, code } = await runClaudeCli(args);
    const parsed = checkProResult(parseProResult(stdout, stderr, code), code, stderr, spec.phase, model);
    return {
      answer: String(parsed.result ?? ""),
      usage: usageFromProResult(spec.phase, model, parsed),
      proSessionId: parsed.session_id ?? spec.proSessionId,
    };
  }
}

// ============================================================================
// Runner — the thing pipeline.ts actually calls. Prefers the pro backend by
// default; on a quota-shaped failure, falls back to the API backend and
// *stays* on it for the rest of the run (no point retrying an exhausted
// weekly limit call by call). Set mode to "pro" or "api" to disable fallback
// and pin one backend.
// ============================================================================

export type BackendMode = "auto" | "pro" | "api";

export class Runner {
  private pro = new ProBackend();
  private api: ApiBackend;
  private exhausted = false;

  constructor(
    apiClient: Anthropic,
    private mode: BackendMode,
    private usageTracker: UsageTracker,
    private onFallback: (reason: string) => void
  ) {
    this.api = new ApiBackend(apiClient);
  }

  private get preferPro(): boolean {
    return this.mode !== "api" && !this.exhausted;
  }

  // Records whatever Claude Code reported it had spent before a call failed
  // — a mid-loop crash doesn't just vanish because the call ultimately
  // errored. Applies whether we're about to retry, fall back, or give up.
  private recordPartialUsage(err: unknown) {
    const usage = (err as { usage?: UsageEvent }).usage;
    if (usage) this.usageTracker.record(usage);
  }

  private async withFallback<T>(run: (backend: ApiBackend | ProBackend) => Promise<T>): Promise<T> {
    if (this.preferPro) {
      try {
        return await run(this.pro);
      } catch (err) {
        this.recordPartialUsage(err);
        if (this.mode === "pro") throw err; // pinned to pro — surface the real error
        if (err instanceof ProQuotaExceededError || err instanceof ProBackendUnavailableError) {
          this.exhausted = true;
          this.onFallback(err.message);
        } else {
          throw err; // a real bug in the call, not a quota issue — don't mask it
        }
      }
    }
    return run(this.api);
  }

  text(spec: CallSpec): Promise<CallResult> {
    return this.withFallback((b) => b.completeText(spec));
  }

  structured(spec: StructuredCallSpec): Promise<StructuredCallResult> {
    return this.withFallback((b) => b.completeStructured(spec));
  }

  // On fallback mid-conversation, `spec.history` (kept by the caller, not by
  // either backend) already has everything needed to reconstruct context on
  // the API — there's no pro session to resume, but nothing is lost, since
  // the caller never depended on pro's session state being the source of
  // truth. The one-time cost is that turn's system prompt isn't cache-warm
  // yet; every turn after that is.
  chat(spec: ChatSpec): Promise<ChatResult> {
    return this.withFallback((b) => b.chat(spec));
  }
}