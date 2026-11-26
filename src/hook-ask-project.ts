// The "what is this project?" pull rows: `-(ask:about)` (description + facts +
// drift, #1342/#1344) and `-(ask:deps)` (libraries + purposes). Split out of
// hook-ask-rows.ts, which sat at the file-size ceiling; the two rows answer the
// same newcomer's question from two depths, so they live together. Spread into
// ASK_ROWS at ask:deps' old position — answer order is unchanged.
//
// The ask:deps formatter was MOVED, not rewritten; the only change is the
// per-folder grouping and the orphan wording (#1344). See the header of
// hook-ask-rows.ts on why rewording a formatter is a protocol change.

import type { AskData, AskRow } from "./hook-asks";

type Row = AskData;
const day = (s?: string): string => String(s || "").slice(0, 10);

export const PROJECT_ASK_ROWS: AskRow[] = [
  // ── -(ask:about) — what the project is, and how far to trust the text ─────
  // SessionStart only says `about: yes`; this serves the text itself, then the
  // scanner's facts as a second opinion, then the drift warnings.
  {
    key: "ask:about",
    label: "about",
    re: /^[ \t]*-\s*\(ask:about\)[ \t]*$/gm,
    path: "/api/about",
    logLine: d => `ask:about: served (${String(d.about || "").length} chars, drift ${(d.drift?.missingLibs || []).length})`,
    format: (d, _m, ctx) => {
      const L = ctx.L;
      if (!d.project) return L("This folder is not a tracked project.", "هذا المجلد ليس مشروعًا متتبَّعًا.");
      const f = d.facts || {};
      const drift = d.drift || {};
      const out: string[] = [L(`About: ${d.project}`, `عن المشروع: ${d.project}`)];
      if (d.desc) out.push(`desc: ${d.desc}`);

      if (d.about) {
        const when = d.aboutAt ? L(` (written ${day(d.aboutAt)})`, ` (كُتب ${day(d.aboutAt)})`) : "";
        out.push("", L(`Description${when}:`, `الوصف${when}:`), String(d.about));
      } else {
        out.push("", L("No description yet — write `.devlog/ABOUT.md` (what it is + the stack), or one paragraph with -(about).",
                       "لا وصف بعد — اكتب `.devlog/ABOUT.md` (ما هو + الستاك)، أو فقرة واحدة بـ-(about)."));
      }

      const libs = f.libraries || {};
      const stack = [f.language, f.framework, f.runtime].filter(Boolean).join(" · ");
      const libLine = L(`libraries: ${libs.runtime ?? 0} runtime · ${libs.dev ?? 0} dev${libs.forced ? ` · ${libs.forced} forced` : ""}`,
                        `المكتبات: ${libs.runtime ?? 0} تشغيل · ${libs.dev ?? 0} تطوير${libs.forced ? ` · ${libs.forced} مفروضة` : ""}`);
      out.push("", L("What the scan sees:", "ما يراه الفحص:"));
      if (stack) out.push(`  ${stack}`);
      out.push(`  ${L(`${f.totalFiles ?? 0} files`, `${f.totalFiles ?? 0} ملف`)} · ${libLine}`);
      if ((f.directories || []).length) out.push(`  ${L("top folders", "أهم المجلدات")}: ${f.directories.join(" · ")}`);
      if ((f.dirs || []).length) {
        out.push(`  ${L("manifests in", "مانيفستات في")}: ${f.dirs.map((x: string) => x || L("(root)", "(الجذر)")).join(" · ")} — ${L("check which is the system before counting its libraries", "تحقّق أيها النظام قبل عدّ مكتباته")}`);
      }

      const warns: string[] = [];
      if (drift.releasesSince >= 5) {
        warns.push(L(`  ⚠ The description is ${drift.releasesSince} releases old — check it against the code before relying on it.`,
                     `  ⚠ الوصف أقدم من ${drift.releasesSince} إصدارًا — قارنه بالكود قبل الاعتماد عليه.`));
      }
      if ((drift.missingLibs || []).length) {
        warns.push(L(`  ⚠ The description names libraries the manifest no longer has: ${drift.missingLibs.join(", ")}`,
                     `  ⚠ الوصف يذكر مكتبات لم تعد في المانيفست: ${drift.missingLibs.join("، ")}`));
      }
      if ((drift.stalePurposes || []).length) {
        warns.push(L(`  ⚠ -(lib) purposes kept for libraries no longer in the manifest: ${drift.stalePurposes.join(", ")} (details: -(ask:deps))`,
                     `  ⚠ أغراض -(lib) باقية لمكتبات لم تعد في المانيفست: ${drift.stalePurposes.join("، ")} (التفاصيل: -(ask:deps))`));
      }
      if (warns.length) {
        out.push("", L("Drift:", "انجراف:"), ...warns,
          L("  Propose the corrected description to the user; on approval rewrite `.devlog/ABOUT.md` directly.",
            "  اقترح على المستخدم الوصف المصحَّح؛ وبعد موافقته أعد كتابة `.devlog/ABOUT.md` مباشرة."));
      }
      out.push("", L("Deeper: -(ask:map) code · -(ask:features) capabilities · -(ask:deps) libraries",
                     "للتعمق: -(ask:map) الكود · -(ask:features) القدرات · -(ask:deps) المكتبات"));
      return out.join("\n");
    },
  },

  // ── -(ask:deps) — dependency inventory + purpose coverage ─────────────────
  // Every manifest library with its recorded purpose (`-(lib)`, latest wins)
  // and the registry one-liner the vuln scan cached. Uncovered ones listed so
  // the gap is visible; the footer says how to close it.
  {
    key: "ask:deps",
    label: "deps",
    re: /^[ \t]*-\s*\(ask:deps\)[ \t]*$/gm,
    path: "/api/deps",
    logLine: d => `ask:deps: served ${(d.libraries || []).length} item(s)`,
    format: (d, _m, ctx) => {
      const { libraries = [], forced = [], total = 0, withPurpose = 0, orphans = [], dirs = [] } = d as { libraries?: Row[]; forced?: Row[]; total?: number; withPurpose?: number; orphans?: Row[]; dirs?: string[] };
      const line = (l: Row) => {
        const dev = l.dev ? " (dev)" : "";
        const desc = l.description ? ` · ${String(l.description).slice(0, 120)}` : "";
        return l.purpose
          ? `  ✓ ${l.name}@${l.version}${dev} — ${l.purpose}${desc}`
          : `  ∅ ${l.name}@${l.version}${dev} — ${ctx.L("no purpose recorded", "بلا غرض مسجَّل")}${desc}`;
      };
      // More than one manifest folder: group by folder, so a finished
      // experiment's libraries never read as the system's (#1344).
      const listing = dirs.length > 1
        ? dirs.map(dir => {
            const head = dir ? ctx.L(`  [folder ${dir}/]`, `  [مجلد ${dir}/]`) : ctx.L("  [project root]", "  [جذر المشروع]");
            return `${head}\n${libraries.filter(l => (l.dir || "") === dir).map(line).join("\n")}`;
          }).join("\n")
        : libraries.map(line).join("\n");
      const uncovered = total - withPurpose;
      const footer = uncovered > 0
        ? ctx.L(`\n  ${uncovered} without a purpose — draft one line each, get the user's approval, then record each with \`-(lib) <name> — <purpose>\`.`,
                `\n  ${uncovered} بلا غرض — اقترح سطرًا لكل واحدة، خذ موافقة المستخدم، ثم سجّل كل واحدة بـ\`-(lib) <الاسم> — <الغرض>\`.`)
        : "";
      // Purposes recorded for names outside the manifest (#1115). The commonest
      // cause turned out to be a library REMOVED since (#1344: kb kept three),
      // so that reading leads; a typo or a CDN library are the other two.
      const orphanBlock = orphans.length
        ? `\n${ctx.L(`Purposes recorded for names NOT in the manifest (${orphans.length}) — removed from the project? the purpose is stale history; typo? re-emit under the right name; CDN/vendored? fine as is:`, `أغراض مسجَّلة لأسماء ليست في المانيفست (${orphans.length}) — أُزيلت من المشروع؟ فالغرض تاريخ بائت؛ خطأ إملائي؟ أعد الإصدار بالاسم الصحيح؛ CDN/مضمَّنة؟ تبقى كما هي:`)}\n${orphans.map((o: Row) => `  ⌀ ${o.name} — ${o.purpose}`).join("\n")}`
        : "";
      const body = libraries.length
        ? `${ctx.L(`Project libraries (${total}, ${withPurpose} with a recorded purpose):`, `مكتبات المشروع (${total}، منها ${withPurpose} بغرض مسجَّل):`)}\n${listing}${footer}`
        : ctx.L("No libraries known for this project yet (they appear after the first scan).",
                "لا مكتبات معروفة للمشروع بعد (تظهر بعد أول فحص).");
      const forcedBlock = forced.length
        ? `\n${ctx.L(`Indirect libraries with a forced version (overrides) (${forced.length}):`, `مكتبات فرعية مفروضة النسخة في overrides (${forced.length}):`)}\n${forced.map(line).join("\n")}`
        : "";
      return body + forcedBlock + orphanBlock;
    },
  },
];
