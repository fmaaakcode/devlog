// #1054 — unit half: the status an internal throw answers with. The e2e can
// provoke the client-fault 400s but cannot honestly make a stage throw after
// validation, so the mapping itself is pinned here: any Error past validation
// is a 500 (retryable for the hook's queue), never a 4xx (poison).

import { describe, expect, test } from "bun:test";
import { tagsBodyError, tagsInternalError } from "../src/routes-tags";

describe("tagsInternalError", () => {
  test("an internal throw answers 500 with the message as detail", async () => {
    const r = tagsInternalError(new TypeError("s.replace is not a function"));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "Internal error", detail: "s.replace is not a function" });
  });

  test("a non-Error throw still answers 500", async () => {
    const r = tagsInternalError("EPERM");
    expect(r.status).toBe(500);
    expect(((await r.json()) as { detail: string }).detail).toBe("EPERM");
  });
});

describe("tagsBodyError", () => {
  test("accepts the shapes the hook sends", () => {
    expect(tagsBodyError({ cwd: "D:/x", entries: [{ tag: "note", content: "n" }], session_id: "s", batch_id: "b" })).toBeNull();
    expect(tagsBodyError({ entries: [] })).toBeNull();
    expect(tagsBodyError({})).toBeNull();
  });

  test("rejects each wrong field by name", () => {
    expect(tagsBodyError(null)).toContain("object");
    expect(tagsBodyError([])).toContain("object");
    expect(tagsBodyError({ cwd: 1 })).toContain("cwd");
    expect(tagsBodyError({ entries: {} })).toContain("entries");
    expect(tagsBodyError({ entries: [null] })).toContain("entry");
    expect(tagsBodyError({ entries: [{ tag: 1 }] })).toContain("tag");
    expect(tagsBodyError({ entries: [{ tag: "note", content: 1 }] })).toContain("content");
  });
});
