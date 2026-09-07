// Shared HTML-safety primitives (audit 2026-08-14 C2). esc() is the ONE
// barrier between external content (tags, registry data, DEVLOG_STACK.md) and
// innerHTML on every page — and it lived as three drifting copies in
// dashboard-core.js / stack-map.js / deps.js, so a hardening fix applied to
// one silently left the other two (the same divergence already bit the
// security tags three times: #235, #159, 2026-07-17). Zero state on purpose:
// standalone pages (deps.js) import it without dragging dashboard state along.

// String(s ?? "") — a non-string (number from a new API field, imported legacy
// shape) must escape, not throw mid-render inside an innerHTML template.
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Params for the shared «server refused» message (err.http): the JSON {error}
// the server sent when it sent one, else the status text. One reader for every
// page's mutating fetch (#1142/#1148/#1151/#1154/#1158) — fetch resolves on
// 4xx/5xx, so a caller that only catches never sees these.
export async function httpErrorDetail(res) {
  let msg = "";
  try {
    const j = await res.clone().json();
    if (typeof j?.error === "string") msg = j.error;
  } catch { /* non-JSON body — the status alone carries the message */ }
  return { status: res.status, msg: msg || res.statusText || "" };
}

// Allow only http(s) links; blocks javascript:/data: URIs coming from an
// untrusted git remote (.git/config) or vuln API (security audit D3).
export function safeHref(url) {
  const u = String(url || "").trim();
  return /^https?:\/\//i.test(u) ? u : "#";
}
