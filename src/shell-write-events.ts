// Shell writes as change rows — the read-time bridge between a COMMAND event
// and every surface that counts files by `type === "change"`.
//
// A heredoc, `sed -i`, `>` or an inline-script write API is stored as a command
// event with no file_path (the stored event stays what the harness sent — the
// #1055 decision), so ask:recent, the session summary, sessionTouchedFiles and
// the file story all answered "0 files" for a session that wrote everything
// through Bash — exactly the sessions that run under a bypass-permissions
// harness, which steers edits to sed/heredoc. /api/changes/session already
// derived shell writes at read time for the guards; this module gives the
// remaining consumers ONE derivation instead of a fourth private copy.
//
// A synthetic row is change-shaped (type "change", tool SHELL_WRITE_TOOL, zero
// line counts, no content) and carries a derived id (`<command id>#w<n>`) so
// id-keyed dedup (hot ∩ archive) still holds. Relative targets resolve against
// `baseDir` when given (the project root), so `src/x.ts` typed at the prompt
// and `D:/proj/src/x.ts` from an Edit key the same file. Opaque writes (`> $OUT`)
// yield nothing — a row needs a path.

import { shellWriteTargets } from "./shell-write";
import { normalizeSlashes } from "./path-utils";
import type { EventEntry } from "./types";

/** `tool` on a synthetic shell-write change row. */
export const SHELL_WRITE_TOOL = "Shell";

const ABS_RE = /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/;

function resolveTarget(target: string, baseDir?: string): string {
  let t = normalizeSlashes(target).replace(/^(?:\.\/)+/, "");
  if (!t) return "";
  if (!ABS_RE.test(t) && baseDir) {
    const base = normalizeSlashes(baseDir).replace(/\/+$/, "");
    t = base ? `${base}/${t}` : t;
  }
  return t;
}

/**
 * The change rows a command event implies — empty for a read-only command, an
 * event of another type, or a write whose target could not be named.
 */
export function shellWriteEvents(e: EventEntry, baseDir?: string): EventEntry[] {
  if (e.type !== "command" || !e.command) return [];
  const seen = new Set<string>();
  const out: EventEntry[] = [];
  for (const target of shellWriteTargets(e.command).targets) {
    const file_path = resolveTarget(target, baseDir);
    if (!file_path) continue;
    const key = file_path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `${e.id}#w${out.length + 1}`,
      project: e.project,
      event: e.event,
      type: "change",
      tool: SHELL_WRITE_TOOL,
      file_path,
      session_id: e.session_id,
      timestamp: e.timestamp,
      lines_added: 0,
      lines_removed: 0,
      // Same single-line face /api/changes/session shows for a shell write.
      description: e.command.split("\n")[0].slice(0, 240),
    });
  }
  return out;
}

/**
 * `events` with each command's shell-write rows inserted right after it
 * (order preserved). Consumers that filter on change/create can iterate this
 * instead of `events` and see shell writes for free.
 */
export function withShellWrites(events: EventEntry[], baseDir?: string): EventEntry[] {
  const out: EventEntry[] = [];
  for (const e of events) {
    out.push(e);
    if (e.type === "command" && e.command) for (const w of shellWriteEvents(e, baseDir)) out.push(w);
  }
  return out;
}
