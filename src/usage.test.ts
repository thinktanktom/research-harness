import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageTracker, BudgetExceededError } from "./usage.ts";
import type { UsageEvent } from "./types.ts";

const proEvent = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  phase: "plan",
  backend: "pro",
  model: "sonnet",
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  equivalentCostUsd: 0.01,
  ...over,
});

test("countByBackend tallies events per backend", () => {
  const u = new UsageTracker();
  u.record(proEvent());
  u.record(proEvent({ phase: "research" }));
  assert.deepEqual(u.countByBackend(), { pro: 2 });
});

test("pro-backend events never accrue real billed dollars", () => {
  const u = new UsageTracker();
  u.record(proEvent({ inputTokens: 5_000_000, outputTokens: 5_000_000 }));
  assert.equal(u.totalCostUsd(), 0);
});

test("pro-backend equivalent cost is summed for visibility", () => {
  const u = new UsageTracker();
  u.record(proEvent({ equivalentCostUsd: 0.02 }));
  u.record(proEvent({ equivalentCostUsd: 0.03 }));
  assert.ok(Math.abs(u.totalEquivalentCostUsd() - 0.05) < 1e-9);
});

test("BudgetExceededError is an Error subclass", () => {
  assert.ok(new BudgetExceededError("x") instanceof Error);
});
