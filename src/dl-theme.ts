// One :root token block for every generated standalone page — release pages
// (release-html.ts), the client report (client-report.ts) and doc:* pages
// (doc-templates.ts). Surfaces mirror the dashboard palette
// (assets/dashboard.css :root) so a jump from the dashboard to any generated
// page reads as the same product — the old navy-blue scheme was a visible
// seam, and audit 2026-08-14 C5 found doc-templates still shipping it after
// the other two had moved. Kind accents match the dashboard accent set
// (emerald/blue/gold); security aligns to its pink.

/** The shared `:root { … }` block, ready to embed at the top of a generated
 *  stylesheet. A page needing extra names aliases onto these
 *  (`--ink:var(--text)`) instead of re-stating hex — colour hex lives here
 *  and in dashboard.css only. */
export const DL_THEME_ROOT = `:root {
    --bg:#161718; --bg2:#161718; --bg3:#1B1C1D; --border:#363737;
    --text:#EEEEEE; --text2:#9A9A9A;
    --c-built:#06d6a0; --c-fix:#118ab2; --c-security:#ef476f;
    --c-refactor:#9A9A9A; --c-update:#ffd166; --c-decision:#06b6d4;
    --c-insight:#a78bfa; --c-note:#cbd5e1;
  }`;
