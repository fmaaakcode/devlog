// Rule-effectiveness telemetry (#787) — the capture half. Every gate DECISION
// (a write-checker firing, an install-gate block/pass/ack, a rule adopted or
// acked or a project exempted) lands here as one JSONL line, on the audit.ts
// pattern: append-only, best-effort, a logging failure never blocks the
// operation it records. The analysis half (rule-effect.ts) turns these lines
// into per-rule fire/ack/pass counts and adoption-vs-report-rate correlation
// for the retro/study corpora.
//
// Single writer by design: hooks never touch this file — they POST to
// /api/rule-telemetry and the SERVER appends (same reason the tags store has
// one writer). routes-inject.ts calls appendRuleTelemetry in-process for the
// exemption toggle; that is still the same process.
//
// Deliberately NOT captured: the write-gate "pass" (every clean Write/Edit).
// It would add an HTTP call to the hot editing path for a number the events
// store already implies (total code writes − fires). Install-gate passes ARE
// captured — that hook already paid for a server round-trip.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { DATA_DIR } from "./data";
import { softFail } from "./soft-fail";

export const RULE_GATES = ["write", "install", "lifecycle"] as const;
export type RuleGate = (typeof RULE_GATES)[number];

// fire = a gate blocked/warned · ack = a conscious override (rule:ack, or an
// install re-issue) · pass = install gate found the command clean · exempt =
// project-wide enforcement toggled (detail: "disabled"/"enabled") · adopt /
// remove = rule lifecycle (rule:add / rule:rm) — adoption dates feed the
// before/after report-rate analysis.
export const RULE_ACTIONS = ["fire", "ack", "pass", "exempt", "adopt", "remove"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export interface RuleTelemetryRecord {
  ts: string;
  gate: RuleGate;
  action: RuleAction;
  /** Checker key (`toolchain`), package (`npm:astro`), category (`rust`) or marker. */
  rule: string;
  project?: string;
  file?: string;
  detail?: string;
}

const TELEMETRY_FILE = `${DATA_DIR}/rule-telemetry.jsonl`;

const gateSet = new Set<string>(RULE_GATES);
const actionSet = new Set<string>(RULE_ACTIONS);
const capped = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** Validate one client-supplied record (never trust hook payloads blindly).
 *  Returns the normalized record WITHOUT ts — the server stamps time on
 *  append, so a hook can't backdate the trail. null = rejected. */
export function sanitizeRuleRecord(x: unknown): Omit<RuleTelemetryRecord, "ts" | "project"> | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const gate = typeof r.gate === "string" ? r.gate : "";
  const action = typeof r.action === "string" ? r.action : "";
  const rule = capped(r.rule, 200);
  if (!gateSet.has(gate) || !actionSet.has(action) || !rule) return null;
  const file = capped(r.file, 500);
  const detail = capped(r.detail, 300);
  return {
    gate: gate as RuleGate, action: action as RuleAction, rule,
    ...(file ? { file } : {}), ...(detail ? { detail } : {}),
  };
}

/** Append records (ts stamped here). Best-effort: a failed write degrades to a
 *  softFail diagnostic, never to a failed gate/request. */
export async function appendRuleTelemetry(
  records: Array<Omit<RuleTelemetryRecord, "ts">>,
): Promise<void> {
  if (!records.length) return;
  try {
    const ts = new Date().toISOString();
    const lines = records.map(r => `${JSON.stringify({ ts, ...r })}\n`).join("");
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(TELEMETRY_FILE, lines, "utf-8");
  } catch (e) {
    softFail("ruleTelemetry.append", e);
  }
}

/** All stored records, oldest first, capped to the newest `cap` lines. Corrupt
 *  lines are skipped (append-only files survive crashes mid-line). */
export async function loadRuleTelemetry(cap = 20_000): Promise<RuleTelemetryRecord[]> {
  let raw: string;
  try {
    raw = await readFile(TELEMETRY_FILE, "utf-8");
  } catch {
    return []; // no telemetry yet
  }
  const out: RuleTelemetryRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as RuleTelemetryRecord;
      if (typeof r.ts === "string" && gateSet.has(r.gate) && actionSet.has(r.action) && typeof r.rule === "string") out.push(r);
    } catch { /* torn line — skip */ }
  }
  return out.slice(-cap);
}
