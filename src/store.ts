import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ResearchNote, ConversationTurn } from "./types.js";

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

const REPORTS_DIR = "reports";

export function runDir(label: string): string {
  const dir = join(REPORTS_DIR, `${slugify(label)}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveNotes(dir: string, notes: ResearchNote[]) {
  writeFileSync(join(dir, "notes.json"), JSON.stringify(notes, null, 2));
}

export function loadNotes(path: string): ResearchNote[] {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveJson(dir: string, filename: string, data: unknown) {
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2));
}

export function saveText(dir: string, filename: string, text: string) {
  writeFileSync(join(dir, filename), text);
}

// --- Follow-up conversation persistence -----------------------------------
// Lets `--mode ask` resume where it left off across separate process runs,
// not just within one REPL session.
const CONVERSATION_FILE = "conversation.json";
const PRO_SESSION_FILE = "pro-session.json";

export function loadConversation(dir: string): ConversationTurn[] {
  const path = join(dir, CONVERSATION_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : [];
}

export function saveConversation(dir: string, turns: ConversationTurn[]) {
  writeFileSync(join(dir, CONVERSATION_FILE), JSON.stringify(turns, null, 2));
}

export function loadProSessionId(dir: string): string | undefined {
  const path = join(dir, PRO_SESSION_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")).sessionId : undefined;
}

export function saveProSessionId(dir: string, sessionId: string) {
  writeFileSync(join(dir, PRO_SESSION_FILE), JSON.stringify({ sessionId }, null, 2));
}
