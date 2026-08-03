// #755, second half: /api/file must refuse secret-bearing files outright.
//
// The route guard now stops a cross-origin reader, but /api/file still served
// any file inside a tracked project to a legitimate same-origin caller — .env,
// id_rsa, *.pem included. hooks.ts already kept exactly those files out of the
// stored event stream; the same list now gates the preview route, so the two
// surfaces can't drift apart.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { isSensitivePath } from "../src/sensitive-paths";
import { startServer, stopServer, waitForServer } from "./_helpers";

const TEST_PORT = 17953;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

describe("isSensitivePath", () => {
  for (const p of [
    "D:/proj/.env",
    "D:/proj/.env.local",
    "D:/proj/config/.npmrc",
    "D:/proj/keys/id_rsa",
    "D:/proj/keys/id_ed25519.pub",
    "D:/proj/certs/server.pem",
    "D:/proj/certs/client.p12",
    "D:/proj/aws-credentials.json",
    "D:/proj/tokens.secrets",
    "D:\\proj\\.env",
  ]) {
    test(`flags ${p}`, () => { expect(isSensitivePath(p)).toBe(true); });
  }

  // The list is deliberately path-based, so ordinary source must pass — a
  // filter that swallows normal files hides the user's data from themselves.
  for (const p of [
    "D:/proj/src/server.ts",
    "D:/proj/envelope.md",
    "D:/proj/src/keyboard.ts",
    "D:/proj/README.md",
  ]) {
    test(`allows ${p}`, () => { expect(isSensitivePath(p)).toBe(false); });
  }

  test("undefined is not sensitive", () => { expect(isSensitivePath(undefined)).toBe(false); });
});

let server: Subprocess;
let dataDir: string;
let projectDir: string;

describe("e2e — /api/file refuses sensitive files", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "devlog-sensitive-"));
    projectDir = mkdtempSync(join(tmpdir(), "devlog-sensproj-"));
    writeFileSync(join(projectDir, ".env"), "SECRET_TOKEN=abc123\n");
    writeFileSync(join(projectDir, "notes.txt"), "harmless\n");
    server = startServer(dataDir, TEST_PORT);
    await waitForServer(BASE);
  });

  afterAll(async () => {
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const get = (p: string) =>
    fetch(`${BASE}/api/file?path=${encodeURIComponent(p)}`, {
      headers: { "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${TEST_PORT}` },
    });

  test("a same-origin request for .env is refused as sensitive, not merely 403'd", async () => {
    const r = await get(join(projectDir, ".env").replace(/\\/g, "/"));
    expect(r.status).toBe(403);
    // Distinct wording proves the sensitive branch fired — a containment 403
    // would read "Forbidden" and would pass a status-only assertion.
    expect(await r.text()).toMatch(/Refused — sensitive file|مرفوض — ملف حسّاس/);
  });

  test("the secret never appears in the body", async () => {
    const body = await (await get(join(projectDir, ".env").replace(/\\/g, "/"))).text();
    expect(body).not.toContain("SECRET_TOKEN");
  });

  test("an ordinary file outside any tracked project still fails on containment", async () => {
    const r = await get(join(projectDir, "notes.txt").replace(/\\/g, "/"));
    expect(r.status).toBe(403);
    expect(await r.text()).toBe("Forbidden");
  });
});
