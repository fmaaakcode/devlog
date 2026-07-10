// Position memory (#486) end-to-end against the real server: hook events →
// tag capture stamps `files` → PreToolUse inject returns the file story once
// per session → /api/file-story serves the timeline.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { asJson, startServer, waitForServer } from "./_helpers";

const PORT = 7841;
const BASE = `http://127.0.0.1:${PORT}`;
let proc: Subprocess;
let cwd: string;

const post = (path: string, body: unknown) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "devlog-posmem-e2e-"));
  cwd = join(dataDir, "posmem-proj");
  mkdirSync(cwd, { recursive: true });
  proc = startServer(dataDir, PORT);
  await waitForServer(BASE);

  // Session s1: register the project, edit a file, then capture a tag batch.
  await post("/api/inject", { hook_event_name: "SessionStart", cwd, session_id: "s1" });
  await post("/api/hook", {
    hook_event_name: "PostToolUse", tool_name: "Edit", cwd, session_id: "s1",
    tool_input: { file_path: join(cwd, "src", "core.ts"), old_string: "a", new_string: "b" },
  });
  const r = await post("/api/tags", {
    cwd, session_id: "s1",
    entries: [{ tag: "built", content: "position memory core wired" }],
  });
  expect(r.ok).toBe(true);
});

afterAll(() => { proc?.kill(); });

describe("position memory e2e", () => {
  it("stamps the captured tag with the session's touched files", async () => {
    const j = await asJson(await fetch(`${BASE}/api/tags/posmem-proj`));
    const built = (j.tags || []).find((t: { tag: string; files?: string[] }) => t.tag === "built");
    expect(built).toBeTruthy();
    expect((built.files || []).some((f: string) => f.endsWith("src/core.ts"))).toBe(true);
  });

  it("injects the file story on the first PreToolUse Read, then goes quiet for the session", async () => {
    const filePath = join(cwd, "src", "core.ts");
    const first = await asJson(await post("/api/inject", {
      hook_event_name: "PreToolUse", tool_name: "Read", cwd, session_id: "s2",
      tool_input: { file_path: filePath },
    }));
    const ctx = first.hookSpecificOutput?.additionalContext || "";
    expect(ctx).toContain("📍");
    expect(ctx).toContain("src/core.ts");
    expect(ctx).toContain("position memory core wired");

    const second = await asJson(await post("/api/inject", {
      hook_event_name: "PreToolUse", tool_name: "Read", cwd, session_id: "s2",
      tool_input: { file_path: filePath },
    }));
    expect(second.hookSpecificOutput?.additionalContext || "").toBe("");
  });

  it("stays silent for a file with no story and records no PreToolUse junk event", async () => {
    const res = await asJson(await post("/api/inject", {
      hook_event_name: "PreToolUse", tool_name: "Read", cwd, session_id: "s2",
      tool_input: { file_path: join(cwd, "src", "unknown.ts") },
    }));
    expect(res.hookSpecificOutput?.additionalContext || "").toBe("");

    const changes = await asJson(await fetch(`${BASE}/api/changes?project=posmem-proj&n=50`));
    for (const it of changes.items || []) expect(it.event).not.toBe("PreToolUse");
  });

  it("serves the timeline over /api/file-story", async () => {
    const j = await asJson(await fetch(`${BASE}/api/file-story?project=posmem-proj&path=src/core.ts&deep=1`));
    expect(j.tags.length).toBe(1);
    expect(j.tags[0].content).toContain("position memory core wired");
    expect(j.events.length).toBe(1);
    expect(j.events[0].file_path.endsWith("core.ts")).toBe(true);
    expect(Array.isArray(j.archived)).toBe(true);
  });

  it("requires project and path", async () => {
    expect((await fetch(`${BASE}/api/file-story?project=posmem-proj`)).status).toBe(400);
  });
});
