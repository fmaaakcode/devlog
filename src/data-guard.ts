// ── Test-context data guard (#736) ──────────────────────────────────────────
// The bunfig [test].preload rewrites DEVLOG_DATA_DIR to a throwaway temp dir —
// but bunfig.toml is only read from the cwd `bun test` runs in. A run from a
// subdirectory (live incident 2026-07-30: `bun test` from test/) loads NO
// preload, inherits the user-wide LIVE dir, and the alphabetically-first
// suites overwrite production tags.json before the data-dir-isolation guard
// TEST ever runs — detection there is inherently too late. data.ts calls this
// at module load — the module that owns every write path — so no test process
// can ever hold a non-temporary DATA_DIR. `bun test` sets NODE_ENV=test; a
// daemon/hook run never does, so production is untouched. Pure for unit tests.
import { normalizeSlashes } from "./path-utils";

export function assertTestDataDirIsolated(nodeEnv: string | undefined, dataDir: string, tmp: string): void {
  if (nodeEnv !== "test") return;
  const norm = (p: string) => normalizeSlashes(p).toLowerCase().replace(/\/+$/, "");
  if (!norm(dataDir).startsWith(norm(tmp))) {
    throw new Error(
      `[devlog] refusing to run tests against a non-temporary data dir: ${dataDir}\n` +
      `The [test].preload did not run — bun test was probably started outside the repo root ` +
      `(bunfig.toml is only read from the cwd). Run it from the repo root.`,
    );
  }
}
