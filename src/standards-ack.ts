// Project-local enforcement markers, extracted from standards.ts (#787 ratchet).
// Two `.devlog/` marker files with one shared discovery walk:
//   `standards-off` — per-project exemption: the dashboard writes it, both
//     enforcement hooks read it LOCALLY (no server round-trip on the write
//     hot-path). Manual -(ask:rules) still works — only the FORCING is lifted.
//   `standards-ack` — intentional-acknowledgement (P5): a check that blocks a
//     DELIBERATE choice is friction; an ack records "on purpose" so the gate
//     stops blocking it. One key per line, two granularities in one mechanism:
//       `cargo-edition`        → the whole check is SOFT/off for this project
//       `cargo-edition:2021`   → only this specific value is acknowledged

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { currentLang } from "./i18n";

// i18n policy (#906): ack messages ride the same rule-command channel as
// standards.ts — English default, DEVLOG_LANG=ar for Arabic.
const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

export const ENFORCE_MARKER = "standards-off";

export function enforceMarkerPath(projectDir: string): string {
  return join(projectDir, ".devlog", ENFORCE_MARKER);
}

/** Nearest `.devlog` dir walking up from cwd (where the markers live). Walking
 *  up makes every reader work when Claude's cwd is a subfolder. */
export function findDevlogDir(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 40 && dir; i++) {
    try { if (existsSync(join(dir, ".devlog"))) return join(dir, ".devlog"); } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Whether enforcement is disabled for the project owning `cwd` (marker
 *  present). Errors → not disabled (enforce). */
export function isEnforcementDisabled(cwd: string): boolean {
  const dl = findDevlogDir(cwd);
  if (!dl) return false;
  try { return existsSync(join(dl, ENFORCE_MARKER)); } catch { return false; }
}

export const ACK_MARKER = "standards-ack";

/** Acknowledged check keys for the project at `cwd` (empty when none). Sync so
 *  the PreToolUse hook can call it inline on the write hot-path. */
export function readAcks(cwd: string): string[] {
  const dl = findDevlogDir(cwd);
  if (!dl) return [];
  try {
    return readFileSync(join(dl, ACK_MARKER), "utf-8").split("\n").map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

/** Is this check (optionally this specific value) acknowledged as intentional?
 *  A bare `checkKey` ack silences the whole check; `checkKey:value` silences one. */
export function isAcked(cwd: string, checkKey: string, value?: string | null): boolean {
  const acks = new Set(readAcks(cwd).map(a => a.toLowerCase()));
  if (acks.has(checkKey.toLowerCase())) return true;
  if (value != null && acks.has(`${checkKey}:${value}`.toLowerCase())) return true;
  return false;
}

export interface AckResult { ok: boolean; message: string; }

/** Record an intentional-violation ack for the project at `cwd` (append-only,
 *  dedup). Creates `.devlog` at cwd when no project root is found yet. */
export async function addAck(cwd: string, key: string): Promise<AckResult> {
  const k = (key || "").trim();
  if (!k) return { ok: false, message: L("empty ack key.", "مفتاح ack فارغ.") };
  const dl = findDevlogDir(cwd) ?? join(cwd, ".devlog");
  await mkdir(dl, { recursive: true });
  const file = join(dl, ACK_MARKER);
  let lines: string[] = [];
  try { lines = (await readFile(file, "utf-8")).split("\n").map(s => s.trim()).filter(Boolean); } catch { /* new file */ }
  if (lines.some(l => l.toLowerCase() === k.toLowerCase())) return { ok: true, message: L(`already present: ${k}`, `موجود مسبقاً: ${k}`) };
  lines.push(k);
  await writeFile(file, `${lines.join("\n")}\n`, "utf-8");
  return { ok: true, message: L(
    `acknowledged as intentional (no longer blocked in this project): ${k}`,
    `أُكّد كمتعمّد (لن يُحجب بعد الآن في هذا المشروع): ${k}`) };
}

/** Human-readable list of the project's acks (for -(rule:acks)). */
export function listAcks(cwd: string): string {
  const acks = readAcks(cwd);
  return acks.length
    ? `${L("this project's acks", "مؤكَّدات هذا المشروع")}:\n${acks.map(a => `· ${a}`).join("\n")}`
    : L("no acks in this project.", "لا مؤكَّدات في هذا المشروع.");
}
