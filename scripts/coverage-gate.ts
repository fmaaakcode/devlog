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
