// Language label → registry ecosystem key, consumed by registry.ts's
// latestVersions() and osv.ts's osvEcosystem(). No default: a language without a
// mapping (or without a native registry source) is skipped rather than guessed,
// because a cross-ecosystem match produces false positives. Shared by the vuln
// scan (vuln-scan.ts) and the dashboard's dep/audit routes (server.ts).
export const ecoMap: Record<string, string> = {
  TypeScript: "npm",
  JavaScript: "npm",
  Python: "pypi",
  Rust: "crates.io",
  Go: "go",
  "C++": "vcpkg",
  C: "vcpkg",
  Java: "maven",
  "C#": "nuget",
  PHP: "packagist",
  Ruby: "rubygems",
};
