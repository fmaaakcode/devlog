// Minimal markdown → HTML renderer. Supports a deliberate subset:
//   - headings (# .. ######)
//   - paragraphs
//   - lists (- * +, ordered 1.)
//   - tables (GFM pipe syntax with header row)
//   - code blocks (``` fenced) and inline code (`x`)
//   - bold (**x**) and italic (*x*)
//   - links [text](url)
//   - callouts: > [!note], > [!warning], > [!info]
//   - horizontal rule (--- on its own line)
// Everything else is rendered as escaped text. The output is sanitized: no
// raw <script>, no on* handlers, no javascript: URLs.

const ALLOWED_PROTO = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

function safeUrl(raw: string): string {
  const u = raw.trim();
  if (ALLOWED_PROTO.test(u)) return u;
  // Reject javascript:, data:, vbscript:, etc.
  return "#";
}

// Inline parser: applies code → links → bold → italic in that order to avoid
// stomping on each other. Inputs are escaped first; processors operate on
// already-escaped strings and re-emit escaped output.
function inline(raw: string): string {
  let s = escapeHtml(raw);
  // inline code: `...`
  s = s.replace(/`([^`\n]+)`/g, (_, m) => `<code class="dl-code-inline">${m}</code>`);
  // links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const safe = safeUrl(url);
    return `<a href="${safe}">${text}</a>`;
  });
  // bold: **x**
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  // italic: *x* (avoid eating ** that already became <strong>)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return s;
}

interface ParseState {
  out: string[];
  i: number;
  lines: string[];
}

function parseTable(st: ParseState): boolean {
  const headerLine = st.lines[st.i];
  const sepLine = st.lines[st.i + 1] || "";
  // Header must contain at least one pipe; separator must be |---|---|
  if (!/\|/.test(headerLine)) return false;
  if (!/^\s*\|?\s*:?-{2,}:?(\s*\|\s*:?-{2,}:?)+\s*\|?\s*$/.test(sepLine)) return false;

  const cells = (line: string) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim());
  const headers = cells(headerLine);
  const rows: string[][] = [];
  st.i += 2;
  while (st.i < st.lines.length && /\|/.test(st.lines[st.i]) && st.lines[st.i].trim()) {
    rows.push(cells(st.lines[st.i]));
    st.i++;
  }
  let html = `<table class="dl-table">\n<thead><tr>`;
  for (const h of headers) html += `<th>${inline(h)}</th>`;
  html += `</tr></thead>\n<tbody>`;
  for (const r of rows) {
    html += `<tr>`;
    for (const c of r) html += `<td>${inline(c)}</td>`;
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  st.out.push(html);
  return true;
}

function parseCodeBlock(st: ParseState): boolean {
  const fence = st.lines[st.i].match(/^```\s*(\w*)\s*$/);
  if (!fence) return false;
  const lang = fence[1] || "";
  st.i++;
  const buf: string[] = [];
  while (st.i < st.lines.length && !/^```\s*$/.test(st.lines[st.i])) {
    buf.push(st.lines[st.i]);
    st.i++;
  }
  if (st.i < st.lines.length) st.i++; // consume closing fence
  st.out.push(`<pre class="dl-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
  return true;
}

function parseList(st: ParseState): boolean {
  const first = st.lines[st.i];
  const orderedRe = /^(\s*)(\d+)\.\s+(.*)$/;
  const unorderedRe = /^(\s*)[-*+]\s+(.*)$/;
  const isOrdered = orderedRe.test(first);
  const isUnordered = unorderedRe.test(first);
  if (!isOrdered && !isUnordered) return false;

  const tag = isOrdered ? "ol" : "ul";
  const items: string[] = [];
  let hasTask = false;
  // GFM checkbox: "- [ ] x" or "- [x] x" (only for unordered lists)
  const taskRe = /^\[([ xX])\]\s+(.*)$/;
  while (st.i < st.lines.length) {
    const line = st.lines[st.i];
    const m = isOrdered ? line.match(orderedRe) : line.match(unorderedRe);
    if (!m) break;
    const text = isOrdered ? m[3] : m[2];
    const task = !isOrdered ? text.match(taskRe) : null;
    if (task) {
      hasTask = true;
      const done = task[1].toLowerCase() === "x";
      const label = task[2];
      items.push(
        `<li class="dl-task" data-checked="${done}">` +
        `<input type="checkbox" disabled${done ? " checked" : ""}> ` +
        `<span>${inline(label)}</span></li>`
      );
    } else {
      items.push(`<li>${inline(text)}</li>`);
    }
    st.i++;
  }
  const cls = hasTask ? "dl-list dl-task-list" : "dl-list";
  st.out.push(`<${tag} class="${cls}">${items.join("")}</${tag}>`);
  return true;
}

function parseCallout(st: ParseState): boolean {
  const line = st.lines[st.i];
  if (!/^>/.test(line)) return false;

  // GFM-style typed callout: "> [!warning] body". Any other "> ..." is a
  // generic blockquote and renders as a default callout (no kind class).
  const typed = line.match(/^>\s*\[!(\w+)\]\s*(.*)$/);
  let cls = "note";
  const buf: string[] = [];
  if (typed) {
    const kind = typed[1].toLowerCase();
    const known = ["note", "warning", "info", "tip", "important"];
    cls = known.includes(kind) ? kind : "note";
    if (typed[2]) buf.push(typed[2]);
    st.i++;
  } else {
    cls = "note";
    buf.push(line.replace(/^>\s?/, ""));
    st.i++;
  }
  while (st.i < st.lines.length && /^>\s?(.*)$/.test(st.lines[st.i])) {
    // Stop if the next line starts a new typed callout
    if (/^>\s*\[!\w+\]/.test(st.lines[st.i])) break;
    buf.push(st.lines[st.i].replace(/^>\s?/, ""));
    st.i++;
  }
  st.out.push(`<div class="dl-callout dl-callout-${cls}"><p>${inline(buf.join(" "))}</p></div>`);
  return true;
}

function parseHeading(st: ParseState): boolean {
  const m = st.lines[st.i].match(/^(#{1,6})\s+(.*)$/);
  if (!m) return false;
  const level = m[1].length;
  st.out.push(`<h${level} class="dl-h${level}">${inline(m[2].trim())}</h${level}>`);
  st.i++;
  return true;
}

function parseHr(st: ParseState): boolean {
  if (!/^---+\s*$/.test(st.lines[st.i])) return false;
  st.out.push(`<hr class="dl-hr">`);
  st.i++;
  return true;
}

function parseBlank(st: ParseState): boolean {
  if (st.lines[st.i].trim() !== "") return false;
  st.i++;
  return true;
}

function parseParagraph(st: ParseState): void {
  const buf: string[] = [];
  while (st.i < st.lines.length) {
    const line = st.lines[st.i];
    if (line.trim() === "") break;
    if (/^#{1,6}\s/.test(line)) break;
    if (/^```/.test(line)) break;
    if (/^>\s/.test(line)) break;
    if (/^---+\s*$/.test(line)) break;
    if (/^\s*([-*+]|\d+\.)\s/.test(line)) break;
    buf.push(line);
    st.i++;
  }
  if (buf.length) st.out.push(`<p>${inline(buf.join(" "))}</p>`);
}

export function renderMarkdown(md: string): string {
  // Strip any raw <script> or on* attributes before parsing — defense in depth.
  const clean = md
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  const st: ParseState = { out: [], i: 0, lines: clean.split(/\r?\n/) };
  while (st.i < st.lines.length) {
    const before = st.i;
    if (parseBlank(st)) continue;
    if (parseCodeBlock(st)) continue;
    if (parseHeading(st)) continue;
    if (parseHr(st)) continue;
    if (parseCallout(st)) continue;
    if (parseTable(st)) continue;
    if (parseList(st)) continue;
    parseParagraph(st);
    // Safety net: if no parser advanced (unrecognized syntax), drop the line
    // as a paragraph so we never spin forever.
    if (st.i === before) {
      const line = st.lines[st.i];
      if (line.trim()) st.out.push(`<p>${inline(line)}</p>`);
      st.i++;
    }
  }
  return st.out.join("\n");
}
