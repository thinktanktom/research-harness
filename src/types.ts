export interface ResearchPlan {
  questions: string[];
}

export interface Claim {
  statement: string;
  confidence: "high" | "medium" | "low";
  sources: string[];
}

export interface ResearchNote {
  question: string;
  notes: string;
  sources: string[];
}

export interface ResearchReport {
  topic: string;
  context?: string;
  summary: string;
  findings: Claim[];
  recommendation: string;
  action_items: string[];
  open_questions: string[];
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
  recommendation: string;
  rationale: string;
  action_items: string[];
  open_questions: string[];
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
