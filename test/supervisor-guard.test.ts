// #770 source guard for devlog-supervisor.ps1 — no PowerShell test harness in
// this repo, so pin the fix at the source level (fails closed, same style as
// the direction guard): Start-Process's redirect TRUNCATES its target, so the
// supervisor must preserve BOTH channels into the .1 generation before every
// start, and a failed start must be written down, not swallowed by the global
// SilentlyContinue.
import { describe, test, expect } from "bun:test";
import { join } from "node:path";

const PS1 = join(import.meta.dir, "..", "devlog-supervisor.ps1");

describe("supervisor log preservation + failure visibility (#770)", () => {
  test("both channels are preserved before the truncating start", async () => {
    const src = await Bun.file(PS1).text();
    expect(src).toContain('foreach ($f in @($log, "$log.err"))');   // .err included
    expect(src).toContain('Add-Content -Path "$f.1"');              // preserve, not drop
  });

  test("a failed daemon start is logged, not silently swallowed", async () => {
    const src = await Bun.file(PS1).text();
    expect(src).toContain("-ErrorAction Stop");
    expect(src).toContain("failed to start daemon");
  });

  test("the false '>> append' claim about Start-Process is gone", async () => {
    const src = await Bun.file(PS1).text();
    expect(src).not.toContain("`>>` semantics");
  });
});
