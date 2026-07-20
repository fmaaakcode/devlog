// The deps explainer page (#663): every manifest library annotated with its
// recorded purpose line (`-(lib) name — غرض`), the registry's official
// one-liner, and its vuln/outdated status — all from GET /api/deps. Standalone
// on purpose: no dashboard-core import, so the page carries zero dashboard
// state and stays a plain read-only viewer.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Registry page per ecosystem — navigation links only (CSP connect-src stays 'self').
const REGISTRY_URL = {
  npm: (n) => `https://www.npmjs.com/package/${encodeURIComponent(n)}`,
  "crates.io": (n) => `https://crates.io/crates/${encodeURIComponent(n)}`,
  pypi: (n) => `https://pypi.org/project/${encodeURIComponent(n)}/`,
  go: (n) => `https://pkg.go.dev/${n.split("/").map(encodeURIComponent).join("/")}`,
  packagist: (n) => `https://packagist.org/packages/${n.split("/").map(encodeURIComponent).join("/")}`,
};

const sevColor = { critical: "#ff1744", high: "#ff5252", moderate: "#ff9800", low: "#ffd93d" };

function card(l) {
  const url = REGISTRY_URL[l.eco]?.(l.name);
  const name = url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="فتح صفحة المكتبة">${esc(l.name)}</a>`
    : esc(l.name);
  // Every interpolation below passes esc(); numbers are coerced explicitly so a
  // malformed payload can't smuggle markup through a "number" field. Colors come
  // from the fixed sevColor map only — the raw severity string never reaches HTML.
  const vuln = l.vulns
    ? `<span class="badge vuln" style="color:${sevColor[(l.severity || "").toLowerCase()] || "var(--pink)"}">⚠ ${Number(l.vulns) || 0} ثغرة</span>`
    : "";
  const outdated = l.isLatest === false && l.latestVersion
    ? `<span class="latest" title="النسخة الأحدث">&#8635; ${esc(l.latestVersion)}</span>`
    : "";
  const purpose = l.purpose
    ? `<div class="purpose">${esc(l.purpose)}</div>`
    : `<div class="purpose missing">بلا غرض مسجَّل — اطلب من كلود: <span dir="ltr">-(ask:deps)</span></div>`;
  const desc = l.description ? `<div class="desc">${esc(l.description)}</div>` : "";
  const cls = l.vulns ? "card danger" : (l.isLatest === false ? "card stale" : "card");
  return `<div class="${cls}" data-search="${esc(`${l.name} ${l.purpose || ""} ${l.description || ""}`.toLowerCase())}">
    <div class="row1">
      ${outdated}${vuln}${l.dev ? '<span class="badge">dev</span>' : ""}
      <span class="ver">${esc(l.version)}</span>
      <span class="name">${name}</span>
    </div>
    ${purpose}${desc}
  </div>`;
}

async function load() {
  const project = new URLSearchParams(location.search).get("project") || "";
  const status = document.getElementById("status");
  const list = document.getElementById("list");
  document.getElementById("projName").textContent = project;
  document.title = `مكتبات ${project}`;
  if (!project) { status.textContent = "لا مشروع محدد — افتح الصفحة من زر dependencies في الداشبورد."; return; }
  let payload;
  try {
    const r = await fetch(`/api/deps?project=${encodeURIComponent(project)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    payload = await r.json();
  } catch (e) {
    status.textContent = `تعذّر تحميل المكتبات: ${e.message}`;
    return;
  }
  if (!payload.project) { status.textContent = "مشروع غير معروف."; return; }
  if (!payload.libraries.length) { status.textContent = "لا مكتبات معروفة للمشروع بعد (تظهر بعد أول فحص)."; return; }

  const cov = document.getElementById("coverage");
  const total = Number(payload.total) || 0;
  const withPurpose = Number(payload.withPurpose) || 0;
  cov.innerHTML = withPurpose === total
    ? `التغطية كاملة — <b>${total}</b> مكتبة بغرض مسجَّل`
    : `<b>${total - withPurpose}</b> من ${total} بلا غرض مسجَّل`;

  list.innerHTML = payload.libraries.map(card).join("");
  status.hidden = true;
  list.hidden = false;

  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const el of list.children) el.hidden = q !== "" && !el.dataset.search.includes(q);
  });
}

load();
