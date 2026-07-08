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
  session: { hintedVerify: boolean; servedSignatures: string[] };
  turn: { turnId: string; postedKeys: string[]; servedCommands: string[] };
}

export function emptyLedger(turnId = ""): TurnLedger {
  return {
    session: { hintedVerify: false, servedSignatures: [] },
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
      ledger.session.servedSignatures = onlyStrings(raw.session.servedSignatures);
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

/** Opportunistic TTL sweep of stale session files. Best-effort: any error is
 *  swallowed — a leftover state file is harmless, a crashed hook is not. */
export async function sweepTurnState(dir: string, maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  try {
    const now = Date.now();
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const fp = join(dir, name);
      try {
        if (now - (await stat(fp)).mtimeMs > maxAgeMs) await rm(fp, { force: true });
      } catch { /* raced or unreadable — leave it for the next sweep */ }
    }
  } catch { /* dir missing — nothing to sweep */ }
}
