// The one-line rendering of each `-(ask:lib)` verdict, extracted from
// hook-ask-rows.ts (audit round 10 wave 2 — the row table sits at its size
// budget). Pure: advisor items in, display lines out. Every verdict the advisor
// can return has a line here; an unknown verdict falls to the not-found voice,
// which never suggests a near-miss name (typo-squatting).

export interface LibAdviceItem {
  name: string;
  verdict: string;
  suggest?: string;
  suggestAgeDays?: number | null;
  latest?: string;
  latestAgeDays?: number | null;
  installCmd?: string;
  vulnNote?: string;
  steppedBack?: boolean;
  eco?: string;
  notices?: number;
  noticeNote?: string;
  deprecated?: boolean;
}

export function formatLibAdviceLines(items: LibAdviceItem[], L: (en: string, ar: string) => string): string[] {
  const age = (d: unknown) => (typeof d === "number" ? L(` (${d}d old)`, ` (عمرها ${d} يوم)`) : "");
  return items.map(it => {
    switch (it.verdict) {
      case "ok": {
        const stepped = it.steppedBack
          ? L(`\n    ⚠ newer matured release skipped — vulnerable (${it.vulnNote})`,
              `\n    ⚠ تجاوزنا نسخة أحدث ناضجة لأنها مثغورة (${it.vulnNote})`)
          : "";
        const fresh = (it.latest && it.latest !== it.suggest && !it.steppedBack)
          ? L(` · latest ${it.latest}${age(it.latestAgeDays)} not matured yet`,
              ` · الأحدث ${it.latest}${age(it.latestAgeDays)} لم تنضج بعد`)
          : "";
        // "OSV clean" is only said when it is the whole truth: a maintenance
        // notice (unmaintained/unsound) or a registry deprecation is not a CVE,
        // but it IS the thing to know before ADDING a library (#1110/#1111).
        const cert = it.deprecated
          ? L("— ⛔ DEPRECATED by its registry (no CVE) — pick a maintained alternative or decide explicitly", "— ⛔ مهجورة في سجلّها (بلا CVE) — اختر بديلًا مُصانًا أو قرّر صراحةً")
          : (it.notices
            ? L(`— ⚠ no CVE, but OSV notice: ${it.noticeNote || `${it.notices} maintenance notice(s)`} — not a clean bill for a new dependency`, `— ⚠ بلا CVE، لكن OSV يحمل إشعارًا: ${it.noticeNote || `${it.notices} إشعار صيانة`} — ليست شهادة نظافة لمكتبة جديدة`)
            : L("— OSV clean", "— نظيفة OSV"));
        return `  ${it.name} → ${it.suggest}${age(it.suggestAgeDays)} ${cert} · ${it.installCmd}${fresh}${stepped}`;
      }
      case "ok-unverified":
        return `  ${it.name} → ${it.suggest}${age(it.suggestAgeDays)} ${L("— ⚠ OSV did not answer; maturity only, NO security certificate", "— ⚠ لم يُجب OSV؛ اختيار نضج فقط بلا شهادة أمان")} · ${it.installCmd}`;
      case "no-clean":
        return `  ${it.name} — ${L(`no OSV-clean version among the newest matured releases (${it.vulnNote}). Not recommending a vulnerable version.`, `لا نسخة نظيفة ضمن أحدث النسخ الناضجة (${it.vulnNote}). لن أقترح نسخة مثغورة.`)}`;
      case "no-mature":
        return `  ${it.name} — ${L(`nothing matured yet: newest is ${it.latest}${age(it.latestAgeDays)}, under the 7-day rule. Wait or decide explicitly.`, `لا نسخة ناضجة بعد: الأحدث ${it.latest}${age(it.latestAgeDays)} تحت قاعدة الأيام السبعة. انتظر أو قرر صراحةً.`)}`;
      case "unsupported-eco":
        // Two honest messages, not one misleading blame (#673): an EMPTY eco
        // means project detection failed — say that, and hand over the prefix
        // escape hatch instead of "ecosystem ? not supported".
        return it.eco
          ? `  ${it.name} — ${L(`ecosystem "${it.eco}" not supported for version history (npm/pypi/crates/go only)`, `النظام "${it.eco}" غير مدعوم لتاريخ النسخ (npm/pypi/crates/go فقط)`)}`
          : `  ${it.name} — ${L("could not detect this project's ecosystem — prefix the name and re-ask: npm:/pypi:/crates:/go:", "لم أتعرّف على نظام هذا المشروع — أضِف بادئة للاسم وأعد السؤال: npm:/pypi:/crates:/go:")}`;
      case "need-full-path":
        return `  ${it.name} — ${L("Go needs the FULL module path (e.g. go:github.com/jackc/pgx/v5) — the proxy knows no short names, and guessing one is typo-squatting territory. Re-ask with the import path.", "Go يتطلب مسار الوحدة الكامل (مثل go:github.com/jackc/pgx/v5) — البروكسي لا يعرف الأسماء القصيرة، وتخمينها باب typo-squatting. أعد السؤال بمسار الاستيراد.")}`;
      case "invalid-name":
        return `  ${it.name} — ${L("invalid package name — refused", "اسم حزمة غير صالح — مرفوض")}`;
      case "registry-disabled":
        return `  ${it.name} — ${L("not looked up: registry checks are disabled on this DevLog (DEVLOG_REGISTRY_CHECK_DISABLED=1). Pick the version yourself.", "لم يُستعلَم عنها: فحوصات السجل معطّلة في هذا الـDevLog (DEVLOG_REGISTRY_CHECK_DISABLED=1). اختر النسخة بنفسك.")}`;
      default:
        return `  ${it.name} — ${L("not found under this EXACT name (or lookup failed). Verify the name yourself — no near-miss suggestions (typo-squatting).", "غير موجودة بهذا الاسم الحرفي (أو فشل الاستعلام). تحقق من الاسم بنفسك — لا اقتراح أسماء مشابهة (typo-squatting).")}`;
    }
  });
}
