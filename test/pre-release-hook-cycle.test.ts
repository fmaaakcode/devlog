// The release guard's hook cycle, driven as the real subprocess against a stub
// daemon (audit round 10, wave 2):
//   #1044 / F-3.93 — patterns matched quoted text: a commit message, a grep or a
//                    heredoc that MENTIONS `npm publish` was refused as a release
//   #1045 / F-3.95 — `git push origin vX`, `--follow-tags`, a lightweight
//                    `git tag vX`, `bun publish`, `gh release upload` were not covered
//   #1043 / F-3.92 — «قادمة» (upcoming) items blocked the release
//   #1046 / F-3.94 — a daemon that did not answer made the guard ack and pass
//   #1065 / F-4.80 — `cwd-mismatch` read as "0 open items"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "pre-release-hook.js");
const ACK_DIR = join(ROOT, ".devlog", "release-ack");
const SID_PREFIX = `prh-cycle-${process.pid}-`;

let server: ReturnType<typeof Bun.serve>;
let port = 0;
// What the stub answers for /api/open-items — each test sets it.
let openReply: unknown = { project: "p", items: [] };
const changelogCount = 3;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/open-items") return Response.json(openReply);
      if (url.pathname === "/api/changelog/since-last-release") {
        return url.searchParams.get("format") === "md"
          ? new Response("- built: x\n- done: y\n", { headers: { "Content-Type": "text/markdown" } })
          : Response.json({ count: changelogCount });
      }
      if (url.pathname === "/api/data") return Response.json({ projects: {}, tags: [], plans: [] });   // doctor: PROJECT_NOT_INDEXED (medium)
      return Response.json({ ok: true });
    },
  });
  port = server.port ?? 0;
});

afterAll(() => server.stop(true));
afterEach(() => {
  if (existsSync(ACK_DIR)) for (const f of readdirSync(ACK_DIR)) if (f.startsWith(encodeURIComponent(SID_PREFIX))) rmSync(join(ACK_DIR, f), { force: true });
});

let n = 0;
async function runHook(command: string, opts: { sid?: string; port?: number } = {}): Promise<{ code: number; err: string; sid: string }> {
  const sid = opts.sid ?? `${SID_PREFIX}${++n}`;
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "Bash", session_id: sid, cwd: ROOT,
    tool_input: { command, description: "t" },
  });
  const { DEVLOG_RELEASE_GUARD: _drop, CLAUDE_PROJECT_DIR: _drop2, ...clean } = process.env as Record<string, string>;
  const proc = Bun.spawn(["bun", HOOK], {
    cwd: ROOT,
    env: { ...clean, DEVLOG_PORT: String(opts.port ?? port), DEVLOG_LANG: "en" },
    stdin: new Response(payload),
    stdout: "pipe", stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, err, sid };
}
const ackFor = (sid: string) => existsSync(ACK_DIR) && readdirSync(ACK_DIR).some(f => f.startsWith(encodeURIComponent(sid)));

describe("release guard — what is a release command", () => {
  test.each([
    'git commit -m "docs: mention npm publish and gh release create"',
    'grep -n "release create\\|git tag\\|push --tags\\|npm publish" src/x.ts',
    "cat >> phase-3.md <<'EOF'\nThe guard blocks `gh release create` and `git push --tags`.\nEOF",
    "git tag -l",
    "git tag -d v1.2.3",
    "git push origin main",
    "echo cargo publish # not really",
    "echo git push origin v1.2.3",
    "git log --oneline | grep 'gh release create'",
  ])("not a release: %p → exit 0, silent", async (cmd) => {
    openReply = { project: "p", items: [{ num: 1, tag: "bug found", content: "x" }] };
    const r = await runHook(cmd);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  test.each([
    "gh release create v1.2.3 --notes x",
    "gh release upload v1.2.3 dist.zip",
    "git tag -a v1.2.3 -m 'release'",
    "git tag -a -m 'release' v1.2.3",
    "git tag v1.2.3",
    "git push --tags",
    "git push origin --follow-tags",
    "git push origin v1.2.3",
    "git push origin refs/tags/v1.2.3",
    "npm publish",
    "bun publish",
    "cargo publish",
  ])("a release: %p → gated", async (cmd) => {
    openReply = { project: "p", items: [{ num: 1, tag: "bug found", content: "still open" }] };
    const r = await runHook(cmd);
    expect(r.code).toBe(2);
    expect(r.err).toContain("1 open items");
    expect(r.err).toContain("#1 still open");
  });
});

describe("release guard — the open list", () => {
  test("upcoming items never block: briefing once, ack written, re-issue passes", async () => {
    openReply = { project: "p", items: [{ num: 621, tag: "todo", content: "deferred", upcoming: true }] };
    const first = await runHook("git push origin v9.9.9");
    expect(first.code).toBe(2);
    expect(first.err).not.toContain("open items");
    expect(first.err).toContain("changelog since the last release (3 items)");
    expect(first.err).toContain("re-issue the command");
    expect(ackFor(first.sid)).toBe(true);
    const again = await runHook("git push origin v9.9.9", { sid: first.sid });
    expect(again.code).toBe(0);
  });

  test("daemon down: refused, NO ack, and refused again on re-issue", async () => {
    const dead = 1;   // nothing listens on port 1
    const first = await runHook("gh release create v9.9.9", { port: dead });
    expect(first.code).toBe(2);
    expect(first.err).toContain("Refused");
    expect(first.err).toContain("could not be read");
    expect(first.err).not.toContain("No tags (built/done/fix) since the last release");
    expect(ackFor(first.sid)).toBe(false);
    const again = await runHook("gh release create v9.9.9", { sid: first.sid, port: dead });
    expect(again.code).toBe(2);
    expect(again.err).toContain("Refused");
  });

  test("cwd-mismatch is unknown, not empty: refused with the reason, no ack", async () => {
    openReply = { project: "p", items: [], reason: "cwd-mismatch" };
    const r = await runHook("npm publish");
    expect(r.code).toBe(2);
    expect(r.err).toContain("not the registered path");
    expect(ackFor(r.sid)).toBe(false);
  });

  test("a doctor that cannot see the project is reported, never read as clean", async () => {
    openReply = { project: "p", items: [] };
    const r = await runHook("bun publish");
    expect(r.code).toBe(2);                              // briefing pass (changelog), not a refusal
    expect(r.err).toContain("[PROJECT_NOT_INDEXED]");    // the stub's doctor verdict, shown as medium
    expect(r.err).not.toContain("✗ Refused");
  });
});
