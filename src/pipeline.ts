import { BUDGET } from "./config.js";
import { UsageTracker, BudgetExceededError } from "./usage.js";
import { ProQuotaExceededError, ProBackendUnavailableError, type Runner } from "./backends.js";
import type { ResearchNote, ResearchReport, CompareReport } from "./types.js";

export const SOURCE_UNREACHABLE_MARKER = "SOURCE UNREACHABLE";

export function extractUrls(text: string): string[] {
  return [...new Set([...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0].replace(/[.,)]+$/, "")))];
}

// Checks a research note for the "couldn't verify the named source" flag,
// and returns which URL it was about (best effort — falls back to the
// first candidate if the note didn't quote the URL back exactly).
export function flaggedUnreachableUrl(noteText: string, candidateUrls: string[]): string | null {
  if (!noteText.includes(SOURCE_UNREACHABLE_MARKER)) return null;
  return candidateUrls.find((u) => noteText.includes(u)) ?? candidateUrls[0] ?? null;
}

// Thrown by the caller (harness.ts), not by research() itself — research()
// just reports what happened; the decision to stop the run belongs to the
// orchestration layer, which knows about --ignore-unreachable and what's
// already been spent.
export class SourceUnreachableError extends Error {
  constructor(public url: string) {
    super(`Couldn't verify the source you named: ${url}\nStopping here rather than synthesizing a report built on substitutes. Run with --ignore-unreachable to proceed anyway.`);
  }
}

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
// Rejects lines that are the model talking to the user rather than
// producing a question — a real failure we hit: the scout has no tools by
// design, refused to plan without them, and its "I need permission to
// access..." reply got split on newlines and researched as if each line
// were a sub-question. Cheap to catch here; expensive to discover after
// three research calls.
const NON_QUESTION_PATTERNS = [
  /\bI need (permission|access)\b/i,
  /\b(grant|give) (me )?permission\b/i,
  /\bcould you (please )?(grant|provide|share)\b/i,
  /\bI (can't|cannot|am unable to)\b/i,
  /\bto (generate|scope|produce).*(I need|I would need)\b/i,
];

function looksLikeQuestion(line: string): boolean {
  if (NON_QUESTION_PATTERNS.some((p) => p.test(line))) return false;
  return line.length > 10;
}

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
    // This step deliberately has no tools. Say so, so the model decomposes
    // from the topic text instead of stalling to ask for access it won't get.
    system:
      instructions +
      " You have NO tools and cannot browse, fetch, or run anything — that's " +
      "intentional. Work only from the topic text as given. If it names a source " +
      "you can't inspect, that's fine: write questions about it anyway (the " +
      "research step that follows this one does have web access). Never reply " +
      "with a request for permission or a question addressed to the user.",
    prompt: userContent,
    webSearch: false,
    maxTokens: BUDGET.planMaxTokens,
  });
  usage.record(u);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const questions = lines.filter(looksLikeQuestion).slice(0, maxItems);
  if (!questions.length) {
    throw new Error(
      `Planning step produced no usable sub-questions. It replied:\n${text.slice(0, 400)}\n\n` +
        `Stopping rather than researching that reply line-by-line.`
    );
  }
  return questions;
}

// --- Research ------------------------------------------------------------
export async function research(
  runner: Runner,
  usage: UsageTracker,
  topic: string,
  question: string,
  context?: string
): Promise<ResearchNote> {
  const topicUrls = extractUrls(topic);
  const contextLine = context ? `\nProject context (weigh relevance against this): ${context}` : "";
  const urlInstruction = topicUrls.length
    ? `\nThe topic names a specific source: ${topicUrls.join(", ")}. Fetch it directly (don't just ` +
      "search for related pages) and base your answer on what's actually there. If you cannot access " +
      `it after trying, write "${SOURCE_UNREACHABLE_MARKER}: <url>" as the very first line of your notes ` +
      "and stop there — do NOT substitute a similarly-named or related project as if it might be the " +
      "same thing, even if search turns up something that looks close."
    : "";
  const system =
    `You research one specific sub-question as part of a larger effort on "${topic}".` +
    contextLine +
    urlInstruction +
    " Search only as much as needed to answer it with current, specific " +
    "information — don't pad with searches that don't change the answer. " +
    "Write terse notes (bullet points, not prose), and end with a flat " +
    "list of the source URLs you actually used.";
  // The literal URL(s) also go in the user-turn content, not just the
  // system prompt: web_fetch/WebFetch can only target a URL that has
  // actually appeared in the conversation (a deliberate anti-exfiltration
  // restriction), and message content is the safest place to guarantee
  // that rather than relying on the system field counting.
  const prompt = topicUrls.length ? `${question}\n\nSource(s) to check directly: ${topicUrls.join(", ")}` : question;
  const { text, usage: u } = await withRetry(() =>
    runner.text({
      phase: "research",
      tier: "researcher",
      system,
      prompt,
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
const GLOSSARY_PROPERTY = {
  type: "array",
  description:
    "Every term in the explainer that a smart non-specialist wouldn't already know — technical " +
    "jargon, acronyms, product names used as concepts. Explain each as you would to someone with " +
    "no background in the field: concrete, everyday words, an analogy where it helps, no jargon " +
    "inside the explanation itself. Err on the side of including a term rather than assuming it's known.",
  items: {
    type: "object",
    properties: {
      term: { type: "string" },
      plain_explanation: { type: "string" },
    },
    required: ["term", "plain_explanation"],
  },
};

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string" },
    explainer: {
      type: "string",
      description:
        "The main content, and the only place the substance lives. Several paragraphs of flowing " +
        "prose covering, in order: what this is, what problem it exists to solve and for whom, and " +
        "how it actually achieves that. Write for a capable person with no background in this " +
        "specific field. Explain each piece of jargon in plain words at the moment you first use " +
        "it, inline, in the sentence itself. State uncertainty in the prose where it applies " +
        "(\"the project says X, though nothing outside its own documentation confirms it\") rather " +
        "than hedging everything uniformly. No bullet lists, no headings — connected paragraphs.",
    },
    glossary: GLOSSARY_PROPERTY,
    recommendation: {
      type: "string",
      description:
        "What this means for the user's own project, given their stated context. " +
        "A call on what to actually do, in the same plain language as the explainer.",
    },
    action_items: {
      type: "array",
      items: { type: "string" },
      description: "Concrete next steps, specific enough to act on directly.",
    },
    sources: {
      type: "array",
      items: { type: "string" },
      description: "The URLs the research actually drew on. Flat list, no commentary.",
    },
  },
  required: ["topic", "explainer", "glossary", "recommendation", "action_items", "sources"],
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
    "You turn raw research notes into an explanation a smart person with no background in this " +
    "field can actually follow. The `explainer` field carries the whole substance: several " +
    "paragraphs of connected prose covering what the thing is, what problem it exists to solve " +
    "and for whom, and how it actually achieves that — in that order. No bullets, no headings, " +
    "no list of claims. Assume the reader knows nothing about the domain: every time you use a " +
    "technical term, acronym, or product-as-concept, explain it in plain everyday words right " +
    "there in the sentence, and use a concrete analogy when one genuinely helps. Never explain " +
    "jargon with more jargon. Then list those same terms in `glossary` with standalone plain " +
    "explanations, so they can be looked up without re-reading the prose. Where the notes " +
    "disagree, or a claim rests only on the project's own say-so, work that into the prose as " +
    "you go (\'the project claims X, though nothing outside its own docs confirms it\') — never " +
    "present a shaky claim in the same confident voice as a well-supported one, and never " +
    "quietly pick a side when sources actually conflict. Then, given the project context, write " +
    "a recommendation: a direct, specific call on what to do, in the same plain language. Action " +
    "items should be things the user can literally go do next. If no context was provided, keep " +
    "the recommendation about the topic itself rather than guessing at a project.";
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
    glossary: GLOSSARY_PROPERTY,
    recommendation: { type: "string", description: "Which option, stated directly." },
    rationale: {
      type: "string",
      description:
        "Why, in plain language, specifically in light of the stated project context — not a " +
        "generic tradeoff summary. Explain any jargon inline as you use it. Where the evidence " +
        "is thin or sources conflict, say so here rather than presenting a confident pick.",
    },
    action_items: { type: "array", items: { type: "string" } },
    sources: {
      type: "array",
      items: { type: "string" },
      description: "The URLs the research actually drew on. Flat list, no commentary.",
    },
  },
  required: ["decision", "options", "glossary", "recommendation", "rationale", "action_items", "sources"],
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
    "project context, not generic best practice. Write for a reader with no background in " +
    "this field: explain every technical term, acronym, or product-as-concept in plain " +
    "everyday words the first time it appears, and list those same terms in `glossary` with " +
    "standalone explanations. Never explain jargon with more jargon.";
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