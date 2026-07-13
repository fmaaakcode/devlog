// Unit tests for the turn ledger (src/turn-ledger.ts) — the single state file
// behind the Stop hook's idempotency (plan processturn-week P2). Covers the
// scope-policy contract: turn section resets on a turnId change, session
// section persists, corrupt state fails open, and the TTL sweep only removes
// stale session files.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyLedger, entryKey, loadLedger, saveLedger, sweepTurnState } from "../src/turn-ledger";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "turn-ledger-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadLedger", () => {
  test("fresh session → empty ledger keyed to the current turn", async () => {
    const { ledger } = await loadLedger(dir, "s1", "T1");
    expect(ledger).toEqual(emptyLedger("T1"));
  });

  test("same turnId → turn section round-trips (postedKeys + servedCommands)", async () => {
    const { file, ledger } = await loadLedger(dir, "s1", "T1");
    ledger.turn.postedKeys.push(entryKey("todo", "task A"));
    ledger.turn.servedCommands.push("ask:open");
    ledger.session.hintedVerify = true;
    ledger.session.servedSignatures.push("dep-fresh|x@1.0");
    await saveLedger(file, ledger);

    const { ledger: again } = await loadLedger(dir, "s1", "T1");
    expect(again).toEqual(ledger);
  });

  test("new turnId → turn section resets, session section persists", async () => {
    const { file, ledger } = await loadLedger(dir, "s1", "T1");
    ledger.turn.postedKeys.push(entryKey("todo", "task A"));
    ledger.turn.servedCommands.push("ask:open");
    ledger.session.hintedVerify = true;
    ledger.session.servedSignatures.push("sig-1");
    await saveLedger(file, ledger);

    const { ledger: next } = await loadLedger(dir, "s1", "T2");
    expect(next.turn).toEqual({ turnId: "T2", postedKeys: [], servedCommands: [] });
    expect(next.session).toEqual({ hintedVerify: true, servedSignatures: ["sig-1"], envDriftChecked: false });
  });

  test("corrupt state file fails open to a fresh ledger", async () => {
    const { file } = await loadLedger(dir, "s1", "T1");
    await Bun.write(file, "{not json");
    const { ledger } = await loadLedger(dir, "s1", "T1");
    expect(ledger).toEqual(emptyLedger("T1"));
  });

  test("non-string junk inside persisted arrays is dropped", async () => {
    const { file } = await loadLedger(dir, "s1", "T1");
    await Bun.write(file, JSON.stringify({
      session: { hintedVerify: "yes", servedSignatures: ["ok", 7, null] },
      turn: { turnId: "T1", postedKeys: [42, "k1"], servedCommands: [{}, "ask:open"] },
    }));
    const { ledger } = await loadLedger(dir, "s1", "T1");
    expect(ledger.session.hintedVerify).toBe(false);      // strict boolean only
    expect(ledger.session.servedSignatures).toEqual(["ok"]);
    expect(ledger.turn.postedKeys).toEqual(["k1"]);
    expect(ledger.turn.servedCommands).toEqual(["ask:open"]);
  });

  test("session ids with unsafe characters map to a sanitized filename", async () => {
    const { file, ledger } = await loadLedger(dir, "a/b\\c:d", "T1");
    ledger.turn.servedCommands.push("audit");
    await saveLedger(file, ledger);
    const { ledger: again } = await loadLedger(dir, "a/b\\c:d", "T1");
    expect(again.turn.servedCommands).toEqual(["audit"]);
  });

  test("empty session id falls back to a shared 'nosession' file", async () => {
    const { file } = await loadLedger(dir, "", "T1");
    expect(file.endsWith("nosession.json")).toBe(true);
  });
});

describe("entryKey", () => {
  test("distinct per tag, content, and breaking flag; stable for equal input", () => {
    const k = entryKey("todo", "task A");
    expect(entryKey("todo", "task A")).toBe(k);
    expect(entryKey("note", "task A")).not.toBe(k);
    expect(entryKey("todo", "task B")).not.toBe(k);
    expect(entryKey("todo", "task A", true)).not.toBe(k);
  });
});

describe("sweepTurnState", () => {
  test("removes files older than the TTL, keeps fresh ones, ignores non-json", async () => {
    const oldFile = join(dir, "old.json");
    const newFile = join(dir, "new.json");
    const stray = join(dir, "notes.txt");
    await Bun.write(oldFile, "{}");
    await Bun.write(newFile, "{}");
    await Bun.write(stray, "keep me");
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(oldFile, past, past);

    await sweepTurnState(dir, 7 * 24 * 60 * 60 * 1000);

    expect(await Bun.file(oldFile).exists()).toBe(false);
    expect(await Bun.file(newFile).exists()).toBe(true);
    expect(await Bun.file(stray).exists()).toBe(true);
  });

  test("missing directory is a silent no-op", async () => {
    await sweepTurnState(join(dir, "does-not-exist"));
  });
});
