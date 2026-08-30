import type { ResearchReport, CompareReport } from "./types.js";

export function renderResearchMarkdown(report: ResearchReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.topic}`, "");
  if (report.context) lines.push(`_Context: ${report.context}_`, "");
  lines.push(report.summary, "", "## Findings", "");
  for (const f of report.findings) {
    lines.push(`- **[${f.confidence}]** ${f.statement}`);
    if (f.sources.length) lines.push(`  - Sources: ${f.sources.join(", ")}`);
  }
  lines.push("", "## Recommendation", "", report.recommendation);
  if (report.action_items.length) {
    lines.push("", "## Action Items", "");
    for (const a of report.action_items) lines.push(`- [ ] ${a}`);
  }
  if (report.open_questions.length) {
    lines.push("", "## Open Questions", "");
    for (const q of report.open_questions) lines.push(`- ${q}`);
  }
  return lines.join("\n");
}

export function renderCompareMarkdown(report: CompareReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.decision}`, "");
  if (report.context) lines.push(`_Context: ${report.context}_`, "");
  lines.push("## Options", "");
  for (const o of report.options) {
    lines.push(`### ${o.name}`, "");
    if (o.pros.length) lines.push("**Pros**", ...o.pros.map((p) => `- ${p}`), "");
    if (o.cons.length) lines.push("**Cons**", ...o.cons.map((c) => `- ${c}`), "");
  }
  lines.push("## Recommendation", "", `**${report.recommendation}**`, "", report.rationale);
  if (report.action_items.length) {
    lines.push("", "## Action Items", "");
    for (const a of report.action_items) lines.push(`- [ ] ${a}`);
  }
  if (report.open_questions.length) {
    lines.push("", "## Open Questions", "");
    for (const q of report.open_questions) lines.push(`- ${q}`);
  }
  return lines.join("\n");
}
