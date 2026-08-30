// All the knobs live here so you can tune cost/quota vs. quality without
// touching orchestration logic. Nothing in pipeline.ts or backends.ts should
// hardcode a model name, token limit, or turn count — it should read from here.

// Model per tier, per backend. "scout" plans, "researcher" runs the search
// loop, "synthesizer" does the one expensive/careful reasoning pass.
export const BACKEND_MODELS = {
  api: {
    scout: "claude-haiku-4-5-20251001",
    researcher: "claude-sonnet-5",
    synthesizer: "claude-opus-5",
  },
  // Claude Code CLI aliases — resolved by your logged-in account's plan.
  pro: {
    scout: "haiku",
    researcher: "sonnet",
    synthesizer: "opus",
  },
} as const;

// $ per million tokens, input/output — API backend only. Verified against
// Anthropic's pricing page as of Aug 2026; re-check
// https://platform.claude.com/docs/en/about-claude/pricing before trusting
// cost estimates in production, since rates and model lineups change.
export const PRICING_USD_PER_MTOK: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5-20251001": { in: 1.0, out: 5.0 },
  "claude-sonnet-5": { in: 2.0, out: 10.0 },
  "claude-opus-5": { in: 5.0, out: 25.0 },
};
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

export const BUDGET = {
  // Hard $ stop for API-backend spend in a single run. Never applies to
  // pro-backend calls — those are bounded by your subscription's own usage
  // limits, which Claude Code enforces itself (that's what triggers fallback).
  maxRunCostUsd: 0.75,
  maxSearchTurns: 6,
  planMaxTokens: 500,
  researchTurnMaxTokens: 1200,
  synthesisMaxTokens: 4000,
  synthesisThinkingBudget: 3000, // API backend only — no CLI equivalent knob
  maxComparisonAxes: 4,
  compareSynthesisMaxTokens: 4000,
  compareThinkingBudget: 3000,
  askMaxTokens: 1500,
};

export const WEB_SEARCH_TOOL = {
  type: "web_search_20250305" as const,
  name: "web_search" as const,
  max_uses: BUDGET.maxSearchTurns,
};

// Fetches a specific URL directly (as opposed to web_search, which only
// runs search-engine queries and can't load a given page's actual content).
// Requires the beta header below on the API backend. Anthropic restricts
// this tool to URLs that have already appeared in the conversation — it
// can't dynamically construct or invent URLs to fetch — so the literal URL
// text has to be in the prompt for this to do anything (see pipeline.ts's
// research(), which puts it in the message content, not just the system
// prompt, specifically for this reason).
export const WEB_FETCH_TOOL = {
  type: "web_fetch_20250910" as const,
  name: "web_fetch" as const,
  max_uses: 5,
};
export const WEB_FETCH_BETA = "web-fetch-2025-09-10";

export const PRO_CLI = {
  binary: "claude",
  permissionMode: "dontAsk",
  // --bare is documented to skip only CLAUDE.md/hooks/plugins/MCP discovery,
  // but on at least some installs it also breaks credential loading — a
  // user hit "Not logged in" on every call, isolated down to this flag
  // (confirmed by removing it and retesting). Not worth the isolation
  // benefit given it can silently break auth. Leave this false.
  bare: false,
};