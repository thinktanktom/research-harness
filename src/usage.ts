import { PRICING_USD_PER_MTOK, CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, BUDGET } from "./config.js";
import type { UsageEvent } from "./types.js";

export class BudgetExceededError extends Error {}

// Tracks real usage from every call. API-backend calls accumulate real
// dollars against BUDGET.maxRunCostUsd. Pro-backend calls never do — they're
// bounded by your subscription's own usage limits, not by this tracker —
// but their token counts and Claude Code's own cost *estimate* are still
// recorded, purely for visibility into what you'd have paid on the API.
export class UsageTracker {
  private events: UsageEvent[] = [];

  record(e: UsageEvent) {
    this.events.push(e);
    if (e.backend === "api" && this.totalCostUsd() > BUDGET.maxRunCostUsd) {
      throw new BudgetExceededError(
        `Run exceeded API budget: $${this.totalCostUsd().toFixed(4)} > $${BUDGET.maxRunCostUsd}`
      );
    }
  }

  private apiCostOf(e: UsageEvent): number {
    const rate = PRICING_USD_PER_MTOK[e.model];
    if (!rate) return 0;
    const inputCost = (e.inputTokens / 1_000_000) * rate.in;
    const outputCost = (e.outputTokens / 1_000_000) * rate.out;
    const cacheReadCost = (e.cacheReadTokens / 1_000_000) * rate.in * CACHE_READ_MULTIPLIER;
    const cacheWriteCost = (e.cacheWriteTokens / 1_000_000) * rate.in * CACHE_WRITE_MULTIPLIER;
    return inputCost + outputCost + cacheReadCost + cacheWriteCost;
  }

  // Real dollars billed — API-backend events only.
  totalCostUsd(): number {
    return this.events.filter((e) => e.backend === "api").reduce((sum, e) => sum + this.apiCostOf(e), 0);
  }

  // Claude Code's own estimate of what pro-backend calls would have cost at
  // API rates. Not billed — informational only.
  totalEquivalentCostUsd(): number {
    return this.events
      .filter((e) => e.backend === "pro")
      .reduce((sum, e) => sum + (e.equivalentCostUsd ?? 0), 0);
  }

  countByBackend(): Record<string, number> {
    return this.events.reduce((acc, e) => {
      acc[e.backend] = (acc[e.backend] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }

  report(): string {
    const lines = this.events.map((e) => {
      const cost = e.backend === "api" ? `$${this.apiCostOf(e).toFixed(4)}` : `quota (~$${(e.equivalentCostUsd ?? 0).toFixed(4)} equiv.)`;
      return (
        `  [${e.backend}] ${e.phase.padEnd(14)} ${e.model.padEnd(24)} in:${e.inputTokens.toString().padStart(6)} ` +
        `out:${e.outputTokens.toString().padStart(6)} cache:${e.cacheReadTokens.toString().padStart(6)} ${cost}`
      );
    });
    lines.push(
      `  TOTAL BILLED (API):        $${this.totalCostUsd().toFixed(4)}`,
      `  COVERED BY PRO QUOTA:      ~$${this.totalEquivalentCostUsd().toFixed(4)} equivalent (not billed)`
    );
    return lines.join("\n");
  }
}
