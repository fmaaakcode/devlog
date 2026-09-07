// Unit proof for the telemetry capture half (#787): client-record sanitization
// (hooks are never trusted blindly), server-side ts stamping, the append/load
// JSONL roundtrip, and torn-line tolerance (append-only files survive crashes
// mid-line — the reader must too). DATA_DIR is the test-isolated temp dir from
// the preload, so appends here never touch live data.

import { describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { sanitizeRuleRecord, appendRuleTelemetry, loadRuleTelemetry } from "../src/rule-telemetry";
import { DATA_DIR } from "../src/data";

describe("sanitizeRuleRecord", () => {
  test("valid minimal record normalizes; ts/project are stripped (server-owned)", () => {
    const r = sanitizeRuleRecord({ gate: "write", action: "fire", rule: "toolchain", ts: "2020-01-01", project: "spoofed" });
    expect(r).toEqual({ gate: "write", action: "fire", rule: "toolchain" });
  });

  test("unknown gate or action → rejected", () => {
    expect(sanitizeRuleRecord({ gate: "nope", action: "fire", rule: "x" })).toBeNull();
    expect(sanitizeRuleRecord({ gate: "write", action: "explode", rule: "x" })).toBeNull();
    expect(sanitizeRuleRecord(null)).toBeNull();
    expect(sanitizeRuleRecord("fire")).toBeNull();
  });

  test("empty or non-string rule → rejected; long fields are capped", () => {
    expect(sanitizeRuleRecord({ gate: "write", action: "fire", rule: "  " })).toBeNull();
    expect(sanitizeRuleRecord({ gate: "write", action: "fire", rule: 42 })).toBeNull();
    const r = sanitizeRuleRecord({
      gate: "install", action: "pass", rule: "r".repeat(999),
      file: "f".repeat(999), detail: "d".repeat(999),
    });
    expect(r?.rule.length).toBe(200);
    expect(r?.file?.length).toBe(500);
    expect(r?.detail?.length).toBe(300);
  });
});

describe("appendRuleTelemetry / loadRuleTelemetry", () => {
  test("roundtrip: records come back oldest-first with a stamped ISO ts", async () => {
    await appendRuleTelemetry([
      { gate: "write", action: "fire", rule: "toolchain", file: "Cargo.toml", project: "p1" },
      { gate: "lifecycle", action: "adopt", rule: "rust", detail: "rule text" },
    ]);
    const all = await loadRuleTelemetry();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const mine = all.filter(r => r.rule === "toolchain" || r.rule === "rust");
    expect(mine[0]).toMatchObject({ gate: "write", action: "fire", rule: "toolchain", file: "Cargo.toml", project: "p1" });
    expect(+new Date(mine[0].ts)).toBeGreaterThan(0);
  });

  test("torn/corrupt lines are skipped, valid neighbors survive", async () => {
    await appendFile(`${DATA_DIR}/rule-telemetry.jsonl`, '{"half":\n{"ts":"x","gate":"bad","action":"fire","rule":"r"}\n', "utf-8");
    await appendRuleTelemetry([{ gate: "install", action: "pass", rule: "npm:ok" }]);
    const all = await loadRuleTelemetry();
    expect(all.some(r => r.rule === "npm:ok")).toBe(true);
    expect(all.every(r => r.gate !== ("bad" as never))).toBe(true);
  });

  test("cap keeps only the newest N counters", async () => {
    await appendRuleTelemetry([
      { gate: "install", action: "pass", rule: "npm:first" },
      { gate: "install", action: "pass", rule: "npm:last" },
    ]);
    // The cap is spent on lifecycle records first (#1134); one slot beyond them
    // is exactly one counter — the newest.
    const isCounter = (r: { action: string }) => r.action === "pass" || r.action === "fire" || r.action === "ack";
    const lifecycleN = (await loadRuleTelemetry()).filter(r => !isCounter(r)).length;
    const capped = await loadRuleTelemetry(lifecycleN + 1);
    const counters = capped.filter(isCounter);
    expect(counters.length).toBe(1);
    expect(counters[0].rule).toBe("npm:last");
  });

  test("#1134: the cap never drops lifecycle records — the oldest adopt survives any number of newer counters", async () => {
    await appendRuleTelemetry([{ gate: "lifecycle", action: "adopt", rule: "rust", detail: "oldest adoption" }]);
    await appendRuleTelemetry(Array.from({ length: 5 }, (_, i) => ({ gate: "install" as const, action: "pass" as const, rule: `npm:c${i}` })));
    const capped = await loadRuleTelemetry(2);
    const adopts = capped.filter(r => r.action === "adopt" && r.detail === "oldest adoption");
    expect(adopts.length).toBe(1);
    // Oldest-first order is preserved after the merge.
    for (let i = 1; i < capped.length; i++) expect(capped[i - 1].ts <= capped[i].ts).toBe(true);
  });

  test("empty append is a no-op; missing file loads as empty (fresh install)", async () => {
    await appendRuleTelemetry([]);
    expect(Array.isArray(await loadRuleTelemetry())).toBe(true);
  });
});
