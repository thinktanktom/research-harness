import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { BUDGET } from "./config.js";
import { UsageTracker } from "./usage.js";
import type { Runner } from "./backends.js";
import { loadConversation, saveConversation, loadProSessionId, saveProSessionId } from "./store.js";
import type { ConversationTurn, ResearchReport, CompareReport, ResearchNote } from "./types.js";

// Builds the static context once per process — this is the thing that's
// expensive to send, so it's built exactly once and then reused (cached on
// the API side, handed to a resumable session on the pro side) rather than
// reconstructed or resent per question.
function buildContext(dir: string, includeRawNotes: boolean): string {
  const reportPath = join(dir, "report.json");
  if (!existsSync(reportPath)) {
    throw new Error(`No report.json in ${dir} — run research or compare mode first`);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf-8")) as ResearchReport | CompareReport;
  const parts = [`Here is a research report you previously generated:\n\n${JSON.stringify(report, null, 2)}`];

  if (includeRawNotes) {
    const notesPath = join(dir, "notes.json");
    if (existsSync(notesPath)) {
      const notes = JSON.parse(readFileSync(notesPath, "utf-8")) as ResearchNote[];
      const compiled = notes.map((n) => `## ${n.question}\n${n.notes}`).join("\n\n");
      parts.push(`\n\nThe raw research notes behind that report:\n\n${compiled}`);
    }
  }

  parts.push(
    "\n\nAnswer follow-up questions about this report directly and specifically. " +
      "Ground answers in the report/notes above; if a question needs information " +
      "that isn't in them, say so plainly rather than guessing."
  );
  return parts.join("");
}

async function askOnce(
  runner: Runner,
  usage: UsageTracker,
  dir: string,
  staticContext: string,
  history: ConversationTurn[],
  question: string
): Promise<string> {
  const proSessionId = loadProSessionId(dir);
  const { answer, usage: u, proSessionId: newSessionId } = await runner.chat({
    phase: "ask",
    tier: "researcher",
    staticContext,
    history,
    question,
    maxTokens: BUDGET.askMaxTokens,
    proSessionId,
  });
  usage.record(u);
  if (newSessionId) saveProSessionId(dir, newSessionId);

  const updated = [...history, { role: "user" as const, content: question }, { role: "assistant" as const, content: answer }];
  saveConversation(dir, updated);
  return answer;
}

// Single question, non-interactive — for scripting: `--ask "..."`.
export async function runAskOnce(runner: Runner, usage: UsageTracker, dir: string, question: string, includeRawNotes: boolean) {
  const staticContext = buildContext(dir, includeRawNotes);
  const history = loadConversation(dir);
  const answer = await askOnce(runner, usage, dir, staticContext, history, question);
  console.log(answer);
  console.error("\n--- Usage ---");
  console.error(usage.report());
}

// Interactive follow-up loop.
export async function runAskRepl(runner: Runner, usage: UsageTracker, dir: string, includeRawNotes: boolean) {
  const staticContext = buildContext(dir, includeRawNotes);
  let history = loadConversation(dir);
  if (history.length) {
    console.error(`Resuming a conversation with ${history.length / 2} prior exchange(s) in ${dir}\n`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.error("Ask questions about the report. Type 'exit' or Ctrl+C to quit.\n");
  try {
    while (true) {
      const question = (await rl.question("> ")).trim();
      if (!question || question === "exit" || question === "quit") break;
      const answer = await askOnce(runner, usage, dir, staticContext, history, question);
      console.log(`\n${answer}\n`);
      history = loadConversation(dir); // re-read what askOnce just persisted
    }
  } finally {
    rl.close();
  }
  console.error("--- Usage ---");
  console.error(usage.report());
}
