// The turn ledger — the SINGLE state file behind the Stop hook's idempotency
// (plan processturn-week P2; design doc: .devlog/docs/processturn-design). It
// replaces the three per-mechanism state dirs that accumulated as continuation
// guards (ask-state / verify-state / rules-state): one file per session, one
// schema, zero guard-to-guard interplay.
//
// Scope policies (the adopted P1 table — this schema IS the table):
//
//   scope        | field                    | what it dedups
//   -------------|--------------------------|--------------------------------------
//   per turn     | turn.postedKeys          | tag entries POSTed to /api/tags
//   per turn     | turn.servedCommands      | pull commands (ask:open / ask:closed /
//                |                          | audit / rules:<cat>) — recorded AFTER
//                |                          | a successful serve only (#412)
//   per session  | session.hintedVerify     | the verify nudge (#232)
//   per session  | session.hintedRegression | fix-without-regression-test nudge (#683)
//   per session  | session.hintedSweep      | pattern-sweep nudge (#682)
//   per session  | session.servedSignatures | dep-freshness violation signatures
//   forever      | (server store)           | closures — never held here
//   recomputed   | (none)                   | closure-check / release guard: live
//                |                          | state; deduping them would be a bug
//
// The turn section resets whenever the turnId changes (a new genuine user
// message opened a new turn); the session section lives as long as the file.

import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface TurnLedger {
  session: { hintedVerify: boolean; hintedRegression: boolean; hintedSweep: boolean; hintedUntagged: boolean; hintedDemolitionWhy: boolean; servedSignatures: string[]; envDriftChecked: boolean };
  turn: { turnId: string; postedKeys: string[]; servedCommands: string[] };
}

export function emptyLedger(turnId = ""): TurnLedger {
  return {
    session: { hintedVerify: false, hintedRegression: false, hintedSweep: false, hintedUntagged: false, hintedDemolitionWhy: false, servedSignatures: [], envDriftChecked: false },
    turn: { turnId, postedKeys: [], servedCommands: [] },
  };
}

/** Stable identity of one parsed tag entry within a turn. Bun.hash (wyhash-64)
 *  is stable within a Bun version; the ledger only ever compares keys written
 *  moments earlier in the SAME turn, so cross-version stability is not needed. */
export function entryKey(tag: string, content: string, breaking?: boolean): string {
  return `${tag}${breaking ? "!" : ""}:${Bun.hash(content).toString(36)}`;
}

function onlyStrings(arr: unknown): string[] {
  return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
}

/** Load (or initialize) the session's ledger. Missing/corrupt file → fresh
 *  ledger (fail-open: at worst one suppression is lost and the server-side
 *  whole-history content dedup catches the echo). A turn section persisted for
 *  a DIFFERENT turnId is discarded; the session section always survives. */
export async function loadLedger(
  dir: string,
  sessionId: string,
  turnId: string,
): Promise<{ file: string; ledger: TurnLedger }> {
  const safeSid = (sessionId || "nosession").replace(/[^a-zA-Z0-9_-]/g, "_");
  const file = join(dir, `${safeSid}.json`);
  const ledger = emptyLedger(turnId);
  try {
    const raw = JSON.parse(await readFile(file, "utf-8")) as Partial<TurnLedger>;
    if (raw?.session && typeof raw.session === "object") {
      ledger.session.hintedVerify = raw.session.hintedVerify === true;
      ledger.session.hintedRegression = raw.session.hintedRegression === true;
      ledger.session.hintedSweep = raw.session.hintedSweep === true;
      ledger.session.hintedUntagged = raw.session.hintedUntagged === true;
      ledger.session.hintedDemolitionWhy = raw.session.hintedDemolitionWhy === true;
      ledger.session.servedSignatures = onlyStrings(raw.session.servedSignatures);
      ledger.session.envDriftChecked = raw.session.envDriftChecked === true;
    }
    if (raw?.turn && typeof raw.turn === "object" && turnId && raw.turn.turnId === turnId) {
      ledger.turn.postedKeys = onlyStrings(raw.turn.postedKeys);
      ledger.turn.servedCommands = onlyStrings(raw.turn.servedCommands);
    }
  } catch { /* missing or corrupt → fresh ledger (fail-open by design) */ }
  return { file, ledger };
}

/** Write-through persistence — called after every recorded effect. */
export async function saveLedger(file: string, ledger: TurnLedger): Promise<void> {
  await Bun.write(file, JSON.stringify(ledger));
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** TTL-delete stale files in one state dir; `ext` narrows what counts.
 *  Best-effort: any error is swallowed — a leftover state file is harmless, a
 *  crashed hook is not. */
async function sweepStaleFiles(dir: string, maxAgeMs: number, ext?: string): Promise<void> {
  try {
    const now = Date.now();
    for (const name of await readdir(dir)) {
      if (ext && !name.endsWith(ext)) continue;
      const fp = join(dir, name);
      try {
        if (now - (await stat(fp)).mtimeMs > maxAgeMs) await rm(fp, { force: true });
      } catch { /* raced or unreadable — leave it for the next sweep */ }
    }
  } catch { /* dir missing — nothing to sweep */ }
}

/** Opportunistic TTL sweep of stale session ledger files. */
export async function sweepTurnState(dir: string, maxAgeMs = WEEK_MS): Promise<void> {
  await sweepStaleFiles(dir, maxAgeMs, ".json");
}

/** The ack dirs the PreToolUse hooks write ("ack BEFORE block" — one tiny file
 *  per session × target). Nothing ever deleted them (audit 2026-08-13, ب‑2), so
 *  they grew forever. Their own semantics cap at one session (tracking-ack,
 *  demolition-ack) or 10 minutes (install-ack, release-ack — the audit named
 *  three; release-ack is the same shape and sweeps with them), so a 7-day TTL
 *  can never resurrect a block that should have stayed acked. */
export const ACK_DIRS = ["install-ack", "release-ack", "tracking-ack", "demolition-ack"] as const;

export async function sweepAckDirs(devlogDir: string, maxAgeMs = WEEK_MS): Promise<void> {
  await Promise.all(ACK_DIRS.map(d => sweepStaleFiles(join(devlogDir, d), maxAgeMs)));
}

/** The three per-mechanism dirs this ledger replaced. Nothing writes them since
 *  the ledger landed (and the last reader, the disabled teach/standards-check
 *  pair, was deleted in the 2026-08-13 audit) — but installs that lived through
 *  the migration still carry their files. Removed whole, best-effort, at hook
 *  startup; a failed removal just waits for the next run. */
export const LEGACY_STATE_DIRS = ["rules-state", "verify-state", "ask-state"] as const;

export async function sweepLegacyStateDirs(devlogDir: string): Promise<void> {
  for (const name of LEGACY_STATE_DIRS) {
    try { await rm(join(devlogDir, name), { recursive: true, force: true }); }
    catch { /* locked or raced — the next startup retries */ }
  }
}
