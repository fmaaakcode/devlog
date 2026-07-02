import type { PlanStep } from "./types";

// Parser for Claude Code's *Exit Plan Mode* output saved at
// `~/.claude/plans/*.md`. These plans use a different convention than
// `-(doc:plan)` — they're written by the Claude harness with `### N.`
// numbered headings, no GFM checkboxes. Ingested by the Stop hook
// (parse-tags.js → /api/plan).
//
// For trackable user-defined plans emitted as `-(doc:plan)`, see
// `extractCheckboxes()` in `doc-store.ts` (GFM `- [ ]` style). The two
// formats co-exist intentionally because they come from different
// sources — don't merge them into one parser.
export function parsePlanMarkdown(content: string): { title: string; steps: PlanStep[] } {
  const lines = content.split("\n");
  let title = "";
  const steps: PlanStep[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!title && /^#{1,2}\s+/.test(trimmed)) {
      title = trimmed.replace(/^#{1,2}\s+/, "");
      continue;
    }
    if (/^###\s+\d/.test(trimmed)) {
      const text = trimmed.replace(/^###\s+/, "").replace(/^\d+\.\s*/, "");
      const completed = /✅|☑|~~/.test(trimmed);
      steps.push({ text, completed });
    }
  }

  return { title: title || "خطة بدون عنوان", steps };
}
