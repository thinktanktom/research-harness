import { BUDGET } from "./config.js";
import { UsageTracker, BudgetExceededError } from "./usage.js";
import { ProQuotaExceededError, ProBackendUnavailableError, type Runner } from "./backends.js";
import type { ResearchNote, ResearchReport, CompareReport } from "./types.js";

// One retry for transient failures (network blip, a momentary tool error) —
// specifically for the research loop, which is the most failure-prone step
// since it's the only one doing real tool calls out to the network. Doesn't
// retry a budget stop or a quota/login issue, since retrying those wastes
// time on something that won't resolve itself.
async function withRetry<T>(fn: () => Promise<T>, retries = 1, delayMs = 1500): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const nonRetryable = err instanceof BudgetExceededError || err instanceof ProQuotaExceededError || err instanceof ProBackendUnavailableError;
    if (retries <= 0 || nonRetryable) throw err;
    await new Promise((r) => setTimeout(r, delayMs));
    return withRetry(fn, retries - 1, delayMs);
  }
}

// --- Planning ----------------------------------------------------------
export async function plan(
  runner: Runner,
  usage: UsageTracker,
  instructions: string,
  userContent: string,
  maxItems: number
): Promise<string[]> {
  const { text, usage: u } = await runner.text({
    phase: "plan",
    tier: "scout",
    system: instructions,
    prompt: userContent,
    webSearch: false,
    maxTokens: BUDGET.planMaxTokens,
  });
  usage.record(u);
  return text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, maxItems);
}

// --- Research ------------------------------------------------------------
export async function research(
  runner: Runner,
  usage: UsageTracker,
  topic: string,
  question: string,
  context?: string
): Promise<ResearchNote> {
  const contextLine = context ? `\nProject context (weigh relevance against this): ${context}` : "";
  const system =
    `You research one specific sub-question as part of a larger effort on "${topic}".` +
    contextLine +
    " Search only as much as needed to answer it with current, specific " +
    "information — don't pad with searches that don't change the answer. " +
    "Write terse notes (bullet points, not prose), and end with a flat " +
    "list of the source URLs you actually used.";
  const { text, usage: u } = await withRetry(() =>
    runner.text({
      phase: "research",
      tier: "researcher",
      system,
      prompt: question,
      webSearch: true,
      maxSearchTurns: BUDGET.maxSearchTurns,
      maxTokens: BUDGET.researchTurnMaxTokens,
    })
  );
  usage.record(u);
  const sources = [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0].replace(/[.,)]+$/, ""));
  return { question, notes: text, sources: [...new Set(sources)] };
}

// --- Synthesis: research report -----------------------------------------
const REPORT_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string" },
    summary: { type: "string", description: "2-4 sentence executive summary" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          sources: { type: "array", items: { type: "string" } },
        },
        required: ["statement", "confidence", "sources"],
      },
    },
    recommendation: {
      type: "string",
      description:
        "What this means for the user's own project, given their stated context. " +
        "Not a restatement of the findings — a call on what to actually do.",
    },
    action_items: {
      type: "array",
      items: { type: "string" },
      description: "Concrete next steps, specific enough to act on directly.",
    },
    open_questions: { type: "array", items: { type: "string" } },
  },
  required: ["topic", "summary", "findings", "recommendation", "action_items", "open_questions"],
};

export async function synthesizeResearch(
  runner: Runner,
  usage: UsageTracker,
  topic: string,
  notes: ResearchNote[],
  context?: string
): Promise<ResearchReport> {
  const compiled = notes.map((n) => `## ${n.question}\n${n.notes}`).join("\n\n");
  const contextBlock = context ? `\n\nProject context: ${context}` : "";
  const system =
    "You synthesize raw research notes into a calibrated report that informs a real " +
    "engineering decision. For every finding, assign confidence honestly: 'high' only " +
    "if multiple notes agree or a source is authoritative, 'low' if it rests on a " +
    "single weak source or the notes hedge. Do not smooth over contradictions between " +
    "notes — surface them as open questions instead of picking a side silently. Then, " +
    "given the project context, write a recommendation: a direct, specific call on " +
    "what to do, not a hedge-everything summary. Action items should be things the " +
    "user can literally go do next, not restated findings. If context wasn't provided, " +
    "keep the recommendation about the topic itself rather than guessing at a project.";
  const { data, usage: u } = await runner.structured({
    phase: "synthesize",
    tier: "synthesizer",
    system,
    prompt: `Topic: ${topic}${contextBlock}\n\nRaw notes:\n\n${compiled}`,
    webSearch: false,
    maxTokens: BUDGET.synthesisMaxTokens,
    thinkingBudget: BUDGET.synthesisThinkingBudget,
    schema: REPORT_SCHEMA,
    toolName: "submit_report",
    toolDescription: "Submit the final structured research report.",
  });
  usage.record(u);
  const report = data as ResearchReport;
  if (context) report.context = context;
  return report;
}

// --- Synthesis: comparison report ---------------------------------------
const COMPARE_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          pros: { type: "array", items: { type: "string" } },
          cons: { type: "array", items: { type: "string" } },
        },
        required: ["name", "pros", "cons"],
      },
    },
    recommendation: { type: "string", description: "Which option, stated directly." },
    rationale: {
      type: "string",
      description: "Why, specifically in light of the stated project context — not a generic tradeoff summary.",
    },
    action_items: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } },
  },
  required: ["decision", "options", "recommendation", "rationale", "action_items", "open_questions"],
};

export async function synthesizeCompare(
  runner: Runner,
  usage: UsageTracker,
  decision: string,
  options: string[],
  notes: ResearchNote[],
  context?: string
): Promise<CompareReport> {
  const compiled = notes.map((n) => `## ${n.question}\n${n.notes}`).join("\n\n");
  const contextBlock = context ? `\n\nProject context: ${context}` : "";
  const system =
    `You are deciding between: ${options.join(", ")}, for: "${decision}". Synthesize the ` +
    "research notes (each covering one comparison axis across all options) into pros/cons " +
    "per option, then make an actual recommendation — pick one, don't hedge into 'it " +
    "depends' unless the notes genuinely don't support a call, in which case say what " +
    "additional information would resolve it. Weight the recommendation by the stated " +
    "project context, not generic best practice.";
  const { data, usage: u } = await runner.structured({
    phase: "synthesize",
    tier: "synthesizer",
    system,
    prompt: `Decision: ${decision}${contextBlock}\n\nRaw notes:\n\n${compiled}`,
    webSearch: false,
    maxTokens: BUDGET.compareSynthesisMaxTokens,
    thinkingBudget: BUDGET.compareThinkingBudget,
    schema: COMPARE_SCHEMA,
    toolName: "submit_comparison",
    toolDescription: "Submit the final structured decision comparison.",
  });
  usage.record(u);
  const report = data as CompareReport;
  if (context) report.context = context;
  return report;
}