// Doc templates: render markdown content into a standalone HTML page that
// follows the dl-* convention from DEVLOG_HTML_SPEC v1.0. Same theme as
// release pages so the host site can apply one stylesheet for both.

import { renderMarkdown, escapeHtml } from "./md-render";

export const SPEC_VERSION = "1.0";
export const MAX_DOC_BYTES = 50_000;

export type DocType = "report" | "analysis" | "plan" | "comparison" | "readme";
export const DOC_TYPES: readonly DocType[] = ["report", "analysis", "plan", "comparison", "readme"] as const;

const TYPE_LABEL: Record<DocType, string> = {
  report: "تقرير",
  analysis: "تحليل",
  plan: "خطة",
  comparison: "مقارنة",
  readme: "دليل",
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ar", { year: "numeric", month: "long", day: "numeric" });
  } catch { return iso; }
}

function docCss(): string {
  return `
  :root {
    --bg:#0a1820; --bg2:#0f2530; --bg3:#143040; --border:#1f4458;
    --text:#e8f1f5; --text2:#8aa9b8;
    --c-built:#06d6a0; --c-fix:#118ab2; --c-security:#ff3344;
    --c-update:#ffd166; --c-decision:#06b6d4; --c-insight:#a78bfa;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Tahoma,Arial,sans-serif; line-height:1.7; }
  #dl-root { max-width:880px; margin:0 auto; padding:40px 24px 80px; }

  .dl-doc-header { border-bottom:1px solid var(--border); padding-bottom:18px; margin-bottom:28px; }
  .dl-doc-type { display:inline-block; color:var(--c-update); font-family:"Cascadia Code",Consolas,monospace; font-size:0.75em; padding:2px 10px; border:1px solid var(--c-update); border-radius:6px; margin-bottom:8px; }
  .dl-doc-title { margin:0 0 6px; font-size:1.7em; }
  .dl-doc-meta { color:var(--text2); font-size:0.85em; }

  .dl-doc-body { font-size:0.96em; }
  .dl-doc-body > * { margin-top:0; margin-bottom:14px; }
  .dl-doc-body > h1,.dl-doc-body > h2,.dl-doc-body > h3,
  .dl-doc-body > h4,.dl-doc-body > h5,.dl-doc-body > h6 { margin-top:28px; }

  .dl-h1 { font-size:1.5em; padding-right:10px; border-right:3px solid var(--c-update); }
  .dl-h2 { font-size:1.25em; padding-right:10px; border-right:3px solid var(--c-decision); }
  .dl-h3 { font-size:1.08em; color:var(--text2); }
  .dl-h4,.dl-h5,.dl-h6 { font-size:0.95em; color:var(--text2); }

  .dl-list { padding-right:22px; }
  .dl-list li { margin-bottom:5px; }
  .dl-task-list { list-style:none; padding-right:8px; }
  .dl-task { display:flex; align-items:flex-start; gap:8px; padding:4px 8px; border-right:2px solid var(--border); margin-bottom:4px; border-radius:4px; }
  .dl-task[data-checked="true"] { border-right-color:var(--c-built); }
  .dl-task[data-checked="true"] span { color:var(--text2); text-decoration:line-through; }
  .dl-task input[type="checkbox"] { margin-top:5px; accent-color:var(--c-built); }

  .dl-code-inline { background:var(--bg3); padding:1px 6px; border-radius:4px; font-family:"Cascadia Code",Consolas,monospace; font-size:0.88em; color:var(--c-update); }
  .dl-code { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:14px 16px; overflow-x:auto; font-size:0.85em; line-height:1.55; direction:ltr; text-align:left; }
  .dl-code code { font-family:"Cascadia Code",Consolas,monospace; color:var(--text); }

  .dl-table { border-collapse:collapse; width:100%; font-size:0.9em; }
  .dl-table th,.dl-table td { border:1px solid var(--border); padding:8px 12px; text-align:right; }
  .dl-table thead th { background:var(--bg3); color:var(--text); font-weight:600; }
  .dl-table tbody tr:nth-child(odd) td { background:var(--bg2); }

  .dl-callout { border-right:3px solid var(--text2); background:var(--bg2); padding:10px 14px; border-radius:6px; }
  .dl-callout p { margin:0; }
  .dl-callout-note      { border-right-color:var(--c-decision); }
  .dl-callout-info      { border-right-color:var(--c-decision); }
  .dl-callout-tip       { border-right-color:var(--c-built); }
  .dl-callout-warning   { border-right-color:var(--c-security); }
  .dl-callout-important { border-right-color:var(--c-update); }

  .dl-hr { border:0; border-top:1px solid var(--border); margin:24px 0; }

  a { color:var(--c-update); }
  a:hover { color:var(--c-built); }

  footer { color:var(--text2); font-size:0.75em; text-align:center; margin-top:40px; padding-top:18px; border-top:1px solid var(--border); }
  footer code { font-family:"Cascadia Code",Consolas,monospace; color:var(--c-built); }
  `.trim();
}

interface DocMeta {
  type: DocType;
  name: string;
  project: string;
  createdAt: string;
  updatedAt: string;
}

export function renderDocHtml(meta: DocMeta, markdownBody: string): string {
  const body = renderMarkdown(markdownBody);
  const typeLabel = TYPE_LABEL[meta.type];
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(meta.project)} · ${escapeHtml(meta.name)}</title>
<style>${docCss()}</style>
</head>
<body>
<main id="dl-root" class="dl-doc dl-doc-${meta.type}" data-spec-version="${SPEC_VERSION}" data-doc-type="${meta.type}">

  <header class="dl-doc-header">
    <span class="dl-doc-type">${escapeHtml(typeLabel)}</span>
    <h1 class="dl-doc-title">${escapeHtml(meta.name)}</h1>
    <div class="dl-doc-meta">
      <span><b>المشروع:</b> ${escapeHtml(meta.project)}</span>
      &middot;
      <time datetime="${escapeHtml(meta.createdAt.split("T")[0])}">${escapeHtml(fmtDate(meta.createdAt))}</time>
      ${meta.updatedAt !== meta.createdAt ? `&middot; <span>محدّث ${escapeHtml(fmtDate(meta.updatedAt))}</span>` : ""}
    </div>
  </header>

  <div class="dl-doc-body">
${body}
  </div>

  <footer>
    تم التوليد بواسطة <code>DevLog</code> · <code>doc:${meta.type}</code>
  </footer>

</main>
</body>
</html>`;
}

// Slug generation: lowercase, alphanumeric + hyphens, max 80 chars.
export function docSlug(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "doc";
}
