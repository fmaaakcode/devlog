// E2E for the release-echo the feature nudge could mint: a SECOND version from a
// turn that emitted exactly one `-(release)` line.
//
// The #1006 contract is that every block site refusing an in-flight release must
// CONSUME the refused line (record its key in the turn ledger), because the
// continuation re-reads the whole turn text and the site's own instruction is
// "re-emit -(release)". The release GUARD consumed it; the feature and story
// nudges did not. So the re-emit produced two release lines in one batch,
// keepLastRelease dropped the earlier one — and a dropped entry was never
// recorded as consumed either, so the NEXT invocation (a plain follow-up with no
// tags at all) re-read it as fresh and shipped it as another version.
//
// Live shape: v3.52.0 shipped, then a tagless verification response minted
// v3.52.1 from the same single release line.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asJson, startServer, stopServer, waitForServer, runHook as runHookRaw, HOOK_STATE_DIR } from "./_helpers";

const TEST_PORT = 17831;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const TURN_STATE_DIR = join(HOOK_STATE_DIR, "turn-state");
const RELEASE_LINE = "-(release) ترقية أداة التطوير بعد قياس أثرها على الشجرة";

function writeTranscript(dir: string, userUuid: string, assistantTexts: string[]): string {
  const lines: unknown[] = [
    { type: "user", uuid: userUuid, message: { role: "user", content: "ship it" } },
    ...assistantTexts.map((text, i) => ({
      type: "assistant", uuid: `a-${userUuid}-${i}`,
      message: { role: "assistant", content: [{ type: "text", text }] },
    })),
  ];
  const p = join(dir, `transcript-${userUuid}.jsonl`);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join("\n"));
  return p;
}

describe("release echo through the feature nudge (E2E)", () => {
  let dataDir: string, projDir: string, sid: string;
  let server: Subprocess;

  const runHook = (tx: string, stopHookActive: boolean) =>
    runHookRaw(TEST_PORT, { cwd: projDir, session_id: sid, transcript_path: tx, stop_hook_active: stopHookActive });

  const releaseKeys = (): string[] => {
    const ledger = JSON.parse(readFileSync(join(TURN_STATE_DIR, `${sid}.json`), "utf-8"));
    return (ledger.turn.postedKeys as string[]).filter(k => k.startsWith("release:"));
  };
  const releases = async (): Promise<any[]> => {
    const data: any = await asJson(await fetch(`${BASE}/api/data`));
    return data.tags.filter((t: any) => t.tag === "release");
  };

  beforeEach(async () => {
    sid = `rel-echo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dataDir = mkdtempSync(join(tmpdir(), "rel-echo-data-"));
    projDir = mkdtempSync(join(tmpdir(), "rel-echo-proj-"));
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
    await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=${sid}&type=SessionStart`,
      { signal: AbortSignal.timeout(4000) });
    // Work since the last release with zero features declared — the exact
    // precondition that arms the feature nudge.
    await fetch(`${BASE}/api/tags`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: projDir, session_id: sid, entries: [{ tag: "update", content: "bump the linter to 2.5.11" }] }),
    });
  });
  afterEach(async () => {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
    rmSync(join(TURN_STATE_DIR, `${sid}.json`), { force: true });
  });

  test("a tagless follow-up after the nudge re-emit does NOT mint a second release", async () => {
    // 1) The release is emitted; the feature nudge refuses it once.
    const t1 = writeTranscript(projDir, "U1", [`shipping now\n\n${RELEASE_LINE}`]);
    const nudged = await runHook(t1, false);
    expect(nudged.out).toContain("Feature Nudge");
    expect(await releases()).toHaveLength(0);

    // 2) Purely technical release → the nudge's own instruction: re-emit as is.
    const t2 = writeTranscript(projDir, "U1", [`shipping now\n\n${RELEASE_LINE}`, `technical only\n\n${RELEASE_LINE}`]);
    const shipped = await runHook(t2, true);
    expect(shipped.out).toContain("Release");
    expect(await releases()).toHaveLength(1);
    // BOTH release lines in the re-read turn must now be accounted for: the one
    // the nudge refused (consumed at the block site) and the one that shipped.
    // Recording only the shipped line is the leak — the refused twin stays fresh.
    expect(releaseKeys()).toHaveLength(2);

    // 3) The post-release verification response carries NO tags at all. The turn
    //    is re-read once more; nothing new may ship.
    const t3 = writeTranscript(projDir, "U1", [
      `shipping now\n\n${RELEASE_LINE}`,
      `technical only\n\n${RELEASE_LINE}`,
      "verified: lint green, typecheck green, versions bumped",
    ]);
    const after = await runHook(t3, true);
    expect(await releases()).toHaveLength(1);
    // Hook-level invariant, independent of the server-side content dedup that
    // masks the echo here but did not in the live incident: nothing fresh was
    // left to send, so no release banner and no new ledger entry.
    expect(after.out).not.toContain("DevLog Release");
    expect(releaseKeys()).toHaveLength(2);
  });
});
