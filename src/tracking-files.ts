// Tracking-file signatures (#676 + the PreToolUse tracking gate). The
// Superpowers coexistence incident's exact shape: a competing CLAUDE.md makes
// the model write manual tracking files (tasks.md / decisions.md / plans/*.md)
// INSTEAD of tags — and every one of them is markdown, which isCodeWrite
// deliberately excludes, so the untagged-session guard never fired on the very
// signature it was built for. The fix is NOT widening isCodeWrite to all .md
// (that would bark at innocent doc sessions); it is this NARROW name list:
// files whose job duplicates a DevLog tag. Shared by both enforcement layers:
//   · Stop:      parse-tags.ts counts these alongside code files for the
//                untagged-session guard (untagged-guard.ts)
//   · PreToolUse: pre-standards.js blocks the write once (advisory,
//                install-gate pattern — the re-issued write passes)
// Pure and import-free so the PreToolUse hook's load stays feather-light.

// Basenames whose content maps 1:1 onto a tag: -(todo), -(decision),
// -(release) changelog, -(doc:plan). Singular/plural variants included;
// anything beyond this list is ordinary documentation and stays untouched.
const TRACKING_BASENAMES = new Set([
  "todo.md", "todos.md",
  "task.md", "tasks.md",
  "decision.md", "decisions.md",
  "changelog.md",
  "memory.md",
]);

// Directory segments whose .md children are plan documents (-(doc:plan)).
const TRACKING_DIRS = new Set(["plans"]);

// Never fire inside harness/tool-internal trees: `.claude` holds Claude Code's
// own auto-memory (MEMORY.md!), `.devlog` is ours, node_modules is vendored.
const EXEMPT_SEGMENTS = new Set([".devlog", ".claude", "node_modules"]);

/** Is this write a manual tracking file that duplicates a DevLog tag? */
export function isTrackingFile(filePath: string): boolean {
  const parts = (filePath || "").replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
  if (!parts.length) return false;
  const base = parts[parts.length - 1];
  if (!base.endsWith(".md")) return false;
  if (parts.some(seg => EXEMPT_SEGMENTS.has(seg))) return false;
  if (TRACKING_BASENAMES.has(base)) return true;
  return parts.slice(0, -1).some(seg => TRACKING_DIRS.has(seg));
}

/** Which tag replaces this file — drives the gate message's teaching line. */
export function trackingTagFor(filePath: string): string {
  const base = (filePath || "").replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean).pop() || "";
  if (base.startsWith("todo") || base.startsWith("task")) return "-(todo)";
  if (base.startsWith("decision")) return "-(decision)";
  if (base === "changelog.md") return "-(release)";
  if (base === "memory.md") return "-(note)/-(decision)";
  return "-(doc:plan)";
}
