#!/usr/bin/env bun
// Coverage ratchet (plan fable/round2 task 2.3). Parses an lcov report and fails
// if src/ line coverage regresses — overall, or for any "sensitive" module whose
// silent breakage is high-blast-radius (a vuln scan that stops finding CVEs, a
// release path that corrupts versions, an export that ships a wrong changelog).
//
// Zero deps (Node builtins only), per the project's no-runtime-deps policy.
// Reads coverage/lcov.info (or argv[2]); produce it with:
//   bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage
//
// FLOORS ratchet just UNDER current coverage — they guard against regression,
// they are not aspirational targets. When you raise a module's real coverage,
// raise its floor too (never lower a floor to make a red build green — fix the
// test gap instead). test/ files and the e2e-only server.ts are excluded: the
// server is exercised through subprocess HTTP tests, so its in-process line
// coverage reads ~0 and would be a meaningless gate.

import { readFileSync } from "node:fs";

const OVERALL_FLOOR = 80; // src-only aggregate (currently ~82.6%)

// basename → minimum line-coverage %. Keep sorted by risk.
const SENSITIVE: Record<string, number> = {
  "vuln-scan.ts": 90,     // auto-generates security tags; silent break = false "no vulns"
  "tags-service.ts": 85,  // release/version + closure resolution
  "export.ts": 75,        // user-facing changelog / status.md
  "data.ts": 65,          // atomic persistence + migrations
  // The closure vocabulary itself (CLOSER_FOR and the open-item resolvers).
  // Extracted OUT of data.ts, which carried a floor — so the protocol's core
  // arrived here guarded by nothing while the gate still watched the emptied
  // file. A silent break means items read as closed when they are open: the
  // release guard waves through unfinished work.
  "open-items.ts": 95,
  // The record's own auditor. It reports on the store and can TRIM entries in
  // it, so a silent break here either invents findings nobody can act on or
  // mis-trims real history. Both are worse than the pollution it cleans.
  "record-audit.ts": 95,
  // The two gates' decision halves. Each is a pure function whose whole value
  // is the branch that stays silent — fail-open on missing data, pass below
  // threshold. Untested, those branches rot into blocks nobody expects.
  "demolition-gate.ts": 95,
  "file-weight.ts": 95,
  // The Stop hook's block channel. Both halves are tested: the decision table
  // (which blocks count as enforcement and which are delivery) and the exit
  // path (exercised with process.exit/stdout stubbed). A silent break here
  // does not corrupt data, it makes the enforcement counters lie, which is worse
  // than having none: a dead guard would then read as a quiet one.
  "block-channel.ts": 95,
  // The claim-vs-trace verdict (#855) and the version-leap refusal (#857). Both
  // are pure deciders whose whole value is the branch that stays quiet —
  // "unverifiable" instead of an accusation, "refused once" instead of a silent
  // manifest rewrite. A silent break here makes the record lie in the direction
  // that is hardest to notice: it clears what it never checked.
  "claim-evidence.ts": 95,
  "release-leap.ts": 95,
};

const lcovPath = process.argv[2] || "coverage/lcov.info";
let raw: string;
try {
  raw = readFileSync(lcovPath, "utf8");
} catch {
  console.error(`[coverage-gate] cannot read ${lcovPath} — run: bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage`);
  process.exit(2);
}

// lcov records: SF:<file> … LF:<lines found> LH:<lines hit> … end_of_record.
// Paths use "\" on Windows and "/" elsewhere — normalize before matching.
type Rec = { file: string; lf: number; lh: number };
const records: Rec[] = [];
let cur: Partial<Rec> = {};
for (const line of raw.split(/\r?\n/)) {
  if (line.startsWith("SF:")) cur = { file: line.slice(3).replace(/\\/g, "/") };
  else if (line.startsWith("LF:")) cur.lf = Number(line.slice(3));
  else if (line.startsWith("LH:")) cur.lh = Number(line.slice(3));
  else if (line === "end_of_record" && cur.file) {
    records.push({ file: cur.file, lf: cur.lf || 0, lh: cur.lh || 0 });
    cur = {};
  }
}

const srcRecords = records.filter(r => /(^|\/)src\//.test(r.file));
const pct = (lh: number, lf: number) => (lf === 0 ? 100 : (lh / lf) * 100);

const failures: string[] = [];

// 1) Overall src/ floor.
const totLf = srcRecords.reduce((a, r) => a + r.lf, 0);
const totLh = srcRecords.reduce((a, r) => a + r.lh, 0);
const overall = pct(totLh, totLf);
const overallOk = overall >= OVERALL_FLOOR;
if (!overallOk) failures.push(`overall src/ ${overall.toFixed(2)}% < ${OVERALL_FLOOR}%`);

// 2) Per-file sensitive floors.
const rows: string[] = [];
rows.push(`${overallOk ? "PASS" : "FAIL"}  overall src/            ${overall.toFixed(2).padStart(6)}%  (floor ${OVERALL_FLOOR}%)`);
for (const [base, floor] of Object.entries(SENSITIVE)) {
  const rec = srcRecords.find(r => r.file.endsWith(`/${base}`) || r.file.endsWith(base));
  if (!rec) {
    failures.push(`sensitive file ${base} missing from coverage report`);
    rows.push(`FAIL  ${base.padEnd(22)} (not found in report)`);
    continue;
  }
  const p = pct(rec.lh, rec.lf);
  const ok = p >= floor;
  if (!ok) failures.push(`${base} ${p.toFixed(2)}% < ${floor}%`);
  rows.push(`${ok ? "PASS" : "FAIL"}  ${base.padEnd(22)} ${p.toFixed(2).padStart(6)}%  (floor ${floor}%)`);
}

console.log("── coverage gate ─────────────────────────────");
for (const r of rows) console.log(r);
console.log("──────────────────────────────────────────────");

if (failures.length) {
  console.error(`\n[coverage-gate] FAILED — coverage regressed:`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error(`\nFix the test gap; do not lower a floor to make this green.`);
  process.exit(1);
}
console.log("[coverage-gate] OK — all floors met.");
