// doctor's git-tag checks against a real temporary repository (audit round 10,
// wave 2). The daemon is a stub answering /api/data with crafted records; the
// doctor runs as the real CLI subprocess so DEVLOG_PORT never leaks into other
// test files. Scenarios are the audit's, not invented:
//   #1069 / F-4.97  — a tag older than the project's first -(release) can never
//                     be answered; it is informational, never critical. A judged
//                     high is acknowledged with -(rule:ack) doctor:<CODE>.
//   #1070 / F-4.98  — THIN_RELEASE_COMMITS reads the tagged commit (any message
//                     convention) and ignores trailers.
//   #1071 / F-4.99  — an unregistered path is reported as such, never as the
//                     same-named project elsewhere.
//   #1072 / F-4.100 — a project nested in a larger repo does not inherit the
//                     parent's tags as missing notes; prereleases count as files.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubbedEnv } from "./_helpers";

const ROOT = join(import.meta.dir, "..");
const HAS_GIT = !!Bun.which("git");

let server: ReturnType<typeof Bun.serve>;
let port = 0;
let repo = "";
let nested = "";
let data: Record<string, unknown> = {};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...scrubbedEnv(), GIT_TERMINAL_PROMPT: "0", ...env }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
const commitEnv = (iso: string) => ({ GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

type DocFinding = { severity: string; code: string; title: string; items?: string[] };
async function doctor(path: string): Promise<{ findings: DocFinding[]; project: string }> {
  const proc = Bun.spawn(["bun", join(ROOT, "src", "doctor.ts"), "--json", path], {
    cwd: ROOT, env: { ...scrubbedEnv(), DEVLOG_PORT: String(port), DEVLOG_LANG: "en" }, stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out);
}
const byCode = (r: { findings: DocFinding[] }): Record<string, DocFinding | undefined> => Object.fromEntries(r.findings.map(f => [f.code, f]));

beforeAll(() => {
  if (!HAS_GIT) return;
  repo = mkdtempSync(join(tmpdir(), "doctor-git-"));
  nested = join(repo, "packages", "inner");
  mkdirSync(nested, { recursive: true });
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, ["add", "."]);
  // Pre-adoption history: tagged in 2020 with a thin message.
  git(repo, ["commit", "-q", "-m", "chore: bump"], commitEnv("2020-01-01T00:00:00Z"));
  git(repo, ["tag", "v0.1.0"]);
  // Post-adoption: a thin commit tagged v0.3.0 (title + trailers only), and a
  // prerelease tag that DOES have its release file.
  writeFileSync(join(repo, "a.txt"), "2");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "chore: bump version to v0.3.0\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_x"], commitEnv("2026-06-01T00:00:00Z"));
  git(repo, ["tag", "v0.3.0"]);
  writeFileSync(join(repo, "a.txt"), "3");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "feat: v1.0.0-rc1 — a properly described release candidate with what shipped listed"], commitEnv("2026-06-02T00:00:00Z"));
  git(repo, ["tag", "v1.0.0-rc1"]);
  mkdirSync(join(repo, ".devlog", "releases"), { recursive: true });
  writeFileSync(join(repo, ".devlog", "releases", "v1.0.0-rc1.html"), "<html></html>");

  // DevLog's record: adoption = first -(release) in 2023 → v0.1.0 predates it.
  data = {
    projects: { outer: { path: repo }, inner: { path: nested } },
    tags: [
      { id: "r1", tag: "release", content: "v0.2.0 — first recorded release", project: "outer", timestamp: "2023-01-01T00:00:00.000Z" },
      { id: "r2", tag: "release", content: "v1.0.0-rc1 — candidate", project: "outer", timestamp: "2026-06-02T00:00:00.000Z" },
    ],
    plans: [],
  };
  server = Bun.serve({ port: 0, fetch: () => Response.json(data) });
  port = server.port ?? 0;
});

afterAll(() => {
  server?.stop(true);
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe.skipIf(!HAS_GIT)("doctor — git tags in scope", () => {
  test("pre-adoption tags are informational; post-adoption gaps are high; prereleases with a file are fine", async () => {
    const f = byCode(await doctor(repo));
    expect(f.PRE_ADOPTION_RELEASES?.severity).toBe("medium");
    expect(f.PRE_ADOPTION_RELEASES?.items).toEqual(["v0.1.0"]);
    expect(f.MISSING_RELEASE_NOTES?.severity).toBe("high");
    expect(f.MISSING_RELEASE_NOTES?.items).toEqual(["v0.3.0"]);
    expect(f.GIT_TAGS_WITHOUT_DEVLOG?.items).toEqual(["v0.3.0"]);         // v0.1.0 is pre-adoption, not a ghost
  });

  test("THIN_RELEASE_COMMITS reads the tagged commit and ignores trailers; pre-adoption commits are not judged", async () => {
    const f = byCode(await doctor(repo));
    expect(f.THIN_RELEASE_COMMITS?.severity).toBe("high");
    expect(f.THIN_RELEASE_COMMITS?.items).toHaveLength(1);
    expect(f.THIN_RELEASE_COMMITS?.items?.[0]).toStartWith("v0.3.0:");
    expect(f.THIN_RELEASE_COMMITS?.items?.[0]).toContain("(29 chars)");     // trailers did not pad the count
  });

  test("an acknowledged high (-(rule:ack) doctor:CODE) becomes a visible medium", async () => {
    writeFileSync(join(repo, ".devlog", "standards-ack"), "doctor:MISSING_RELEASE_NOTES\ndoctor:THIN_RELEASE_COMMITS\n");
    try {
      const f = byCode(await doctor(repo));
      expect(f.MISSING_RELEASE_NOTES?.severity).toBe("medium");
      expect(f.MISSING_RELEASE_NOTES?.title).toContain("acknowledged");
      expect(f.THIN_RELEASE_COMMITS?.severity).toBe("medium");
      expect(f.PRE_ADOPTION_RELEASES?.severity).toBe("medium");
    } finally {
      rmSync(join(repo, ".devlog", "standards-ack"), { force: true });
    }
  });

  test("a project nested inside the repo does not inherit the parent's tags", async () => {
    const f = byCode(await doctor(nested));
    expect(f.NESTED_PROJECT_GIT_TAGS?.severity).toBe("low");
    expect(f.MISSING_RELEASE_NOTES).toBeUndefined();
    expect(f.PRE_ADOPTION_RELEASES).toBeUndefined();
    expect(f.THIN_RELEASE_COMMITS).toBeUndefined();
  });

  test("an unregistered path is not diagnosed as the same-named project elsewhere", async () => {
    const twin = mkdtempSync(join(tmpdir(), "doctor-twin-"));
    const path = join(twin, "outer");       // same basename as the registered project
    mkdirSync(path);
    try {
      const r = await doctor(path);
      expect(r.findings.map(f => f.code)).toEqual(["PROJECT_NOT_INDEXED"]);
      expect(r.findings[0].severity).toBe("medium");
    } finally {
      rmSync(twin, { recursive: true, force: true });
    }
  });
});
