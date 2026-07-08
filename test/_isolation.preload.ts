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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEVLOG_DATA_DIR = mkdtempSync(join(tmpdir(), "devlog-test-data-"));
