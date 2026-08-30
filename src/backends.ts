import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { BACKEND_MODELS, PRO_CLI, WEB_SEARCH_TOOL } from "./config.js";
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

export class ProQuotaExceededError extends Error {}
export class ProBackendUnavailableError extends Error {}

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

function runClaudeCli(args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    // Strip any API key from the child's env so it can't silently bill your
    // Console balance behind your back — if it's not logged in via
    // `claude login`, it fails loudly instead of quietly switching billing.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const child = spawn(PRO_CLI.binary, args, { env });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new ProBackendUnavailableError(`'${PRO_CLI.binary}' not found on PATH. Is Claude Code installed and logged in ('claude login')?`));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => resolve({ stdout, code: code ?? 1 }));
  });
}

function baseArgs(spec: CallSpec, maxTurns: number): string[] {
  const model = BACKEND_MODELS.pro[spec.tier];
  return [
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
    "--allowedTools",
    spec.webSearch ? "WebSearch" : "",
    "--max-turns",
    String(maxTurns),
  ];
}

function parseProResult(stdout: string, code: number): any {
  const lastLine = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
  let parsed: any;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    throw new Error(`Claude Code returned non-JSON output (exit ${code}): ${stdout.slice(0, 300)}`);
  }
  if (parsed.is_error || code !== 0) {
    const message = String(parsed.result ?? `exit code ${code}`);
    if (looksLikeQuotaError(message)) throw new ProQuotaExceededError(message);
    throw new Error(`Claude Code error: ${message}`);
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

  async completeText(spec: CallSpec): Promise<CallResult> {
    const maxTurns = spec.webSearch ? (spec.maxSearchTurns ?? 6) + 2 : 2;
    const { stdout, code } = await runClaudeCli(baseArgs(spec, maxTurns));
    const parsed = parseProResult(stdout, code);
    return { text: String(parsed.result ?? ""), usage: usageFromProResult(spec.phase, BACKEND_MODELS.pro[spec.tier], parsed) };
  }

  async completeStructured(spec: StructuredCallSpec): Promise<StructuredCallResult> {
    const args = [...baseArgs(spec, 2), "--json-schema", JSON.stringify(spec.schema)];
    const { stdout, code } = await runClaudeCli(args);
    const parsed = parseProResult(stdout, code);
    const data = parsed.structured_output ?? JSON.parse(parsed.result);
    return { data, usage: usageFromProResult(spec.phase, BACKEND_MODELS.pro[spec.tier], parsed) };
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
    const { stdout, code } = await runClaudeCli(args);
    const parsed = parseProResult(stdout, code);
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
    private onFallback: (reason: string) => void
  ) {
    this.api = new ApiBackend(apiClient);
  }

  private get preferPro(): boolean {
    return this.mode !== "api" && !this.exhausted;
  }

  private async withFallback<T>(run: (backend: ApiBackend | ProBackend) => Promise<T>): Promise<T> {
    if (this.preferPro) {
      try {
        return await run(this.pro);
      } catch (err) {
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
