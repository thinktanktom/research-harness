export interface ResearchPlan {
  questions: string[];
}

export interface GlossaryEntry {
  term: string;
  plain_explanation: string;
}

export interface ResearchNote {
  question: string;
  notes: string;
  sources: string[];
}

export interface ResearchReport {
  topic: string;
  context?: string;
  // The main content: multi-paragraph plain-language prose covering what it
  // is, what problem it solves, and how it actually works — with jargon
  // explained inline the first time it appears, and uncertainty stated in
  // the prose itself ("the project claims X, though nothing independent
  // confirms it") rather than in a separate confidence column.
  explainer: string;
  glossary: GlossaryEntry[];
  recommendation: string;
  action_items: string[];
  sources: string[];
}

export interface OptionAssessment {
  name: string;
  pros: string[];
  cons: string[];
}

export interface CompareReport {
  decision: string;
  context?: string;
  options: OptionAssessment[];
  glossary: GlossaryEntry[];
  recommendation: string;
  rationale: string;
  action_items: string[];
  sources: string[];
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export type BackendName = "pro" | "api";

export interface UsageEvent {
  phase: string;
  backend: BackendName;
  model: string; // e.g. "claude-sonnet-5" (api) or "sonnet" (pro, CLI alias)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Only set for backend "pro": Claude Code's own estimate of what this call
  // would have cost at API rates. Informational only — not actually billed,
  // since pro-backend calls draw from your subscription's usage limits instead.
  equivalentCostUsd?: number;
}