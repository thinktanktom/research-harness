import "dotenv/config";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { BUDGET } from "./config.js";
import { UsageTracker, BudgetExceededError } from "./usage.js";
import { Runner, type BackendMode } from "./backends.js";
import { plan, research, synthesizeResearch, synthesizeCompare } from "./pipeline.js";
import { runDir, saveNotes, loadNotes, saveJson, saveText } from "./store.js";
import { renderResearchMarkdown, renderCompareMarkdown } from "./render.js";
import { runAskOnce, runAskRepl } from "./ask.js";
import type { ResearchNote } from "./types.js";

const apiClient = new Anthropic({
  // Only needed if your API key is a personal/service-account key with
  // access to multiple workspaces — see README "Troubleshooting" if you hit
  // a 400 about anthropic-workspace-id being required. Harmless to set even
  // when running purely on the pro backend, since it's only read on fallback.
  defaultHeaders: process.env.ANTHROPIC_WORKSPACE_ID
    ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID }
    : undefined,
});
const usage = new UsageTracker();

function makeRunner(mode: BackendMode): Runner {
  return new Runner(apiClient, mode, (reason) => {
    console.error(`\n⚠ Pro plan unavailable, switching to API billing for the rest of this run.`);
    console.error(`  Reason: ${reason}\n`);
  });
}

// --- Mode: research ------------------------------------------------------
async function runResearch(runner: Runner, topic: string, context?: string, fromNotesPath?: string) {
  let notes: ResearchNote[];
  const dir = runDir(topic);

  if (fromNotesPath) {
    console.error(`Re-synthesizing from ${fromNotesPath} (no new searches)`);
    notes = loadNotes(fromNotesPath);
  } else {
    console.error(`Planning: ${topic}`);
    const questions = await plan(
      runner,
      usage,
      "You scope research plans. Given a topic, output 3-5 specific, " +
        "non-overlapping sub-questions that together cover what someone would " +
        "need to know to evaluate it. Respond with one question per line, nothing else.",
      `Topic: ${topic}`,
      5
    );
    console.error(`Plan: ${questions.length} sub-questions`);

    notes = [];
    for (const q of questions) {
      try {
        console.error(`Researching: ${q}`);
        notes.push(await research(runner, usage, topic, q, context));
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          console.error(`Budget hit mid-research — synthesizing with ${notes.length}/${questions.length} notes`);
          break;
        }
        throw err;
      }
    }
    saveNotes(dir, notes);
  }

  console.error("Synthesizing report");
  const report = await synthesizeResearch(runner, usage, topic, notes, context);
  saveJson(dir, "report.json", report);
  const md = renderResearchMarkdown(report);
  saveText(dir, "report.md", md);

  console.error(`\nSaved to ${dir}/`);
  console.error("--- Usage ---");
  console.error(usage.report());
  console.log(md);
}

// --- Mode: compare ---------------------------------------------------------
async function runCompare(runner: Runner, decision: string, options: string[], context?: string) {
  const dir = runDir(decision);

  console.error(`Planning comparison: ${decision} (${options.join(" vs ")})`);
  const axes = await plan(
    runner,
    usage,
    `You scope decision comparisons. The user is deciding between: ${options.join(", ")}, ` +
      `for: "${decision}". Output ${BUDGET.maxComparisonAxes} specific axes to compare them ` +
      "on (not generic ones — pick what actually differentiates these particular options for " +
      "this particular decision). Respond with one axis per line, nothing else.",
    context ? `Project context: ${context}` : "No additional context provided.",
    BUDGET.maxComparisonAxes
  );
  console.error(`Plan: ${axes.length} comparison axes`);

  const notes: ResearchNote[] = [];
  for (const axis of axes) {
    try {
      console.error(`Researching axis: ${axis}`);
      const question = `Compare ${options.join(" vs ")} on: ${axis}`;
      notes.push(await research(runner, usage, decision, question, context));
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.error(`Budget hit mid-research — synthesizing with ${notes.length}/${axes.length} axes`);
        break;
      }
      throw err;
    }
  }
  saveNotes(dir, notes);

  console.error("Synthesizing comparison");
  const report = await synthesizeCompare(runner, usage, decision, options, notes, context);
  saveJson(dir, "report.json", report);
  const md = renderCompareMarkdown(report);
  saveText(dir, "report.md", md);

  console.error(`\nSaved to ${dir}/`);
  console.error("--- Usage ---");
  console.error(usage.report());
  console.log(md);
}

// --- CLI -----------------------------------------------------------------
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    mode: { type: "string", default: "research" },
    context: { type: "string" },
    options: { type: "string" },
    "from-notes": { type: "string" },
    backend: { type: "string", default: "auto" }, // auto | pro | api
    "from-report": { type: "string" }, // ask mode: run directory to load
    ask: { type: "string" }, // ask mode: single non-interactive question
    "with-raw-notes": { type: "boolean", default: false }, // ask mode: include notes.json, not just report.json
  },
  allowPositionals: true,
});

const subject = positionals.join(" ");
const backendMode = values.backend as BackendMode;
if (!["auto", "pro", "api"].includes(backendMode)) {
  console.error(`Invalid --backend "${backendMode}" — must be auto, pro, or api`);
  process.exit(1);
}
const runner = makeRunner(backendMode);

async function main() {
  if (values.mode === "ask") {
    if (!values["from-report"]) throw new Error('ask mode needs --from-report <dir> (e.g. reports/my-topic-1234567890)');
    if (values.ask) {
      await runAskOnce(runner, usage, values["from-report"], values.ask, values["with-raw-notes"]);
    } else {
      await runAskRepl(runner, usage, values["from-report"], values["with-raw-notes"]);
    }
  } else if (values.mode === "compare") {
    if (!subject) throw new Error('compare mode needs a decision, e.g. --mode compare "testing framework" --options "Hardhat,Foundry"');
    if (!values.options) throw new Error('compare mode needs --options "A,B,C"');
    const options = values.options.split(",").map((o) => o.trim()).filter(Boolean);
    await runCompare(runner, subject, options, values.context);
  } else {
    if (!subject && !values["from-notes"]) throw new Error("research mode needs a topic");
    await runResearch(runner, subject || "re-synthesis", values.context, values["from-notes"]);
  }
}

main().catch((err) => {
  console.error("Run failed:", err.message);
  process.exit(1);
});
