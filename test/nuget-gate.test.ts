// NuGet in the `-(ask:lib)` advisor and the install gate (#1332): the
// `nuget:` prefix, the dotnet install command in the advice, and both shapes
// of the .NET add command parsed into a gated package — with the version read
// from its flag, and floating versions treated as blind.

import { describe, test, expect } from "bun:test";
import { parseInstallCommands, decideGate } from "../src/install-gate";
import { adviseLibraries, parseLibNames, installCmd } from "../src/lib-advisor";
import type { PkgVuln } from "../src/osv";

describe("parseInstallCommands — dotnet", () => {
  test("dotnet add package without a version → blind nuget package", () => {
    expect(parseInstallCommands("dotnet add package Serilog")).toEqual([{ name: "Serilog", version: "", eco: "nuget" }]);
  });
  test("--version / -v carry the pin; a project path before `package` is skipped", () => {
    expect(parseInstallCommands("dotnet add src/Api/Api.csproj package Serilog --version 4.3.1")).toEqual([{ name: "Serilog", version: "4.3.1", eco: "nuget" }]);
    expect(parseInstallCommands("dotnet add package Dapper -v 2.1.89 --no-restore")).toEqual([{ name: "Dapper", version: "2.1.89", eco: "nuget" }]);
  });
  test(".NET 10 form: dotnet package add NAME@VERSION, with value flags skipped", () => {
    expect(parseInstallCommands("dotnet package add Polly@8.2.0 --project src/Api")).toEqual([{ name: "Polly", version: "8.2.0", eco: "nuget" }]);
    expect(parseInstallCommands("dotnet package add -s https://api.nuget.org/v3/index.json Polly")).toEqual([{ name: "Polly", version: "", eco: "nuget" }]);
  });
  test("floating versions and --prerelease alone are blind", () => {
    expect(parseInstallCommands("dotnet add package Serilog --version 4.*")[0].version).toBe("");
    expect(parseInstallCommands("dotnet add package Serilog --prerelease")[0].version).toBe("");
  });
  test("non-package dotnet commands and mentions are not installs", () => {
    expect(parseInstallCommands("dotnet add reference ../Lib/Lib.csproj")).toEqual([]);
    expect(parseInstallCommands("dotnet restore && dotnet build")).toEqual([]);
    expect(parseInstallCommands(`echo "dotnet add package Serilog"`)).toEqual([]);
  });
});

test("the gate blocks a blind dotnet add with the dotnet command to re-issue", () => {
  const pkgs = parseInstallCommands("dotnet add package Serilog");
  const d = decideGate(pkgs, [{ name: "Serilog", verdict: "ok", suggest: "4.3.1", suggestAgeDays: 40, installCmd: installCmd("nuget", "Serilog", "4.3.1") }]);
  expect(d.hardBlocks).toBe(1);
  expect(d.blocks[0]).toContain("dotnet add package Serilog --version 4.3.1");
});

describe("advisor", () => {
  test("nuget: prefix routes the name to the nuget ecosystem", () => {
    expect(parseLibNames("nuget:Serilog nuget:Dapper@2.1.89")).toEqual([
      { name: "Serilog", eco: "nuget" },
      { name: "Dapper", eco: "nuget", pin: "2.1.89" },
    ]);
  });
  test("nuget is a supported history ecosystem, checked against OSV's NuGet feed", async () => {
    const now = new Date("2026-11-25T00:00:00Z");
    const ago = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
    const osvEcos: string[] = [];
    const [it] = await adviseLibraries("nuget", [{ name: "Dapper" }], {
      now,
      history: async () => [{ version: "2.1.100", date: ago(5) }, { version: "2.1.89", date: ago(30) }],
      osvCheck: async (osvEco, _n, version) => {
        osvEcos.push(osvEco);
        return { ok: true, version, vulns: 0, notices: 0, status: "safe", icon: "", message: "", severity: "none", topVuln: null, fixVersion: "", detailsUrl: "", advisories: [] } as PkgVuln;
      },
    });
    expect(it.verdict).toBe("ok");
    expect(it.suggest).toBe("2.1.89");
    expect(osvEcos).toEqual(["NuGet"]);
    expect(installCmd("nuget", "Dapper", "2.1.89")).toBe("dotnet add package Dapper --version 2.1.89");
  });
});
