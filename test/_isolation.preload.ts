// Test-process data isolation, loaded via bunfig.toml [test].preload BEFORE
// any test file or src module. src/data.ts captures DATA_DIR once at import
// time, and `bun test` runs every file in one process — so the first static
// import of data.ts anywhere freezes the dir for the whole run, and a
// per-test `process.env.DEVLOG_DATA_DIR = tmp` set before a dynamic import
// silently loses that race. With DEVLOG_DATA_DIR exported user-wide (the
// production daemon's dir), that race made e2e suites overwrite the LIVE
// projects.json/tags.json: the dashboard then "lost" every project on daemon
// restart. Rewriting the env here, before anything else loads, means whatever
// wins the import race can only ever see a throwaway directory.
//
// The throwaway directory lives under ONE per-run temp root (#1171 / #1181):
// TEMP/TMP/TMPDIR are pointed at `devlog-tests-<stamp>-<rand>` so every
// `tmpdir()` call in this process — and in the servers/hooks it spawns — lands
// there, and the roots of earlier runs older than an hour are swept first.
// `process.on("exit")` never fires under `bun test`, so cleanup-at-exit was a
// promise nothing kept; the sweep-on-next-run is the one that holds.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunRoot, sweepStaleRoots } from "./_tmp-root";

const systemTmp = tmpdir();
sweepStaleRoots(systemTmp);
const runRoot = createRunRoot(systemTmp);
process.env.TEMP = runRoot;
process.env.TMP = runRoot;
process.env.TMPDIR = runRoot;

process.env.DEVLOG_DATA_DIR = mkdtempSync(join(runRoot, "devlog-test-data-"));

// Language isolation (#1248 / #1249, after #907 and #976 — four times the same
// class): CI never sets DEVLOG_LANG, so the suite there runs in the English
// default, while a developer with DEVLOG_LANG=ar exported user-wide ran the
// very same files in Arabic — a test asserting one language's wording, or a
// ceiling measured in the shorter language, was green locally and red on CI.
// Dropping the key here makes the local run identical to CI by construction;
// a test that needs Arabic pins it explicitly (and restores it — see
// env-lang-leak-guard.test.ts). Discipline failed four times; this is the fence.
delete process.env.DEVLOG_LANG;

