// Shared token-resolution primitive (audit 2026-08-14 C1). The design rule is
// "no raw hex outside token definitions", but three places can't take CSS
// var() syntax: canvas fillStyle/strokeStyle/shadowColor, `${hex}${alpha}`
// concatenation into #RRGGBBAA, and markup generated for a popup document
// that never loads this page's stylesheet. cssVar() resolves the token from
// the CURRENT page's :root once, so those spots still have a single source of
// truth. Zero state on purpose, same charter as dom-safe.js.
export function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v || "").trim() || fallback;
}
