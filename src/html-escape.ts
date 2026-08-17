// The single server-side HTML escaper (audit devex-2026-08-17 #964). Four
// drifting copies (client-report / release-html / release-preview / md-render)
// collapsed here so a fix lands once. Null-safe on purpose: `String(s ?? "")`
// turns null/undefined into "" instead of throwing inside a template literal —
// the previous md-render copy lacked that guard, so an absent doc field could
// crash the doc page instead of rendering blank. The browser twin lives in
// assets/dom-safe.js (C2); test/security-sinks.test.ts pins both layouts.
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}
