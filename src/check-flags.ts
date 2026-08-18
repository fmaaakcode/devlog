// Environment kill-switches for the outbound dependency checks. Single source:
// these were derived independently in vuln-scan.ts and routes-standards.ts —
// same variable, same value, two definitions that could drift apart.
//
// DEVLOG_REGISTRY_CHECK_DISABLED=1 — skip registry version lookups (npm/crates/…).
// DEVLOG_VULN_CHECK_DISABLED=1     — skip OSV vulnerability scanning.
export const REGISTRY_CHECK_DISABLED = process.env.DEVLOG_REGISTRY_CHECK_DISABLED === "1";
export const VULN_CHECK_DISABLED = process.env.DEVLOG_VULN_CHECK_DISABLED === "1";

// Live readers for the same two switches. The constants above are frozen at
// import; hook processes (pre-standards.js, parse-tags.ts) and tests that flip
// the variable at runtime need the current value — one place, same spelling.
export const registryCheckDisabled = (): boolean => process.env.DEVLOG_REGISTRY_CHECK_DISABLED === "1";
export const vulnCheckDisabled = (): boolean => process.env.DEVLOG_VULN_CHECK_DISABLED === "1";
