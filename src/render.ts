import type { ResearchReport, CompareReport, GlossaryEntry } from "./types.js";

function renderGlossary(glossary: GlossaryEntry[]): string[] {
  if (!glossary?.length) return [];
  const lines = ["", "## Terms used above, in plain language", ""];
  for (const g of glossary) lines.push(`- **${g.term}** — ${g.plain_explanation}`);
  return lines;
}

function renderSources(sources: string[]): string[] {
  if (!sources?.length) return [];
  return ["", "## Sources", "", ...sources.map((s) => `- ${s}`)];
}

function renderActionItems(items: string[]): string[] {
  if (!items?.length) return [];
  return ["", "## Action Items", "", ...items.map((a) => `- [ ] ${a}`)];
}

export function renderResearchMarkdown(report: ResearchReport): string {
  const lines: string[] = [`# ${report.topic}`, ""];
  if (report.context) lines.push(`_Context: ${report.context}_`, "");
  lines.push(report.explainer);
  lines.push(...renderGlossary(report.glossary));
  lines.push("", "## Recommendation", "", report.recommendation);
  lines.push(...renderActionItems(report.action_items));
  lines.push(...renderSources(report.sources));
  return lines.join("\n");
}

export function renderCompareMarkdown(report: CompareReport): string {
  const lines: string[] = [`# ${report.decision}`, ""];
  if (report.context) lines.push(`_Context: ${report.context}_`, "");
  lines.push("## Options", "");
  for (const o of report.options) {
    lines.push(`### ${o.name}`, "");
    if (o.pros.length) lines.push("**Pros**", ...o.pros.map((p) => `- ${p}`), "");
    if (o.cons.length) lines.push("**Cons**", ...o.cons.map((c) => `- ${c}`), "");
  }
  lines.push("## Recommendation", "", `**${report.recommendation}**`, "", report.rationale);
  lines.push(...renderGlossary(report.glossary));
  lines.push(...renderActionItems(report.action_items));
  lines.push(...renderSources(report.sources));
  return lines.join("\n");
}