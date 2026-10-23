// #1256: the newest MATURE (≥7 days) release of a runtime tool. fetch is mocked;
// the registry kill switch is lifted per test so the real path runs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { matureToolchain } from "../src/toolchain-latest";

const realFetch = globalThis.fetch;
const realFlag = process.env.DEVLOG_REGISTRY_CHECK_DISABLED;
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

function mock(route: (url: string) => unknown | null) {
  globalThis.fetch = (async (input: unknown) => {
    const body = route(String(input));
    return body == null ? new Response("nf", { status: 404 }) : new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
}

beforeEach(() => { delete process.env.DEVLOG_REGISTRY_CHECK_DISABLED; });
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realFlag === undefined) delete process.env.DEVLOG_REGISTRY_CHECK_DISABLED;
  else process.env.DEVLOG_REGISTRY_CHECK_DISABLED = realFlag;
});

test("rustc: newest GitHub release older than a week — a 2-day-old one is skipped", async () => {
  mock(u => u.includes("api.github.com/repos/rust-lang/rust/releases") ? [
    { tag_name: "1.100.0", published_at: daysAgo(2) },
    { tag_name: "1.99.1", published_at: daysAgo(9) },
    { tag_name: "1.99.0", published_at: daysAgo(30) },
  ] : null);
  const r = await matureToolchain("rustc");
  expect(r.version).toBe("1.99.1");
  expect(r.days).toBe(9);
});

test("a tool with no dated history (Node, Go) → nulls, never a guess", async () => {
  mock(() => null);
  expect(await matureToolchain("Node")).toEqual({ version: null, date: null, days: null });
});

test("the registry kill switch means no lookup at all", async () => {
  process.env.DEVLOG_REGISTRY_CHECK_DISABLED = "1";
  let called = false;
  mock(() => { called = true; return null; });
  expect((await matureToolchain("Bun")).version).toBeNull();
  expect(called).toBe(false);
});
