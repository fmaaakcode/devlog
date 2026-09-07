// The install gate's full hook cycle (#1176 / F-9.4 — no test drove
// pre-install-hook.js end to end before; #1047 / F-3.82 — the ack that let a
// blind install through on verbatim re-issue). A stub advisor answers
// /api/lib-advice; the hook runs as the real subprocess with the payload the
// harness sends. What the cycle must prove:
//   · a blind `bun add lodash` is blocked — and blocked AGAIN on verbatim
//     re-issue (no ack is ever written for a hard block)
//   · a pin that disagrees with the advisor blocks once, then the same
//     packages+pins pass (ack-pass), and an ack older than 10 minutes expires
//   · the ack is keyed by the package set, not the command text — a re-issue
//     with different spacing still passes
//   · DEVLOG_INSTALL_GATE=0 disables the gate; the value is read from the env
//     the hook runs in, never inherited from the developer's machine
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "pre-install-hook.js");
const ACK_DIR = join(ROOT, ".devlog", "install-ack");
const SID = `pih-cycle-${process.pid}-${Date.now().toString(36)}`;

let server: ReturnType<typeof Bun.serve>;
let port = 0;
const seen: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/lib-advice") {
        const names = (url.searchParams.get("names") || "").split(",").filter(Boolean);
        seen.push(names.join(","));
        const items = names.map(n => {
          const [, name] = n.split(":");
          const bare = name.split("@")[0];
          return { name: bare, verdict: "ok", suggest: "4.18.1", suggestAgeDays: 40, installCmd: `bun add ${bare}@4.18.1` };
        });
        return Response.json({ items });
      }
      return Response.json({ ok: true }); // telemetry, install-override
    },
  });
  port = server.port ?? 0;
});

afterAll(() => {
  server.stop(true);
  if (existsSync(ACK_DIR)) {
    for (const f of readdirSync(ACK_DIR)) if (f.startsWith(encodeURIComponent(SID))) rmSync(join(ACK_DIR, f), { force: true });
  }
});

async function runHook(command: string, env: Record<string, string> = {}): Promise<{ code: number; err: string }> {
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "Bash", session_id: SID, cwd: ROOT,
    tool_input: { command, description: "t" },
  });
  const { DEVLOG_INSTALL_GATE: _drop, ...clean } = process.env as Record<string, string>;
  const proc = Bun.spawn(["bun", HOOK], {
    cwd: ROOT,
    env: { ...clean, DEVLOG_PORT: String(port), DEVLOG_LANG: "en", ...env },
    stdin: new Response(payload),
    stdout: "pipe", stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, err };
}

const ackFiles = () => (existsSync(ACK_DIR) ? readdirSync(ACK_DIR).filter(f => f.startsWith(encodeURIComponent(SID))) : []);

describe("pre-install-hook cycle", () => {
  test("blind install: blocked, and blocked again on verbatim re-issue (never acked)", async () => {
    const first = await runHook("bun add lodash");
    expect(first.code).toBe(2);
    expect(first.err).toContain("blind install");
    expect(first.err).toContain("lodash@4.18.1");
    expect(first.err).toContain("never passed on re-issue");
    expect(ackFiles()).toHaveLength(0);
    const again = await runHook("bun add lodash");
    expect(again.code).toBe(2);
    expect(again.err).toContain("blind install");
  });

  test("pin that disagrees: blocks once, then the same package set passes — keyed by set, not text", async () => {
    const first = await runHook("bun add lodash@4.0.0");
    expect(first.code).toBe(2);
    expect(first.err).toContain("advisor recommends 4.18.1");
    expect(ackFiles()).toHaveLength(1);
    // Different spacing, same packages+pins → still the sanctioned override.
    const again = await runHook("bun  add   lodash@4.0.0");
    expect(again.code).toBe(0);
    expect(again.err).toBe("");
    // Expired ack (older than 10 min) → gated again.
    const f = join(ACK_DIR, ackFiles()[0]);
    const ack = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...ack, ts: Date.now() - 11 * 60 * 1000 }));
    const stale = await runHook("bun add lodash@4.0.0");
    expect(stale.code).toBe(2);
  });

  test("more than 8 packages are all asked (batched) and all gated", async () => {
    seen.length = 0;
    const names = "a b c d e f g h i j".split(" ");
    const r = await runHook(`bun add ${names.join(" ")}`);
    expect(r.code).toBe(2);
    expect(seen.length).toBe(2);                              // two advisor batches
    expect(seen.join(",").split(",").length).toBe(10);       // every name reached the advisor
    for (const n of names) expect(r.err).toContain(`⛔ ${n}:`);
  });

  test("DEVLOG_INSTALL_GATE=0 disables the gate for the hook's own env", async () => {
    const r = await runHook("bun add lodash", { DEVLOG_INSTALL_GATE: "0" });
    expect(r.code).toBe(0);
  });

  test("a non-install command never gates", async () => {
    const r = await runHook("echo \"bun add lodash\" && git status");
    expect(r.code).toBe(0);
  });
});
