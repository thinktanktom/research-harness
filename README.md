# research-harness

A deep-research harness aimed at feeding your own engineering decisions, not just
producing neutral summaries. Two modes, one pipeline: `plan -> search -> calibrated
report ending in an actual recommendation`. Every knob lives in `src/config.ts`.

## Backend: Pro plan by default, API as fallback

By default the harness runs on your **Pro plan** — every call shells out to
`claude -p` (Claude Code headless mode), billed against your subscription's
usage limits instead of API credits. If Claude Code reports something that
looks like a quota/rate-limit error, the harness automatically switches to
the **API backend** for the rest of that run (and stays there — no point
retrying an exhausted weekly limit call by call):

```
npm run research -- "zk-rollup fee model tradeoffs" \
  --context "Solidity, multi-chain EVM, Base and PulseChain"
# → runs on Pro. If quota runs out mid-run, you'll see:
#   ⚠ Pro plan unavailable, switching to API billing for the rest of this run.
#   Reason: <the error Claude Code reported>
# ...and the run finishes on the API instead of dying.
```

Override with `--backend`:

- `--backend pro` — pin to Pro, fail loudly instead of falling back (useful
  if you want to know you've hit your limit rather than silently spend money).
- `--backend api` — skip Pro entirely, go straight to the API.
- `--backend auto` (default) — Pro first, fall back on quota exhaustion.

**Prerequisites for the Pro backend**: Claude Code must be installed and
logged in via `claude login` (not an API key — see below). The harness
strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the child process it
spawns specifically so it can't silently bill your Console balance instead
of using your subscription — if `claude` isn't logged in, it fails with a
clear error rather than doing something you didn't ask for.

**What's different between the two backends, concretely:**

| | Pro (`claude -p`) | API (SDK) |
|---|---|---|
| Billing | Subscription usage limits | Per-token, your Console balance |
| Opus for synthesis | Available, but burns quota ~3x faster than Sonnet | Same per-token rate as any model |
| Extended thinking budget | Not exposed — Claude Code manages it internally | `thinking.budget_tokens`, tuned in `config.ts` |
| Prompt caching | Not controllable | `cache_control` on the research system prompt |
| System prompt | Appended to Claude Code's own default agent prompt (`--append-system-prompt`) — can't fully replace it | Set directly, no default persona underneath |
| Cost visibility | Claude Code's own `total_cost_usd` estimate, logged but not billed | Real `$` computed from `config.ts` pricing table |
| Structured output | `--json-schema`, returned in `structured_output` | Forced `tool_choice` on a schema'd tool |

The system-prompt point is worth sitting with: on the Pro backend, the
research/synthesis personas layer on top of Claude Code's own default coding-
assistant framing rather than fully replacing it, since `--append-system-prompt`
appends rather than overrides. In practice this hasn't caused problems in
testing, but it means behavior isn't byte-for-byte identical between backends
— if a report reads oddly Pro-backend-only, that's the first place to look.

The usage report at the end of every run shows both: real dollars billed
(API-backend calls) and quota "spent" (Pro-backend calls, with Claude Code's
own cost estimate shown for reference, clearly marked as not billed).

## Setup

```
npm install
cp .env.example .env   # ANTHROPIC_API_KEY only needed for the API fallback —
                        # see "Backend" above if you're running on Pro by default
claude login            # needed once, for the Pro backend
```

## Mode 1: research a topic

```
npm run research -- "PulseChain bridge security track record" \
  --context "Evaluating whether to route BankX liquidity through it"
```

Produces findings + a **Recommendation** + **Action Items** section, calibrated against
your `--context` if you give one. Without `--context`, the recommendation stays about
the topic itself rather than guessing at a project.

## Mode 2: compare named options for a decision

```
npm run research -- --mode compare "smart contract testing framework" \
  --options "Hardhat,Foundry" \
  --context "Solidity, multi-chain EVM (Base, PulseChain), existing Hardhat scripts"
```

Plans a handful of comparison axes specific to *these* options and *this* decision
(not a generic checklist), researches each axis once across all options together
(so cost scales with axes, not `axes × options`), then forces a direct pick —
the synthesis prompt is told not to hedge into "it depends" unless the evidence
genuinely doesn't support a call.

## Mode 3: follow-up questions on a report

```
npm run research -- --mode ask --from-report reports/pulsechain-bridge-1234567890
```

Opens an interactive prompt over an already-generated report. This is the
"don't re-upload and re-digest everything per question" mode — the report
(and optionally the raw notes, with `--with-raw-notes`) is sent **once** as
static context, not resent with every question:

- **API backend**: the context sits in a `cache_control`'d system block, and
  each turn's history gets a fresh cache breakpoint on the last message —
  so every question after the first pays full price only for that question;
  everything before it is a 10%-cost cache read, not a full re-send.
- **Pro backend**: turn 1 sends the context and captures Claude Code's
  `session_id`; every question after that uses `claude --resume <id>`, so
  the CLI's own session handles context server-side and we never resend
  anything at all.

Conversation state is saved to `reports/<dir>/conversation.json` (and
`pro-session.json` for the pro backend's session id), so you can close the
REPL and pick the same conversation back up later:

```
npm run research -- --mode ask --from-report reports/pulsechain-bridge-1234567890
# Resuming a conversation with 2 prior exchange(s) in reports/pulsechain-bridge-1234567890
# > does this change if we also support Arbitrum?
```

For scripting or a single one-off doubt without opening the REPL:

```
npm run research -- --mode ask --from-report reports/pulsechain-bridge-1234567890 \
  --ask "what's the weakest finding in here and why?"
```

`--with-raw-notes` pulls in `notes.json` alongside the report for deeper
digging — useful if a follow-up needs detail the synthesis step compressed
away, at the cost of a larger (still-cached-after-turn-1) context.

One honest caveat on the API backend: the cache is ephemeral (a few minutes).
Rapid-fire questions stay cheap; if you walk away for a while and come back,
the next question just pays full price again to rebuild it — not broken,
just not discounted that once. The pro backend's session resume doesn't have
this issue in the same way, since Claude Code manages that server-side.

## Re-synthesizing without re-searching

Every run saves its raw per-question notes to `reports/<slug>-<timestamp>/notes.json`
before synthesis. If you want to redo the recommendation — new `--context`, decided
you now also need to support another chain, whatever — without paying for search again:

```
npm run research -- --from-notes reports/pulsechain-bridge-.../notes.json \
  --context "Now also considering Arbitrum as a fallback"
```

This is the answer to "should decision-support be an add-on or a separate tool
that consumes research output": it's the same harness, and `notes.json` /
`report.json` on disk are the interchange format. You get the modularity of a
two-stage pipeline (re-run synthesis cheaply, reuse research across decisions)
without maintaining two codebases with duplicated cost tracking, caching, and
budget logic. If you eventually want compare mode to consume a *research* mode's
notes directly (e.g. research two options separately, then compare them), that's
a natural next extension of `--from-notes` — not currently wired up, since it'd
need axis-shaped notes rather than topic-shaped ones.

Every run also writes `report.md` and `report.json` to the same directory, so
`reports/` becomes a running log of decisions and why you made them — worth
keeping around, not just the stdout output.

Report prints to stdout as markdown; a run log (plan, per-question progress, and a
per-call cost breakdown) prints to stderr so you can pipe stdout straight to a file.

## Architecture — why three stages, three models

| Stage | Model | Why |
|---|---|---|
| Plan | `haiku-4.5` | Decomposing a topic into sub-questions doesn't need a strong model. Getting this on the cheapest tier costs basically nothing and stops the research stage from wandering. |
| Research | `sonnet-5` | Does the actual `web_search` tool-calling per sub-question. Balanced tier — strong enough to judge source quality, cheap enough to run several times per report. |
| Synthesize | `opus-5` | Runs once, with extended thinking, to reconcile notes and assign honest confidence levels. This is the one call where paying for a stronger model is worth it, because it's the only step that touches every piece of evidence at once. |

This is the main lever for **cost**: you're not paying Opus rates for every search
turn, only for the single call that needs the extra reasoning. Swap any of the three
in `MODELS` — e.g. drop `researcher` to `haiku` for a cheaper/rougher run, or bump it
to `opus` if a topic needs sharper source judgment mid-research.

## Where the calibration comes from

"Better answers" here specifically means: the report doesn't present shaky claims
with the same confidence as well-sourced ones, and it doesn't quietly resolve
contradictions between sources.

- The synthesis system prompt explicitly instructs the model to grade confidence
  by source agreement/authority, not by how confident the prose sounds, and to
  surface contradictions as open questions rather than picking a side.
- Extended thinking (`BUDGET.synthesisThinkingBudget`) is spent only here, where
  there's actual reasoning to do (weighing conflicting notes) — not on the plan
  or search steps, where it would just burn tokens on a mechanical task.
- Output is forced through a `submit_report` tool call with a fixed schema, so
  you get `{statement, confidence, sources}` per finding instead of prose you'd
  have to re-parse or eyeball.

If you want to push quality further, the cheapest next step is usually a second
pass — feed the report back to the synthesizer with "attack your own findings, what's
weakest here?" — before spending more on the model tier.

## Where the token savings come from

1. **Model tiering** (above) — the largest lever by far.
2. **Prompt caching** on the research-stage system prompt (`cache_control: ephemeral`).
   It's static across every sub-question in a run, so after the first call you're
   paying 10% of input price for it on every subsequent one.
3. **Output caps per phase** (`BUDGET.*MaxTokens`) — output tokens cost 5x input
   tokens across the board, so this is worth tuning before anything else if a run
   is running expensive.
4. **`max_uses` on the search tool** (`BUDGET.maxSearchTurns`) — stops a single
   research call from spiraling into an open-ended search session.
5. **Hard budget ceiling** (`BUDGET.maxRunCostUsd`) — `UsageTracker` reads real
   token counts off every API response (not estimates) and throws once the run
   would exceed it. On a mid-run budget hit, the harness synthesizes with
   whatever notes it already has rather than failing the whole run.

## Files added for decision support

- `src/backends.ts` — `ApiBackend`, `ProBackend`, and the `Runner` that
  dispatches between them with sticky fallback. Also where `chat()` lives —
  the cached/session-resuming multi-turn call both backends implement.
- `src/ask.ts` — the follow-up Q&A mode: builds the static context once,
  drives either the interactive REPL or a single `--ask` question, and
  persists conversation state so it survives across process runs.
- `src/pipeline.ts` — `plan`/`research`/`synthesizeResearch`/`synthesizeCompare`,
  shared by both modes and backend-agnostic — they call `runner.text(...)` /
  `runner.structured(...)` and don't know or care which backend actually ran.
- `src/store.ts` — saves/loads `notes.json`, `report.json`,
  `conversation.json`, and `pro-session.json` per run under
  `reports/<slug>-<timestamp>/`. This is what makes `--from-notes` and
  `--mode ask` possible.
- `src/harness.ts` — the CLI (`node:util`'s `parseArgs`), dispatching to
  `runResearch`, `runCompare`, or the ask-mode functions with a constructed
  `Runner`.

## Extending it

- **Parallelize research**: the sub-question loop in `runResearch` is currently
  sequential (`for...await`) so stderr progress logs stay readable. Swap to
  `Promise.all` once you trust the budget ceiling to hold under concurrent calls
  — note `UsageTracker` isn't concurrency-safe as written (no lock on `.record`).
- **Batch API**: if you're running many topics overnight rather than one
  interactively, routing through the Batch API halves every token cost above —
  worth it once a single report stops being the unit of work.
- **Swap the report schema**: `types.ts` + `REPORT_TOOL.input_schema` in
  `harness.ts` are the two places to edit if you want different fields
  (e.g. a risk-scored section, a pricing-comparison table).

## Troubleshooting

**`'claude' not found on PATH`** — the Pro backend shells out to the Claude
Code CLI; it needs to actually be installed. Install it, then `claude login`
to authenticate with your subscription (not an API key — see above for why
that matters).

**Pro backend keeps falling back to API immediately** — run `claude -p
"hello" --output-format json` by hand and check the `result`/`is_error`
fields. If it's an auth problem, `claude login` again. If it's a genuine
quota exhaustion message, that's the fallback working correctly — check
`claude /usage` (or the account page) for when your window resets.

**`400: anthropic-workspace-id is required when authenticating with an
identity-linked API key`** — your key is a personal or service-account key
with access to more than one workspace, so every request needs to say which
workspace it runs in. Two fixes:

1. **Add the header** (works with your existing key): find your workspace ID
   (`wrkspc_...`) under your organization's workspace settings at
   platform.claude.com, then set `ANTHROPIC_WORKSPACE_ID` in `.env`. The
   harness reads it automatically.
2. **Use a workspace-scoped key instead** — create an API key bound to one
   workspace in the Console, and it never needs this header at all. Simpler
   if you're not actively using multiple workspaces.

## A note on the pricing numbers

`config.ts` hardcodes per-model $/MTok rates so `UsageTracker` can report real
costs instead of just token counts. These were verified against
https://platform.claude.com/docs/en/about-claude/pricing as of Aug 2026 —
re-check that page before trusting the dollar figures for anything that matters,
since rates and model lineups change.
