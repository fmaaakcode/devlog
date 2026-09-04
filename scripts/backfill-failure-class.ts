// Failure-class backfill driver (#998) — the shell side of a reviewed batch.
//
//   bun scripts/backfill-failure-class.ts list  [--project NAME|--cwd DIR] [--limit 30] [--offset 0]
//   bun scripts/backfill-failure-class.ts apply <assignments.json> [--confirm]
//
// `list` prints the unclassified closed reports with their material (report
// text, the prose around the report and the fix, the closer's own cause, the
// fix's files) — what Claude classifies in-context and shows the user.
// `apply` sends a batch; WITHOUT --confirm it is a preview (nothing written).
// With it, the server archives every touched row first and stamps the class
// as backfilled. The assignments file is `[{ "closerId": "…", "class": "…" }]`
// or `{ "assignments": [...] }`; the class word may be any vocabulary alias
// (Arabic or English).
//
// Why a script and not curl: git-bash folds backslashes in curl.exe arguments
// on Windows, and a JSON body with Arabic words in it is exactly the payload
// that breaks. A Bun fetch has no such seam.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.DEVLOG_PORT) || 7777;
const BASE = `http://127.0.0.1:${PORT}`;

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

async function list(): Promise<void> {
  const q = new URLSearchParams();
  const project = flag("project");
  const cwd = flag("cwd") ?? (project ? undefined : process.cwd());
  if (project) q.set("project", project);
  if (cwd) q.set("cwd", resolve(cwd));
  q.set("limit", flag("limit") ?? "30");
  q.set("offset", flag("offset") ?? "0");
  const r = await fetch(`${BASE}/api/failure-class-backfill?${q}`, { signal: AbortSignal.timeout(15000) });
  const d = await r.json() as {
    project: string | null; total: number; classified: number; byCloser: number; backfilled: number; more: number;
    candidates: Array<{ num?: number; closerId: string; kind: string; text: string; closedAt?: string; context?: string; closerContext?: string; cause?: string; closerFiles?: string[] }>;
  };
  if (!d.project) { console.error("project not found — pass --project NAME or --cwd DIR of a registered project"); process.exit(2); }
  console.log(`${d.project}: ${d.total} closed reports, ${d.classified} classified (${d.byCloser} by the closer, ${d.backfilled} backfilled), ${d.candidates.length} served, ${d.more} more`);
  for (const c of d.candidates) {
    console.log(`\n#${c.num ?? "?"} [${c.kind}] ${(c.closedAt || "").slice(0, 10)}  closerId=${c.closerId}`);
    console.log(`  report: ${c.text}`);
    if (c.cause) console.log(`  cause:  ${c.cause}`);
    if (c.context) console.log(`  around report: ${c.context.replace(/\s+/g, " ").slice(0, 400)}`);
    if (c.closerContext) console.log(`  around fix:    ${c.closerContext.replace(/\s+/g, " ").slice(0, 400)}`);
    if (c.closerFiles?.length) console.log(`  fix files: ${c.closerFiles.join(" · ")}`);
  }
}

async function apply(file: string): Promise<void> {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const assignments = Array.isArray(raw) ? raw : raw?.assignments;
  if (!Array.isArray(assignments) || !assignments.length) { console.error("assignments file: [{closerId, class}] or {assignments:[…]}"); process.exit(2); }
  const confirm = has("confirm");
  const r = await fetch(`${BASE}/api/failure-class-backfill`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignments, confirm }), signal: AbortSignal.timeout(30000),
  });
  const d = await r.json() as { applied?: boolean; changed?: number; error?: string; rows?: Array<{ num?: number; from: string; to: string }>; refused?: Array<{ closerId: string; reason: string }> };
  if (d.refused?.length) {
    console.error(`REFUSED (${r.status}) — nothing written:`);
    for (const x of d.refused) console.error(`  ${x.closerId}: ${x.reason}`);
    process.exit(1);
  }
  if (d.error) { console.error(`${r.status}: ${d.error}`); process.exit(1); }
  for (const row of d.rows ?? []) console.log(`  #${row.num ?? "?"}: ${row.from} → ${row.to}`);
  console.log(d.applied ? `applied: ${d.changed} row(s) written (originals archived to the undone stream)` : `preview only — re-run with --confirm to write ${d.rows?.length ?? 0} row(s)`);
}

if (cmd === "list") await list();
else if (cmd === "apply" && args[1]) await apply(args[1]);
else { console.error("usage: list [--project NAME|--cwd DIR] [--limit N] [--offset N] | apply <file.json> [--confirm]"); process.exit(2); }
