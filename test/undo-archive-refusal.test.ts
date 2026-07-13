// #584, the hard half: when the archive write FAILS, the undo must be REFUSED.
//
// "Archive instead of delete" is worthless if a failed archive still deletes — the
// row would be gone AND unrecoverable, which is strictly worse than the old hard
// delete because the user now believes there's a copy. Same contract runRetention
// already honors when it puts un-archivable events back.
//
// The failure is REAL, not mocked: a plain FILE sits where the archive DIRECTORY
// must be, so `mkdir(ARCHIVE_DIR, {recursive:true})` throws and every archive write
// in the process fails. Its own test file because that broken data dir poisons the
// archive for the whole server it boots.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, waitForServer, asJson } from "./_helpers";
import type { TagEntry, DevLogData } from "../src/types";

const TEST_PORT = 17905;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let server: Subprocess;
let dataDir = "";
let projDir = "";

const post = async (entries: unknown[]) => {
  const r = await fetch(`${BASE}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: projDir, session_id: "s1", entries }),
    signal: AbortSignal.timeout(8000),
  });
  return await asJson(r);
};
const store = async (): Promise<DevLogData> => await asJson<DevLogData>(await fetch(`${BASE}/api/data`));

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "undo-refuse-data-"));
  // The sabotage: `archive` exists as a FILE, so creating it as a directory fails.
  writeFileSync(join(dataDir, "archive"), "not a directory\n");
  projDir = join(mkdtempSync(join(tmpdir(), "undo-refuse-")), "refuse-proj");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "refuse-proj", version: "1.0.0" }));
  server = startServer(dataDir, TEST_PORT);
  await waitForServer(BASE);
  await fetch(`${BASE}/api/inject?cwd=${encodeURIComponent(projDir)}&session_id=s0&type=SessionStart`);
});

afterAll(() => {
  server?.kill();
  for (const d of [dataDir, projDir]) if (d) rmSync(d, { recursive: true, force: true });
});

describe("a failed archive refuses the undo", () => {
  test("the tag stays in the store — never deleted without a copy", async () => {
    await post([{ tag: "todo", content: "لا يجوز أن أختفي بلا نسخة" }]);
    const target = (await store()).tags.find(t => t.content === "لا يجوز أن أختفي بلا نسخة");
    expect(target).toBeDefined();

    await post([{ tag: "undo", content: `#${target!.num}` }]);

    const after = (await store()).tags.filter(t => t.project === "refuse-proj");
    expect(after.some((t: TagEntry) => t.content === "لا يجوز أن أختفي بلا نسخة")).toBe(true);
  });

  test("the refusal is visible — it rides the rejections channel into SessionStart", async () => {
    const d = await store();
    const rejections = (d.rejections || []).filter(r => r.project === "refuse-proj");
    expect(rejections.some(r => r.reason === "undo-archive-failed")).toBe(true);
  });
});
