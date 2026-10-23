import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpManifests, readManifestVersion, compareSemver, restoreManifestVersion, type VersionReject } from "../src/version-writer";
import { decodeRc, encodeRc, scanRc, bumpRcText } from "../src/version-writer-cpp";

// C/C++ projects version themselves in a resource .rc (what Windows shows in
// the exe's Properties tab) and optionally in dependencies.json. Before this
// a C++ release had to be numbered by hand. The contracts pinned here:
//   1. all four .rc spots move together, or the file is refused untouched;
//   2. the file's encoding (VS default UTF-16LE) survives the rewrite;
//   3. the 4th (build) part is never invented or dropped.

// The shape of a real MinGW project's resource.rc.
const RC = `#include <windows.h>

101 ICON "icon.ico"

VS_VERSION_INFO VERSIONINFO
FILEVERSION 1,4,0,0
PRODUCTVERSION 1,4,0,0
FILEFLAGSMASK 0x3fL
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904b0"
        BEGIN
            VALUE "CompanyName", "SampleApp"
            VALUE "FileVersion", "1.4.0.0"
            VALUE "InternalName", "sampleapp"
            VALUE "ProductVersion", "1.4.0.0"
        END
    END
END
`;

const DEPS = JSON.stringify({
  project: { name: "SampleApp", version: "1.4.0", language: "C++" },
  dependencies: [{ name: "libmaxminddb", version: "1.14.0" }],
}, null, 2);

function proj(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), "vw-cpp-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("scanRc — reading the version out of VERSIONINFO", () => {
  test("4-part with a zero build part reads as X.Y.Z", () => {
    const s = scanRc(RC, compareSemver);
    expect(s.kind).toBe("ok");
    if (s.kind === "ok") expect(s.version).toBe("1.4.0");
  });

  test("a non-zero build part is kept so it still orders", () => {
    const s = scanRc(RC.replace("FILEVERSION 1,4,0,0", "FILEVERSION 1,4,0,7"), compareSemver);
    if (s.kind === "ok") expect(s.version).toBe("1.4.0.7");
  });

  test("an .rc without VS_VERSION_INFO is not a version source", () => {
    expect(scanRc(`101 ICON "icon.ico"\n`, compareSemver).kind).toBe("none");
  });

  test("macro-driven rows (FILEVERSION VER_MAJOR,…) are refused, not guessed", () => {
    expect(scanRc(RC.replace("FILEVERSION 1,4,0,0", "FILEVERSION VER_MAJOR,VER_MINOR,0,0"), compareSemver).kind).toBe("unsupported");
  });

  test("a prose version string is refused (its format belongs to someone else)", () => {
    expect(scanRc(RC.replace(`"FileVersion", "1.4.0.0"`, `"FileVersion", "1.4 beta"`), compareSemver).kind).toBe("unsupported");
  });
});

describe("bumpRcText — all spots or none", () => {
  test("moves both binary rows and both strings, keeps the build part", () => {
    const r = bumpRcText(RC, "1.4.1", compareSemver, false);
    expect(r && "text" in r).toBe(true);
    if (!r || !("text" in r)) return;
    expect(r.from).toBe("1.4.0");
    expect(r.text).toContain("FILEVERSION 1,4,1,0");
    expect(r.text).toContain("PRODUCTVERSION 1,4,1,0");
    expect(r.text).toContain(`"FileVersion", "1.4.1.0"`);
    expect(r.text).toContain(`"ProductVersion", "1.4.1.0"`);
    // Nothing else in the file moved.
    expect(r.text.replaceAll("1,4,1,0", "1,4,0,0").replaceAll("1.4.1.0", "1.4.0.0")).toBe(RC);
  });

  test("comma-style and 3-part strings keep their own format", () => {
    const rc = RC.replace(`"FileVersion", "1.4.0.0"`, `"FileVersion", "1, 4, 0, 0"`)
      .replace(`"ProductVersion", "1.4.0.0"`, `"ProductVersion", "1.4.0"`);
    const r = bumpRcText(rc, "2.0.0", compareSemver, false);
    if (!r || !("text" in r)) throw new Error("expected a rewrite");
    expect(r.text).toContain(`"FileVersion", "2, 0, 0, 0"`);
    expect(r.text).toContain(`"ProductVersion", "2.0.0"`);
  });

  test("a 4-part release sets the build part too", () => {
    const r = bumpRcText(RC, "1.5.0.3", compareSemver, false);
    if (!r || !("text" in r)) throw new Error("expected a rewrite");
    expect(r.text).toContain("FILEVERSION 1,5,0,3");
    expect(r.text).toContain(`"FileVersion", "1.5.0.3"`);
  });

  test("same version → no write", () => {
    expect(bumpRcText(RC, "1.4.0", compareSemver, false)).toBeNull();
  });

  test("downgrade refused; rollback may downgrade", () => {
    expect(bumpRcText(RC, "1.3.9", compareSemver, false)).toEqual({ reject: "downgrade", current: "1.4.0" });
    const r = bumpRcText(RC, "1.3.9", compareSemver, true);
    expect(r && "text" in r && r.text.includes("FILEVERSION 1,3,9,0")).toBe(true);
  });

  test("a pre-release has no slot in the binary rows → refused, never truncated", () => {
    expect(bumpRcText(RC, "1.5.0-rc.1", compareSemver, false)).toEqual({ reject: "unsupported-layout", current: "1.4.0" });
  });
});

describe("decodeRc / encodeRc — encoding round-trips", () => {
  test.each(["utf8", "utf8-bom", "utf16le", "utf16le-bom"] as const)("%s", (enc) => {
    const bytes = encodeRc(RC, enc);
    const back = decodeRc(bytes);
    expect(back.enc).toBe(enc);
    expect(back.text).toBe(RC);
  });
});

describe("bumpManifests / readManifestVersion — C++ project on disk", () => {
  test("release bumps resource.rc and dependencies.json together", async () => {
    const dir = proj({ "resource.rc": RC, "dependencies.json": DEPS });
    try {
      expect(await readManifestVersion(dir)).toBe("1.4.0");
      const ups = await bumpManifests(dir, "v1.4.1 — fix");
      expect(ups.map((u) => u.file.split(/[\\/]/).pop()).sort()).toEqual(["dependencies.json", "resource.rc"]);
      expect(readFileSync(join(dir, "resource.rc"), "utf8")).toContain("FILEVERSION 1,4,1,0");
      const deps = JSON.parse(readFileSync(join(dir, "dependencies.json"), "utf8"));
      expect(deps.project.version).toBe("1.4.1");
      expect(deps.dependencies[0].version).toBe("1.14.0"); // a library's version never moves
      expect(await readManifestVersion(dir)).toBe("1.4.1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a UTF-16LE (Visual Studio) .rc stays UTF-16LE with its BOM", async () => {
    const dir = proj({ "app.rc": encodeRc(RC, "utf16le-bom") });
    try {
      await bumpManifests(dir, "v1.5.0 — x");
      const bytes = readFileSync(join(dir, "app.rc"));
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
      expect(decodeRc(bytes).text).toContain("PRODUCTVERSION 1,5,0,0");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("an unsupported .rc is reported, not silently skipped", async () => {
    const dir = proj({ "resource.rc": RC.replace("FILEVERSION 1,4,0,0", "FILEVERSION VER_MAJOR,0,0,0") });
    try {
      const rej: VersionReject[] = [];
      expect(await bumpManifests(dir, "v1.4.1 — x", rej)).toEqual([]);
      expect(rej.map((r) => r.reason)).toEqual(["unsupported-layout"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("dependencies.json of a non-C++ project is never touched", async () => {
    const other = JSON.stringify({ project: { version: "0.1.0", language: "Python" } });
    const dir = proj({ "dependencies.json": other });
    try {
      expect(await readManifestVersion(dir)).toBeNull();
      expect(await bumpManifests(dir, "v1.0.0 — x")).toEqual([]);
      expect(readFileSync(join(dir, "dependencies.json"), "utf8")).toBe(other);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("rollback restores both C++ spots", async () => {
    const dir = proj({ "resource.rc": RC, "dependencies.json": DEPS });
    try {
      await restoreManifestVersion(dir, "1.3.0");
      expect(readFileSync(join(dir, "resource.rc"), "utf8")).toContain(`"ProductVersion", "1.3.0.0"`);
      expect(JSON.parse(readFileSync(join(dir, "dependencies.json"), "utf8")).project.version).toBe("1.3.0");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
