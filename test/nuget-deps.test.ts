// NuGet library detection (nuget-deps.ts): the pure XML parsers, the bounded
// walk, central versions from the nearest Directory.Packages.props, and the
// end-to-end path through scanner.detectPackages.

import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeNugetVersion, parsePackageReferences, parseCentralVersions, parsePackagesConfig,
  detectNugetDeps, isNugetManifest, parseNugetLock,
} from "../src/nuget-deps";
import { detectPackages } from "../src/scanner";
import { isFreshnessHit } from "../src/manifest-freshness";
import { enumerateDepTree, dependentsGraph, chainTo } from "../src/lockfile-tree";

async function withTmp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "nuget-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("normalizeNugetVersion", () => {
  test("plain, exact and ranged specs resolve from the lower bound", () => {
    expect(normalizeNugetVersion("13.0.3")).toBe("13.0.3");
    expect(normalizeNugetVersion("[1.2.3]")).toBe("1.2.3");
    expect(normalizeNugetVersion("[1.0,2.0)")).toBe("1.0");
    expect(normalizeNugetVersion("8.0.0-preview.1")).toBe("8.0.0-preview.1");
  });
  test("floating, open-low, empty and unresolved specs → *", () => {
    expect(normalizeNugetVersion("1.*")).toBe("*");
    expect(normalizeNugetVersion("(,2.0]")).toBe("*");
    expect(normalizeNugetVersion("")).toBe("*");
    expect(normalizeNugetVersion("$(Missing)")).toBe("*");
  });
  test("$(Prop) resolves from properties, case-insensitively", () => {
    expect(normalizeNugetVersion("$(SerilogVersion)", new Map([["serilogversion", "3.1.1"]]))).toBe("3.1.1");
  });
});

describe("parsePackageReferences", () => {
  test("attribute and child-element versions; Update-only items and comments skipped", () => {
    const xml = `<Project Sdk="Microsoft.NET.Sdk">
      <ItemGroup>
        <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
        <PackageReference Include="Dapper">
          <Version>2.1.35</Version>
        </PackageReference>
        <PackageReference Update="Microsoft.NETCore.App" Version="8.0.0" />
        <!-- <PackageReference Include="Commented.Out" Version="1.0.0" /> -->
      </ItemGroup>
    </Project>`;
    expect(parsePackageReferences(xml)).toEqual([
      { name: "Newtonsoft.Json", version: "13.0.3", eco: "nuget" },
      { name: "Dapper", version: "2.1.35", eco: "nuget" },
    ]);
  });
  test("central versions fill a version-less reference; VersionOverride wins", () => {
    const central = parseCentralVersions(`<Project><ItemGroup>
      <PackageVersion Include="Serilog" Version="3.1.1" />
      <PackageVersion Include="Polly" Version="8.2.0" />
    </ItemGroup></Project>`);
    const xml = `<Project><ItemGroup>
      <PackageReference Include="Serilog" />
      <PackageReference Include="Polly" VersionOverride="7.2.4" />
    </ItemGroup></Project>`;
    expect(parsePackageReferences(xml, central).map(l => `${l.name}@${l.version}`)).toEqual(["Serilog@3.1.1", "Polly@7.2.4"]);
  });
  test("test projects and PrivateAssets=all are dev", () => {
    const testProj = `<Project><ItemGroup>
      <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.9.0" />
      <PackageReference Include="xunit" Version="2.7.0" />
    </ItemGroup></Project>`;
    expect(parsePackageReferences(testProj).every(l => l.dev)).toBe(true);
    const analyzer = `<Project><ItemGroup>
      <PackageReference Include="StyleCop.Analyzers" Version="1.1.118" PrivateAssets="all" />
      <PackageReference Include="Serilog" Version="3.1.1" />
    </ItemGroup></Project>`;
    expect(parsePackageReferences(analyzer).map(l => !!l.dev)).toEqual([true, false]);
  });
});

test("parsePackagesConfig reads the legacy list", () => {
  const xml = `<?xml version="1.0"?><packages>
    <package id="EntityFramework" version="6.4.4" targetFramework="net48" />
    <package id="StyleCop" version="5.0.0" developmentDependency="true" />
  </packages>`;
  expect(parsePackagesConfig(xml)).toEqual([
    { name: "EntityFramework", version: "6.4.4", eco: "nuget" },
    { name: "StyleCop", version: "5.0.0", dev: true, eco: "nuget" },
  ]);
});

describe("detectNugetDeps (disk)", () => {
  test("finds nested projects, applies the root's central versions, skips bin/obj, dedups by id", async () => {
    await withTmp(async dir => {
      await writeFile(join(dir, "Directory.Packages.props"), `<Project><ItemGroup><PackageVersion Include="Serilog" Version="3.1.1" /></ItemGroup></Project>`);
      await mkdir(join(dir, "src", "Api"), { recursive: true });
      await writeFile(join(dir, "src", "Api", "Api.csproj"), `<Project><ItemGroup><PackageReference Include="Serilog" /><PackageReference Include="Dapper" Version="2.1.35" /></ItemGroup></Project>`);
      await mkdir(join(dir, "tests", "Api.Tests"), { recursive: true });
      await writeFile(join(dir, "tests", "Api.Tests", "Api.Tests.csproj"), `<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.9.0" /><PackageReference Include="serilog" /></ItemGroup></Project>`);
      await mkdir(join(dir, "src", "Api", "obj"), { recursive: true });
      await writeFile(join(dir, "src", "Api", "obj", "Ghost.csproj"), `<Project><ItemGroup><PackageReference Include="Ghost" Version="1.0.0" /></ItemGroup></Project>`);

      const libs = await detectNugetDeps(dir);
      const byName = Object.fromEntries(libs.map(l => [l.name, l]));
      expect(Object.keys(byName).sort()).toEqual(["Dapper", "Microsoft.NET.Test.Sdk", "Serilog"]);
      expect(byName.Serilog).toEqual({ name: "Serilog", version: "3.1.1", eco: "nuget" });   // prod use wins over the test project's
      expect(byName["Microsoft.NET.Test.Sdk"].dev).toBe(true);
    });
  });

  test("detectPackages merges NuGet libraries into the profile list", async () => {
    await withTmp(async dir => {
      await writeFile(join(dir, "App.csproj"), `<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup></Project>`);
      const r = await detectPackages(dir);
      expect(r.libraries).toContainEqual({ name: "Newtonsoft.Json", version: "13.0.3", eco: "nuget" });
    });
  });
});

test("project files and shared NuGet files count as dependency changes", () => {
  expect(isNugetManifest("Api.csproj")).toBe(true);
  expect(isNugetManifest("Lib.FSPROJ")).toBe(true);
  expect(isNugetManifest("Program.cs")).toBe(false);
  expect(isFreshnessHit("/p", "/p", "Api.csproj")).toBe(true);
  expect(isFreshnessHit("/p", "/p", "Directory.Packages.props")).toBe(true);
});

describe("packages.lock.json (#1333)", () => {
  const lock = JSON.stringify({
    version: 1,
    dependencies: {
      "net8.0": {
        Serilog: { type: "Direct", requested: "[4.*, )", resolved: "4.3.1", dependencies: {} },
        "Newtonsoft.Json": { type: "Transitive", resolved: "12.0.1" },
        "Swashbuckle.AspNetCore": { type: "Direct", requested: "[6.5.0, )", resolved: "6.5.0", dependencies: { "Newtonsoft.Json": "12.0.1" } },
        "MyApp.Core": { type: "Project", dependencies: { Serilog: "[4.*, )" } },
      },
    },
  });

  test("parseNugetLock: resolved nodes with direct flag and edges; Project entries skipped; bad JSON → nothing", () => {
    const nodes: string[] = [];
    const edges: string[] = [];
    parseNugetLock(lock, (n, v, d) => nodes.push(`${n}@${v}${d ? "*" : ""}`), (p, c) => edges.push(`${p}>${c}`));
    expect(nodes).toEqual(["Serilog@4.3.1*", "Newtonsoft.Json@12.0.1", "Swashbuckle.AspNetCore@6.5.0*"]);
    expect(edges).toEqual(["Swashbuckle.AspNetCore>Newtonsoft.Json"]);   // the Project entry contributes no edge either
    const none: string[] = [];
    parseNugetLock("{ not json", n => none.push(n));
    expect(none).toEqual([]);
  });

  test("the lockfile's resolved version replaces a floating spec; the tree carries transitive nodes and the chain", async () => {
    await withTmp(async dir => {
      await mkdir(join(dir, "src", "Api"), { recursive: true });
      await writeFile(join(dir, "src", "Api", "Api.csproj"), `<Project><ItemGroup><PackageReference Include="Serilog" Version="4.*" /><PackageReference Include="Swashbuckle.AspNetCore" Version="6.5.0" /></ItemGroup></Project>`);
      await writeFile(join(dir, "src", "Api", "packages.lock.json"), lock);

      const libs = await detectNugetDeps(dir);
      expect(libs.find(l => l.name === "Serilog")?.version).toBe("4.3.1");

      const tree = await enumerateDepTree(dir);
      expect(tree.filter(n => n.eco === "nuget").map(n => `${n.name}@${n.version}`).sort())
        .toEqual(["Newtonsoft.Json@12.0.1", "Serilog@4.3.1", "Swashbuckle.AspNetCore@6.5.0"]);
      const chain = chainTo(await dependentsGraph(dir), "Newtonsoft.Json", new Set(libs.map(l => l.name)));
      expect(chain).toEqual(["Swashbuckle.AspNetCore"]);
    });
  });

  test("a lockfile change counts as a dependency change", () => {
    expect(isFreshnessHit("/p", "/p", "packages.lock.json")).toBe(true);
  });
});
