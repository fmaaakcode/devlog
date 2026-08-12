// The pull-command table. One row per `-(ask:*)` / `-(audit)` command: how to
// recognize it, which endpoint answers it, and how its answer is rendered for
// Claude. The generic serving loop lives in ./hook-asks — this file is data.
//
// Every formatter below was MOVED verbatim from parse-tags.ts, not rewritten.
// They carry decisions that reading them fresh would not reproduce: which
// fallback sentence tells Claude what to do when the list is empty, which
// wording steers it to the right next tag, which fields are optional because
// older stores lack them. Rewording one of these is a protocol change, not a
// cleanup.
//
// Order matters only in that the first row with an unserved occurrence wins the
// turn (blockContinue exits); the next continuation serves the next command.
// `-(ask:rules)` is deliberately NOT here: it reads the standards library off
// local disk, runs lifecycle commands and posts telemetry — a different shape
// that a fetch-and-format row would only pretend to cover.

import type { AskCtx, AskData, AskHit, AskRow } from "./hook-asks";
import { weightBar } from "./project-map";

/** One item as the endpoints hand it back — see AskData for why this stays
 *  untyped: the daemon answering may predate the hook asking. */
type Row = AskData;

const day = (s?: string): string => String(s || "").slice(0, 10);
const stamp = (s?: string): string => String(s || "").slice(0, 16).replace("T", " ");
/** Attribution (#695): stored raw ("claude-opus-4-8"); display drops the vendor
 *  prefix. Absent on pre-#695 history — shows nothing, never "unknown". */
const who = (m: unknown): string => (typeof m === "string" && m ? String(m).replace(/^claude-/, "") : "");

export const ASK_ROWS: AskRow[] = [
  // ── -(audit) — on-demand vuln report ──────────────────────────────────────
  // Heavy lifting (tree scan + OSV) lives in the server's /api/audit; here we
  // just relay. Re-runnable across turns because an audit tool MUST be: scan,
  // fix, scan again. Long timeout: the scan walks the lockfile tree.
  {
    key: "audit",
    label: "audit",
    re: /^[ \t]*-\s*\(audit\)(?:[ \t]+([^\n]+))?[ \t]*$/gm,
    cmd: m => `audit${m[1] ? ` ${m[1].trim()}` : ""}`,
    path: "/api/audit",
    qs: m => (m[1]?.trim() ? `&pkg=${encodeURIComponent(m[1].trim())}` : ""),
    timeoutMs: 120000,
    raw: true,
    skipIfEmpty: true,
    logLine: (_d, m) => `audit: served (${m[1]?.trim() || "all"})`,
  },

  // ── -(ask:open) — the live open list (#317) ───────────────────────────────
  // Authoritative from /api/open-items (the same resolver as the SessionStart
  // summary), so Claude never closes against a stale snapshot.
  {
    key: "ask:open",
    label: "open",
    re: /^[ \t]*-\s*\(ask:open\)[ \t]*$/gm,
    path: "/api/open-items",
    logLine: d => `ask:open: served ${(d.items || []).length} item(s)`,
    format: (d, _m, ctx) => {
      const items: Row[] = d.items || [];
      // «قادمة» rides its own section so the committed lists stay an exact
      // mirror of what the guards enforce. Every line carries its opening
      // date+time (the "when was this added?" answer, per user request).
      const since = (it: Row) => (it.openedAt ? ` [${stamp(it.openedAt)}]` : "");
      const groups: Record<string, Row[]> = {};
      const upcoming: Row[] = [];
      for (const it of items) {
        if (it.upcoming) { upcoming.push(it); continue; }
        groups[it.tag] ||= [];
        groups[it.tag].push(it);
      }
      const line = (it: Row) => `  #${it.num} ${it.content}${it.planTitle ? ` (${it.planTitle})` : ""}${since(it)}`;
      const section = (label: string, arr: Row[]) => (arr?.length ? `\n${label}:\n${arr.map(line).join("\n")}` : "");
      const sec = [...(groups.security || []), ...(groups["security:own"] || []), ...(groups["security:dep"] || [])];
      const body = [
        section(ctx.L("Open bugs", "بقات مفتوحة"), groups["bug found"]),
        section(ctx.L("Open security", "ثغرات مفتوحة"), sec),
        section(ctx.L("Open todos", "مهام مفتوحة"), groups.todo),
        section(ctx.L("Open plan steps", "خطوات خطط مفتوحة"), groups["plan-step"]),
        section(ctx.L("Upcoming (deferred — never block anything)", "قادمة (مؤجلة — لا توقف شيئًا)"), upcoming),
      ].filter(Boolean).join("\n");
      return body || ctx.L("No open items.", "لا عناصر مفتوحة.");
    },
  },

  // ── -(ask:closed) [#N] — was it closed, when, and how? ────────────────────
  // Companion to ask:open: DevLog stored WHETHER an item is closed but Claude
  // couldn't see WHEN/HOW, so it re-investigated finished work.
  {
    key: "ask:closed",
    label: "closed",
    re: /^[ \t]*-\s*\(ask:closed\)(?:[ \t]+#(\d+))?[ \t]*$/gm,
    cmd: m => `ask:closed${m[1] ? ` #${m[1]}` : ""}`,
    path: "/api/closed-items",
    qs: m => (m[1] ? `&num=${m[1]}` : ""),
    logLine: (d, m) => `ask:closed: served ${(d.items || []).length} item(s)${m[1] ? ` for #${m[1]}` : ""}`,
    format: (d, m, ctx) => {
      const items: Row[] = d.items || [];
      const num = m[1];
      const when = (it: Row) => (it.closedAt ? stamp(it.closedAt)
        : ctx.L("completed in plan (no timestamp)", "مكتمل في الخطة (بلا وقت مسجّل)"));
      const opened = (it: Row) => (it.openedAt ? stamp(it.openedAt) : "");
      if (num) {
        if (!items.length) {
          return ctx.L(
            `#${num} is not among the closed items — it may still be open (try -(ask:open)) or the number doesn't exist.`,
            `#${num} ليس ضمن المغلق — قد يكون مفتوحاً (جرّب -(ask:open)) أو رقماً غير موجود.`);
        }
        const it = items[0];
        const by = it.closedBy ? ` -(${it.closedBy})` : "";
        const plan = it.planTitle ? ` [${it.planTitle}]` : "";
        const openerWho = who(it.model) ? ctx.L(` — by ${who(it.model)}`, ` — بواسطة ${who(it.model)}`) : "";
        const closerWho = who(it.closerModel) ? ctx.L(` — by ${who(it.closerModel)}`, ` — بواسطة ${who(it.closerModel)}`) : "";
        const openedLine = opened(it) ? ctx.L(`\nOpened: ${opened(it)}${openerWho}`, `\nفُتح: ${opened(it)}${openerWho}`) : "";
        // Contextual memory: the fix-time reasoning, closer's first (the
        // "why this way?"), opener's as fallback (how it was described).
        const c = typeof it.closerContext === "string" && it.closerContext
          ? { src: ctx.L("fix context", "سياق الإصلاح"), text: it.closerContext }
          : typeof it.context === "string" && it.context
          ? { src: ctx.L("report context", "سياق البلاغ"), text: it.context } : null;
        const ctxLine = c ? `\n${c.src}: «${c.text}»` : "";
        return ctx.L(
          `#${it.num} — ${it.text}${plan}${openedLine}\nClosed: ${when(it)}${by}${closerWho}${ctxLine}`,
          `#${it.num} — ${it.text}${plan}${openedLine}\nأُغلق: ${when(it)}${by}${closerWho}${ctxLine}`);
      }
      return items.length
        ? ctx.L(`Recently closed (${items.length}):`, `آخر ما أُغلق (${items.length}):`) + "\n"
          + items.map((it: Row) => `  ${typeof it.num === "number" ? `#${it.num} ` : ""}${it.text} — ${when(it)}${it.closedBy ? ` -(${it.closedBy})` : ""}${who(it.closerModel) ? ` [${who(it.closerModel)}]` : ""}`).join("\n")
        : ctx.L("No closed items yet.", "لا عناصر مغلقة بعد.");
    },
  },

  // ── -(ask:lib) <names…> — version advisor ─────────────────────────────────
  // Own `serve`: several lines in one turn (or a corrected re-ask after a
  // refusal) merge into ONE query, and the 8-name server cap decides which
  // LINES may be marked served. Moved verbatim — see the notes inside.
  {
    key: "ask:lib",
    label: "lib-advice",
    re: /^[ \t]*-\s*\(ask:lib\)[ \t]+(\S[^\n]*?)[ \t]*$/gm,
    cmd: m => `ask:lib ${m[1]}`,
    path: "/api/lib-advice",
    timeoutMs: 25000,
    serve: async (hits: AskHit[], ctx: AskCtx) => {
      // The server caps at 8 names (#749): only the names actually sent ride
      // this batch. A line whose names all made the cut is marked served; a
      // line with names past the cap stays UNSERVED (a continuation re-serves
      // it) and the output says so — the old mark-everything path starved
      // those names of advice AND deduped away their re-ask within the turn.
      const LIB_CAP = 8;
      const flat = hits.flatMap(h => h.m[1].trim().split(/[ \t]+/).map(name => ({ h, name })));
      const sent = flat.slice(0, LIB_CAP);
      const starved = flat.slice(LIB_CAP);
      const names = sent.map(x => x.name).join(" ");
      const r = await fetch(
        `${ctx.server}/api/lib-advice?cwd=${encodeURIComponent(ctx.cwd)}&names=${encodeURIComponent(names)}`,
        { signal: AbortSignal.timeout(25000) });
      if (!r.ok) { await ctx.log(`ask:lib: server replied ${r.status}`); return; }
      // Record only now the fetch succeeded (#398) — and only lines whose
      // names ALL rode this batch (#749).
      for (const h of hits) if (!starved.some(s => s.h === h)) await ctx.markAskServed(h.cmd);
      const { items = [] } = await r.json() as { items?: Row[] };
      const L = ctx.L;
      const age = (d: unknown) => (typeof d === "number" ? L(` (${d}d old)`, ` (عمرها ${d} يوم)`) : "");
      const lines = items.map((it: Row) => {
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
            return `  ${it.name} → ${it.suggest}${age(it.suggestAgeDays)} ${L("— OSV clean", "— نظيفة OSV")} · ${it.installCmd}${fresh}${stepped}`;
          }
          case "ok-unverified":
            return `  ${it.name} → ${it.suggest}${age(it.suggestAgeDays)} ${L("— ⚠ OSV did not answer; maturity only, NO security certificate", "— ⚠ لم يُجب OSV؛ اختيار نضج فقط بلا شهادة أمان")} · ${it.installCmd}`;
          case "no-clean":
            return `  ${it.name} — ${L(`no OSV-clean version among the newest matured releases (${it.vulnNote}). Not recommending a vulnerable version.`, `لا نسخة نظيفة ضمن أحدث النسخ الناضجة (${it.vulnNote}). لن أقترح نسخة مثغورة.`)}`;
          case "no-mature":
            return `  ${it.name} — ${L(`nothing matured yet: newest is ${it.latest}${age(it.latestAgeDays)}, under the 7-day rule. Wait or decide explicitly.`, `لا نسخة ناضجة بعد: الأحدث ${it.latest}${age(it.latestAgeDays)} تحت قاعدة الأيام السبعة. انتظر أو قرر صراحةً.`)}`;
          case "unsupported-eco":
            // Two honest messages, not one misleading blame (#673): an EMPTY
            // eco means project detection failed — say that, and hand over
            // the prefix escape hatch instead of "ecosystem ? not supported".
            return it.eco
              ? `  ${it.name} — ${L(`ecosystem "${it.eco}" not supported for version history (npm/pypi/crates/go only)`, `النظام "${it.eco}" غير مدعوم لتاريخ النسخ (npm/pypi/crates/go فقط)`)}`
              : `  ${it.name} — ${L("could not detect this project's ecosystem — prefix the name and re-ask: npm:/pypi:/crates:/go:", "لم أتعرّف على نظام هذا المشروع — أضِف بادئة للاسم وأعد السؤال: npm:/pypi:/crates:/go:")}`;
          case "need-full-path":
            return `  ${it.name} — ${L("Go needs the FULL module path (e.g. go:github.com/jackc/pgx/v5) — the proxy knows no short names, and guessing one is typo-squatting territory. Re-ask with the import path.", "Go يتطلب مسار الوحدة الكامل (مثل go:github.com/jackc/pgx/v5) — البروكسي لا يعرف الأسماء القصيرة، وتخمينها باب typo-squatting. أعد السؤال بمسار الاستيراد.")}`;
          case "invalid-name":
            return `  ${it.name} — ${L("invalid package name — refused", "اسم حزمة غير صالح — مرفوض")}`;
          default:
            return `  ${it.name} — ${L("not found under this EXACT name (or lookup failed). Verify the name yourself — no near-miss suggestions (typo-squatting).", "غير موجودة بهذا الاسم الحرفي (أو فشل الاستعلام). تحقق من الاسم بنفسك — لا اقتراح أسماء مشابهة (typo-squatting).")}`;
        }
      });
      const out = lines.length ? lines.join("\n") : L("nothing to advise.", "لا شيء يُقترح.");
      // Purpose capture (#663): the ask:lib moment is when Claude KNOWS why the
      // dependency is being added — ask for the one-line record right here,
      // only when something was actually recommended.
      const capture = items.some((it: Row) => it.verdict === "ok" || it.verdict === "ok-unverified")
        ? L("\n  After installing, record WHY it's in this project: `-(lib) <name> — <one-line purpose>` (re-emit the name to update).",
            "\n  بعد التركيب سجّل سبب وجودها في المشروع: `-(lib) <الاسم> — <غرض من سطر واحد>` (أعد إصداره بنفس الاسم للتحديث).")
        : "";
      const capped = starved.length
        ? L(`\n  ⚠ capped at ${LIB_CAP} names per ask — NOT advised here: ${starved.map(s => s.name).join(" ")}. Re-emit -(ask:lib) for them.`,
            `\n  ⚠ السقف ${LIB_CAP} أسماء لكل سؤال — لم يُنصح هنا: ${starved.map(s => s.name).join(" ")}. أعد -(ask:lib) لها وحدها.`)
        : "";
      await ctx.log(`ask:lib: served ${items.length} item(s)${starved.length ? `, ${starved.length} past cap` : ""}`);
      await ctx.blockContinue(`\n[devlog lib-advice]\n${out}${capture}${capped}\n`);
    },
  },

  // ── -(ask:search) <query> — recall from the stored log ────────────────────
  // BM25 over the project's stored tags, so "why did we choose X?" is answered
  // from recorded history instead of re-derived. `all:` widens to every
  // project. Walks occurrences: an empty query is consumed with a correction
  // rather than left to shadow every later ask:search in the turn (#750).
  {
    key: "ask:search",
    label: "recall",
    re: /^[ \t]*-\s*\(ask:search\)[ \t]+(\S[^\n]*?)[ \t]*$/gm,
    cmd: m => `ask:search ${m[1]}`,
    path: "/api/recall",
    mode: "each",
    preflight: (m, ctx) => {
      const q = m[1].replace(/^all:[ \t]*/, "");
      return q.trim() ? null : {
        note: ctx.L("empty search query — write the question after ask:search (or after all:).",
                    "سؤال بحث فارغ — اكتب السؤال بعد ask:search (أو بعد all:)."),
      };
    },
    qs: m => {
      const all = /^all:/.test(m[1]);
      const q = m[1].replace(/^all:[ \t]*/, "");
      return `&q=${encodeURIComponent(q)}${all ? "&all=1" : ""}`;
    },
    logLine: d => `ask:search: served ${(d.results || []).length} result(s)`,
    format: (d, m, ctx) => {
      const results: Row[] = d.results || [];
      const all = /^all:/.test(m[1]);
      const lines = results.map((res: Row) => {
        const num = typeof res.num === "number" ? ` #${res.num}` : "";
        const proj = all ? ` @${res.project}` : "";
        return `  [${res.tag}${num}]${proj} ${String(res.timestamp || "").slice(0, 10)} — ${res.snippet}`;
      });
      return lines.length ? lines.join("\n") : ctx.L("no matches in the log.", "لا نتائج مطابقة في السجل.");
    },
  },

  // ── -(ask:map) [subsystem] — which files matter, and what each is for ─────
  // The answer to "where does X live?" without grepping: files ranked by the
  // import graph, each with the purpose its own header states. With an
  // argument, only the files that answer it. Placed before the inventory rows
  // because it is the one asked FIRST in an unfamiliar area.
  {
    key: "ask:map",
    label: "map",
    re: /^[ \t]*-\s*\(ask:map\)(?:[ \t]+([^\n]+))?[ \t]*$/gm,
    cmd: m => `ask:map${m[1] ? ` ${m[1].trim()}` : ""}`,
    path: "/api/map",
    qs: m => (m[1]?.trim() ? `&q=${encodeURIComponent(m[1].trim())}` : ""),
    timeoutMs: 60000,          // a cold analysis walks every source file
    logLine: d => `ask:map: served ${(d.entries || []).length}/${d.total || 0} file(s)`,
    format: (d, _m, ctx) => {
      const entries: Row[] = d.entries || [];
      const L = ctx.L;
      if (!entries.length) {
        return L("No analyzable source files found for this project.",
                 "لا ملفات مصدر قابلة للتحليل في هذا المشروع.");
      }
      const head = d.query
        ? (d.fellBack
            ? L(`Nothing matched «${d.query}» — showing the ${entries.length} most important files of ${d.total} instead:`,
                `لا شيء يطابق «${d.query}» — إليك أهم ${entries.length} ملف من ${d.total} بدلًا من ذلك:`)
            : L(`${entries.length} file(s) matching «${d.query}» (of ${d.total}):`,
                `${entries.length} ملف يطابق «${d.query}» (من ${d.total}):`))
        : L(`Top ${entries.length} files of ${d.total}, by how much the rest of the code depends on them:`,
            `أهم ${entries.length} ملف من ${d.total}، مرتبة بمقدار اعتماد بقية الكود عليها:`);
      const lines = entries.map((e: Row) => `  ${weightBar(e.weight)} ${e.path} (${e.lines}) — ${e.purpose}`);
      const foot = d.query
        ? ""
        : L("\n  Narrow it with -(ask:map) <subsystem> (matched against paths, purposes and exports).",
            "\n  ضيّق النطاق بـ-(ask:map) <المحور> (يطابق المسارات والأغراض والصادرات).");
      return `${head}\n${lines.join("\n")}${foot}`;
    },
  },

  // ── -(ask:why) <path> — one file's dossier ────────────────────────────────
  // `ask:map` answers "where do I look?"; this answers "what happened HERE?" —
  // the decisions that shaped a file, every report it caused with how each
  // ended, and the latest work on it. Pulled before rewriting something
  // load-bearing, so a rejected approach is not re-proposed and a fixed bug is
  // not re-introduced. The argument is REQUIRED: a dossier needs a subject.
  {
    key: "ask:why",
    label: "why",
    re: /^[ \t]*-\s*\(ask:why\)(?:[ \t]+([^\n]+))?[ \t]*$/gm,
    cmd: m => `ask:why ${(m[1] || "").trim()}`,
    path: "/api/file-why",
    // "each": one dossier per path asked, and the mode where `preflight` runs —
    // an argument-less line must be corrected, not silently fetched as `file=`.
    mode: "each",
    preflight: (m, ctx) => (m[1]?.trim() ? null : {
      note: ctx.L("ask:why needs a file — write the path after it, e.g. -(ask:why) src/data.ts",
                  "ask:why يحتاج ملفًا — اكتب المسار بعده، مثل -(ask:why) src/data.ts"),
    }),
    qs: m => `&file=${encodeURIComponent((m[1] || "").trim())}`,
    logLine: d => `ask:why: served ${d.file || "?"} (${(d.reports || []).length} report(s))`,
    format: (d, _m, ctx) => {
      const L = ctx.L;
      const more = (n: number) => (n > 0 ? L(`\n  …and ${n} more.`, `\n  …و${n} أخرى.`) : "");
      const out: string[] = [];
      out.push(L(`📄 ${d.file}`, `📄 ${d.file}`) + (d.purpose ? ` — ${d.purpose}` : ""));
      // #858: this dossier is pulled BEFORE rewriting a file. If the path is gone,
      // say it on the first line — the history below is still true, but it is
      // history, not a description of something you can open.
      if (d.missing) {
        out.push(L("  ⚠ This path is NOT on disk now — the history below is past, not present.",
                   "  ⚠ هذا المسار غير موجود على القرص الآن — ما تحته تاريخ لا وصفٌ لملف قائم."));
      }

      if (d.empty) {
        out.push(L("  No history recorded for this file.", "  لا تاريخ مسجَّلًا لهذا الملف."));
        if (d.lastChange) out.push(L(`  Last change: ${String(d.lastChange).slice(0, 16).replace("T", " ")}`,
                                     `  آخر تعديل: ${String(d.lastChange).slice(0, 16).replace("T", " ")}`));
        return out.join("\n");
      }

      const decisions: Row[] = d.decisions || [];
      if (decisions.length) {
        out.push(L(`  Decisions & insights (${decisions.length}):`, `  قرارات ورؤى (${decisions.length}):`));
        for (const x of decisions) out.push(`    [${x.tag}${typeof x.num === "number" ? ` #${x.num}` : ""} ${x.date}] ${x.text}`);
        out.push(more(d.decisionsMore || 0).trimStart() ? `  ${more(d.decisionsMore).trim()}` : "");
      }

      const reports: Row[] = d.reports || [];
      if (reports.length) {
        out.push(L(`  Reports (${reports.length}):`, `  بلاغات (${reports.length}):`));
        for (const r of reports) {
          const num = typeof r.num === "number" ? `#${r.num} ` : "";
          const state = r.open
            ? L("OPEN", "مفتوح")
            : typeof r.spanDays === "number"
              ? L(`fixed in ${r.spanDays}d`, `أُصلح خلال ${r.spanDays} يوم`)
              : L("fixed", "أُصلح");
          out.push(`    ${r.reopened ? "⟲ " : ""}${num}[${r.kind} · ${state}] ${r.text}`);
          if (r.fixContext) out.push(L(`      ↳ fix: ${r.fixContext}`, `      ↳ الإصلاح: ${r.fixContext}`));
        }
        if (d.reportsMore) out.push(`  ${more(d.reportsMore).trim()}`);
      }

      const work: Row[] = d.work || [];
      if (work.length) {
        out.push(L(`  Latest work (${work.length}):`, `  آخر الأعمال (${work.length}):`));
        for (const w of work) out.push(`    [${w.tag} ${w.date}] ${w.text}`);
        if (d.workMore) out.push(`  ${more(d.workMore).trim()}`);
      }

      if (d.lastChange) {
        out.push(L(`  Last change: ${String(d.lastChange).slice(0, 16).replace("T", " ")}`,
                   `  آخر تعديل: ${String(d.lastChange).slice(0, 16).replace("T", " ")}`));
      }
      return out.filter(Boolean).join("\n");
    },
  },

  // ── -(ask:record) — does the record itself hold up? ───────────────────────
  // Every other pull READS the record; this one CHECKS it, against today's
  // capture rules. Findings mean "does not match the rules as they are now",
  // never "wrong" — older entries were captured under the rules of their day.
  // `all:` widens to every project, because a capture defect is rarely confined
  // to one. Nothing here repairs anything.
  {
    key: "ask:record",
    label: "record",
    re: /^[ \t]*-\s*\(ask:record\)(?:[ \t]+(all:))?[ \t]*$/gm,
    cmd: m => `ask:record${m[1] ? " all" : ""}`,
    path: "/api/record-audit",
    qs: m => (m[1] ? "&all=1" : ""),
    timeoutMs: 20000,
    logLine: d => `ask:record: ${d.findings || 0} finding(s) over ${d.scanned || 0} tag(s)`,
    format: (d, _m, ctx) => {
      const L = ctx.L;
      const dets: Row[] = (d.detectors || []).filter((x: Row) => x.total > 0);
      const scope = d.all ? L("every tracked project", "كل المشاريع المتتبَّعة") : String(d.project || "");
      const head = L(`Record audit — ${d.scanned} tag(s) in ${scope}: ${d.findings} entr(ies) do not match today's capture rules.`,
                     `تدقيق السجل — ${d.scanned} تاق في ${scope}: ${d.findings} مدخلًا لا يطابق قواعد الالتقاط الحالية.`);
      if (!dets.length) {
        return L(`Record audit — ${d.scanned} tag(s) in ${scope}: everything matches today's rules.`,
                 `تدقيق السجل — ${d.scanned} تاق في ${scope}: كل شيء مطابق لقواعد اليوم.`);
      }
      const blocks = dets.map((det: Row) => {
        const title = ctx.L === undefined ? det.key : (det.title?.[ctx.L("en", "ar")] || det.key);
        const lines = (det.findings || []).map((f: Row) =>
          `    [${f.tag}${typeof f.num === "number" ? ` #${f.num}` : ""}${f.project && d.all ? ` · ${f.project}` : ""}] ${f.excerpt}`);
        const rest = det.total - (det.findings || []).length;
        const more = rest > 0 ? L(`\n    …and ${rest} more.`, `\n    …و${rest} أخرى.`) : "";
        return `  ${title} — ${det.total}:\n${lines.join("\n")}${more}`;
      });
      // Drift is context, not a finding: growing tags are a habit, and the
      // number that matters is the newest slice, which a quarter split hides.
      const drift: Row[] = (d.drift || []).filter((r: Row) => r.factor >= 2).slice(0, 4);
      const driftLine = drift.length
        ? `\n  ${L("Shape drift (median chars, oldest→newest quarter · latest slice):",
                   "انجراف الشكل (وسيط الأحرف، الربع الأقدم←الأحدث · الشريحة الأخيرة):")}\n`
          + drift.map((r: Row) => `    ${r.tag}: ${r.quarters.join(" → ")} · ${r.recent}  (×${r.factor})`).join("\n")
        : "";
      const foot = L("\n  Nothing was changed. These are FORM findings — whether an entry is TRUE is not measurable here.",
                     "\n  لم يُغيَّر شيء. هذه ملاحظات شكل — أما صدق المدخل فغير قابل للقياس هنا.");
      return `${head}\n${blocks.join("\n")}${driftLine}${foot}`;
    },
  },

  // ── -(ask:features) — the capability inventory ────────────────────────────
  // The client-language "what does the system do today?" list, each attributed
  // to the release that shipped it — so `-(feature update) #N` targets the
  // right number without guessing.
  {
    key: "ask:features",
    label: "features",
    re: /^[ \t]*-\s*\(ask:features\)[ \t]*$/gm,
    path: "/api/features",
    logLine: d => `ask:features: served ${(d.features || []).length} item(s)`,
    format: (d, _m, ctx) => {
      const features: Row[] = d.features || [];
      const line = (f: Row) => {
        const num = typeof f.num === "number" ? `#${f.num} ` : "";
        const since = f.sinceVersion
          ? ctx.L(`since ${f.sinceVersion}`, `منذ ${f.sinceVersion}`)
          : ctx.L("not released yet", "غير مُصدَرة بعد");
        return `  ${num}${f.text} — ${since}`;
      };
      return features.length
        ? `${ctx.L(`Current capabilities (${features.length}):`, `قدرات المشروع الحالية (${features.length}):`)}\n${features.map(line).join("\n")}`
        : ctx.L("No capabilities recorded yet — declare one with -(feature) <client-language line>.",
                "لا قدرات مسجّلة بعد — أعلن واحدة بـ-(feature) <سطر بلغة العميل>.");
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
      const { libraries = [], total = 0, withPurpose = 0 } = d as { libraries?: Row[]; total?: number; withPurpose?: number };
      const line = (l: Row) => {
        const dev = l.dev ? " (dev)" : "";
        const desc = l.description ? ` · ${String(l.description).slice(0, 120)}` : "";
        return l.purpose
          ? `  ✓ ${l.name}@${l.version}${dev} — ${l.purpose}${desc}`
          : `  ∅ ${l.name}@${l.version}${dev} — ${ctx.L("no purpose recorded", "بلا غرض مسجَّل")}${desc}`;
      };
      const uncovered = total - withPurpose;
      const footer = uncovered > 0
        ? ctx.L(`\n  ${uncovered} without a purpose — draft one line each, get the user's approval, then record each with \`-(lib) <name> — <purpose>\`.`,
                `\n  ${uncovered} بلا غرض — اقترح سطرًا لكل واحدة، خذ موافقة المستخدم، ثم سجّل كل واحدة بـ\`-(lib) <الاسم> — <الغرض>\`.`)
        : "";
      return libraries.length
        ? `${ctx.L(`Project libraries (${total}, ${withPurpose} with a recorded purpose):`, `مكتبات المشروع (${total}، منها ${withPurpose} بغرض مسجَّل):`)}\n${libraries.map(line).join("\n")}${footer}`
        : ctx.L("No libraries known for this project yet (they appear after the first scan).",
                "لا مكتبات معروفة للمشروع بعد (تظهر بعد أول فحص).");
    },
  },

  // ── -(ask:retro) — the whole problem corpus ───────────────────────────────
  // Every bug/security report, open and closed, pre-clustered by file so the
  // strongest recurrence signal leads instead of waiting to be derived.
  {
    key: "ask:retro",
    label: "retro",
    re: /^[ \t]*-\s*\(ask:retro\)[ \t]*$/gm,
    path: "/api/retro",
    logLine: d => `ask:retro: served ${(d.items || []).length} item(s)`,
    format: (d, _m, ctx) => {
      const { items = [], fragile = [], testGap, modelStats } = d as Row;
      const L = ctx.L;
      const line = (it: Row) => {
        const num = typeof it.num === "number" ? `#${it.num} ` : "";
        const kind = String(it.kind || "").startsWith("security") ? L("sec", "أمان") : L("bug", "خلل");
        const span = it.closedAt
          ? `${day(it.openedAt)}→${day(it.closedAt)} (${it.ageDays}${L("d", "ي")})`
          : `${day(it.openedAt)} ${L(`— OPEN (${it.ageDays}d)`, `— مفتوح (${it.ageDays}ي)`)}`;
        const files = it.files?.length
          ? ` — ${it.files.slice(0, 4).join(" · ")}${it.files.length > 4 ? ` (+${it.files.length - 4})` : ""}`
          : "";
        // ⟲: this report reopened an earlier closed one (#556) — the strongest
        // recurrence signal the corpus carries; cluster these first.
        const reopen = typeof it.reopenOf === "number" ? ` ⟲#${it.reopenOf}` : "";
        return `  ${num}[${kind}]${reopen} ${span} ${it.text}${files}`;
      };
      // «الأكثر كسرًا» header (#557): the corpus pre-clustered by file.
      const fragileLine = fragile.length
        ? `${L("Most-broken files: ", "الأكثر كسرًا: ")}${fragile.map((f: Row) =>
            // #858: a deleted path stays in the list (its history is real) but is
            // labelled, so «انتبه لهذا» is not spent on something that is gone.
            `${f.file} ×${f.count}${f.open ? L(` (${f.open} open)`, ` (${f.open} مفتوح)`) : ""}${f.missing ? L(" [deleted]", " [محذوف]") : ""}`).join(" · ")}\n`
        : "";
      // Regression-test gap (#585): one quiet ratio, never a nag — "what keeps
      // breaking?" and "what did we fix with nothing guarding it?" are the same
      // reflection, so it rides the same header the recurrences do.
      const gapLine = testGap && testGap.withoutTest > 0
        ? `${L(
            `Fixed without touching a test: ${testGap.withoutTest}/${testGap.judged}${testGap.unknown ? ` (${testGap.unknown} unknown)` : ""} — e.g. ${testGap.items.slice(0, 3).map((g: Row) => `${typeof g.num === "number" ? `#${g.num}` : ""}`).filter(Boolean).join(" ")}. A fix with no regression test can come back unnoticed.`,
            `أُصلح بلا لمس أي اختبار: ${testGap.withoutTest}/${testGap.judged}${testGap.unknown ? ` (${testGap.unknown} غير معروف)` : ""} — مثل ${testGap.items.slice(0, 3).map((g: Row) => `${typeof g.num === "number" ? `#${g.num}` : ""}`).filter(Boolean).join(" ")}. الإصلاح بلا اختبار انحدار قد يعود دون أن ينتبه أحد.`)}\n`
        : "";
      // Declared-stopgap debt: the point of `bug fix:interim` is that a
      // knowingly-temporary fix stays VISIBLE instead of aging into a surprise.
      // Oldest first, because the longest-standing stopgap is the one to pay
      // off; a re-opened one is labelled as expected, not as a failure.
      const interim = (d as Row).interimDebt;
      const interimLine = interim && interim.count > 0
        ? `${L(
            `Declared stopgaps still standing: ${interim.count}${interim.reopened ? ` (${interim.reopened} already came back)` : ""} — oldest ${interim.items.slice(0, 3).map((i: Row) => `${typeof i.num === "number" ? `#${i.num}` : ""}${typeof i.ageDays === "number" ? `(${i.ageDays}d)` : ""}`).filter(Boolean).join(" ")}. Each was closed as temporary on purpose; the debt is the age, not the choice.`,
            `إصلاحات عرضية معلَنة قائمة: ${interim.count}${interim.reopened ? ` (${interim.reopened} عاد فعلًا)` : ""} — أقدمها ${interim.items.slice(0, 3).map((i: Row) => `${typeof i.num === "number" ? `#${i.num}` : ""}${typeof i.ageDays === "number" ? `(${i.ageDays}ي)` : ""}`).filter(Boolean).join(" ")}. كلٌّ منها أُغلق مؤقتًا عن قصد؛ الدين في عمره لا في القرار.`)}\n`
        : "";
      // The enforcement tools themselves (plan guard-telemetry): how often each
      // Stop guard blocked, and which blocked nothing. The silent list is the
      // reason this line exists — a guard muted by an env var or broken by a
      // refactor reads EXACTLY like a guard with nothing to catch, and only the
      // full vocabulary can tell them apart. It never claims which one it is.
      const guards = (d as Row).guards;
      const guardRows = guards?.rows ?? [];
      const guardLine = guardRows.length || guards?.silent?.length
        ? `${L(
            `Guards: ${guardRows.map((g: Row) => `${g.rule} ${g.fires}${g.passes ? ` (answered ${g.passes})` : ""}`).join(" · ") || "none fired"}${guards.silent?.length ? ` — silent: ${guards.silent.join(", ")}` : ""}. Silent means untriggered OR muted/broken; check one before reading it as health.`,
            `الحرّاس: ${guardRows.map((g: Row) => `${g.rule} ${g.fires}${g.passes ? ` (استُجيب ${g.passes})` : ""}`).join(" · ") || "لم يطلق أحد"}${guards.silent?.length ? ` — صامتة: ${guards.silent.join(", ")}` : ""}. الصمت إما لم يُستفَز وإما معطَّل/مكسور؛ افحص واحدًا قبل قراءته كسلامة.`)}\n`
        : "";
      // Claim vs. trace (#855): work tags that asserted something, and whether the
      // edit record backed them. `unmarked` is history stored before the stamp
      // existed — reported separately so the ratio never counts unjudged tags as
      // clean. Silent when nothing was ever judged: absence of data, not health.
      const ev = (d as Row).evidence;
      const judged = ev ? (ev.supported || 0) + (ev.unsupported || 0) + (ev.unverifiable || 0) : 0;
      const evidenceLine = judged > 0
        ? `${L(
            `Work claims with a material trace: ${ev.supported}/${judged}${ev.unsupported ? ` · ${ev.unsupported} with NO trace` : ""}${ev.unverifiable ? ` · ${ev.unverifiable} unverifiable (commands ran)` : ""}${ev.unmarked ? ` · ${ev.unmarked} predate the stamp` : ""}. A traceless claim is not a lie — it is a claim nothing corroborates.`,
            `ادعاءات عمل لها أثر مادي: ${ev.supported}/${judged}${ev.unsupported ? ` · ${ev.unsupported} بلا أثر` : ""}${ev.unverifiable ? ` · ${ev.unverifiable} غير قابلة للتحقق (جرت أوامر)` : ""}${ev.unmarked ? ` · ${ev.unmarked} أقدم من الختم` : ""}. الادعاء بلا أثر ليس كذبًا — هو ادعاء لا يسانده شيء.`)}\n`
        : "";
      // Model scorecard (#695 follow-up): per-model discipline line — only
      // models that actually closed or opened something; silent when the
      // attributed history is still empty (pre-v3.30.0 projects).
      const modelLine = modelStats?.models?.length
        ? `${L("Models: ", "النماذج: ")}${modelStats.models.map((m: Row) => {
            const name = String(m.model || "").replace(/^claude-/, "");
            const gap = m.fixesJudged ? `, ${L("no-test", "بلا اختبار")} ${m.fixesWithoutTest}/${m.fixesJudged}` : "";
            const reop = m.reopened ? `, ⟲${m.reopened}` : "";
            return `${name} (${L("opened", "فتح")} ${m.reportsOpened}, ${L("fixed", "أصلح")} ${m.fixes}${reop}${gap})`;
          }).join(" · ")}\n`
        : "";
      return items.length
        ? `${fragileLine}${gapLine}${interimLine}${guardLine}${evidenceLine}${modelLine}${L(`Problem corpus (${items.length} reports, oldest first) — cluster the recurrences; codify a confirmed pattern with -(rule:add) or -(insight):`,
            `سجل المشاكل (${items.length} بلاغًا، الأقدم أولًا) — اعنقد المتكرر؛ ثبّت النمط المؤكد بـ-(rule:add) أو -(insight):`)}\n${items.map(line).join("\n")}`
        : L("No problem reports recorded for this project yet.", "لا بلاغات مسجّلة لهذا المشروع بعد.");
    },
  },

  // ── -(ask:backfill) — releases no capability covers ───────────────────────
  // The inventory only fills FORWARD, so pre-feature-era releases never get
  // covered. This serves the uncovered ones with their material so Claude can
  // PROPOSE `-(feature) [vX.Y.Z] …` lines for the user to approve.
  {
    key: "ask:backfill",
    label: "backfill",
    re: /^[ \t]*-\s*\(ask:backfill\)[ \t]*$/gm,
    path: "/api/features-backfill",
    logLine: d => `ask:backfill: served ${(d.uncovered || []).length}/${d.totalReleases || 0} release(s)`,
    format: (d, _m, ctx) => {
      const { totalReleases = 0, uncovered = [] } = d as Row;
      const L = ctx.L;
      const block = (u: Row) => {
        const head = `  ${u.version} (${day(u.date)})${u.summary ? ` — ${u.summary}` : ""}`;
        const lines = u.material.map((m: string) => `    · ${m}`);
        if (u.materialMore > 0) lines.push(`    ${L(`(+${u.materialMore} more)`, `(+${u.materialMore} أسطر أخرى)`)}`);
        return [head, ...lines].join("\n");
      };
      return uncovered.length
        ? [
            L(`Releases with no declared capability (${uncovered.length} of ${totalReleases}), oldest first:`,
              `إصدارات بلا قدرات معلنة (${uncovered.length} من ${totalReleases})، الأقدم أولًا:`),
            ...uncovered.map(block),
            "",
            L("Draft one client-language capability line per release (skip purely technical ones) and show the list to the user for approval FIRST. Only after approval declare each as:",
              "صِغ لكل إصدار سطر قدرة بلغة العميل (وتجاوز التقني الصِّرف) واعرض القائمة على المستخدم للموافقة أولًا. بعد الموافقة فقط أعلن كل واحدة بـ:"),
            "-(feature) [vX.Y.Z] <line>",
            L("The [vX.Y.Z] marker attributes the capability to the past release that shipped it — without it the feature is attributed to the NEXT release.",
              "وسم [vX.Y.Z] ينسب القدرة للإصدار الماضي الذي شحنها — بدونه تُنسب للإصدار القادم."),
          ].join("\n")
        : L("Every release is already covered by a declared capability — nothing to backfill.",
            "كل الإصدارات مغطاة بقدرات معلنة — لا شيء للتعبئة.");
    },
  },

  // ── -(ask:study) — the deep-study corpus ──────────────────────────────────
  // Whole-history aggregates + narrative delta since the previous stored study
  // + that study's conclusions digest. Claude writes the result back as
  // `-(doc:report) study-YYYY-MM-DD …`, which becomes the next watermark.
  {
    key: "ask:study",
    label: "study",
    re: /^[ \t]*-\s*\(ask:study\)[ \t]*$/gm,
    path: "/api/study",
    timeoutMs: 15000,
    logLine: d => `ask:study: served ${d.window?.foundational ? "foundational" : "incremental"} corpus`,
    format: (data, _m, ctx) => {
      const { window: w = {} as Row, aggregates: a = {} as Row, delta: d = {} as Row } = data as Row;
      const L = ctx.L;
      const out: string[] = [];

      out.push(w.foundational
        ? L(`FOUNDATIONAL study — window: entire history (${day(a.firstTagAt)} → ${day(w.to)}).`,
            `دراسة تأسيسية — النطاق: كامل التاريخ (${day(a.firstTagAt)} → ${day(w.to)}).`)
        : L(`INCREMENTAL study — window: ${day(w.from)} → ${day(w.to)} (since «${w.prevStudy?.name}»).`,
            `دراسة تراكمية — النطاق: ${day(w.from)} → ${day(w.to)} (منذ «${w.prevStudy?.name}»).`));
      if (w.prevStudy?.digest) {
        out.push(L("Previous study's conclusions (build ON these — confirm each pattern held or declare it broken):",
                   "خلاصة الدراسة السابقة (ابنِ فوقها — أكّد استمرار كل نمط أو أعلن انكساره):"));
        out.push(String(w.prevStudy.digest).split("\n").map((l: string) => `  ${l}`).join("\n"));
      }

      out.push(L("— Whole-history aggregates —", "— مجاميع كامل التاريخ —"));
      out.push(`  ${L("tags", "التاقات")}: ${a.totalTags} · ${L("sessions", "الجلسات")}: ${a.taggedSessions} · ${L("types", "الأنواع")}: ${Object.entries(a.byType || {}).map(([k, v]) => `${k}=${v}`).join(" ")}`);
      if (a.monthly?.length)
        out.push(`  ${L("monthly opened/closed/released", "شهريًا فُتح/أُغلق/أُصدر")}: ${a.monthly.map((m: Row) => `${m.month} ${m.opened}/${m.closed}/${m.released}`).join(" · ")}`);
      if (a.closure?.length)
        out.push(`  ${L("time-to-close", "زمن الإغلاق")}: ${a.closure.map((c: Row) => `${c.kind} ×${c.closed} ${L("median", "وسيط")} ${c.medianDays}${L("d", "ي")} ${L("max", "أقصى")} ${c.maxDays}${L("d", "ي")}`).join(" | ")}`);
      out.push(`  ${L("open now", "المفتوح الآن")}: todo=${a.openNow?.todos} bug=${a.openNow?.bugs} sec=${a.openNow?.security} ${L("steps", "خطوات")}=${a.openNow?.planSteps} (${L("deferred", "مؤجل")}=${a.openNow?.deferred}${typeof a.openNow?.oldestOpenDays === "number" ? ` · ${L("oldest", "الأقدم")} ${a.openNow.oldestOpenDays}${L("d", "ي")}` : ""})`);
      if (a.behavior) {
        const b = a.behavior;
        const topHours = (b.hourHistogram || []).map((n: number, h: number) => ({ n, h }))
          .filter((x: Row) => x.n > 0).sort((x: Row, y: Row) => y.n - x.n).slice(0, 3)
          .map((x: Row) => `${String(x.h).padStart(2, "0")}:00×${x.n}`).join(" ");
        const wd = ctx.lang === "ar"
          ? ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"]
          : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const weekdays = (b.weekdayHistogram || []).map((n: number, i: number) => `${wd[i]}=${n}`).join(" ");
        out.push(`  ${L("work rhythm (local time)", "إيقاع العمل (توقيت محلي)")}: ${L("peak hours", "ذروة الساعات")} ${topHours} · ${L("active days", "أيام نشطة")} ${b.activeDays}/${b.spanDays} (${L("longest streak", "أطول تواصل")} ${b.longestStreakDays}${L("d", "ي")}، ${L("longest gap", "أطول انقطاع")} ${b.longestGapDays}${L("d", "ي")}) · ${L("sessions", "الجلسات")}: ${b.sessions?.count} (${L("median", "وسيط")} ${b.sessions?.medianTags} ${L("tags", "تاق")} / ${b.sessions?.medianSpanMinutes} ${L("min", "دقيقة")}، ${L("max", "الأقصى")} ${b.sessions?.maxTags} ${L("tags", "تاق")})`);
        out.push(`  ${L("weekday spread", "توزيع الأسبوع")}: ${weekdays}`);
      }
      out.push(`  ${L("releases", "الإصدارات")}: ${a.releases?.total}${a.releases?.latest ? ` (${L("latest", "الأحدث")} ${a.releases.latest.version})` : ""} · ${L("cut with open items", "خرجت وعناصر مفتوحة")}: ${a.releases?.dirty}${a.releases?.securityDirty ? L(` (${a.releases.securityDirty} with open SECURITY)`, ` (منها ${a.releases.securityDirty} بأمني مفتوح)`) : ""}`);
      out.push(`  ${L("plans", "الخطط")}: ${a.plans?.total} (${a.plans?.closedSteps}/${a.plans?.steps} ${L("steps closed", "خطوة مغلقة")}) · ${L("problem reports", "البلاغات")}: ${a.problems?.reports} (${L("reopens", "إعادات فتح")} ⟲${a.problems?.reopens})`);
      if (a.problems?.fragile?.length)
        out.push(`  ${L("most-broken files", "الأكثر كسرًا")}: ${a.problems.fragile.map((f: Row) => `${f.file} ×${f.count}`).join(" · ")}`);
      // #585: the whole-history regression-test gap — the discipline number that
      // pairs with the reopen count above (a fix with no test, and a fix that
      // came back, are two readings of the same habit).
      if (a.problems?.testGap?.judged)
        out.push(`  ${L("fixed without touching a test", "أُصلح بلا لمس اختبار")}: ${a.problems.testGap.withoutTest}/${a.problems.testGap.judged}${a.problems.testGap.unknown ? L(` (${a.problems.testGap.unknown} unknown)`, ` (${a.problems.testGap.unknown} غير معروف)`) : ""}`);
      out.push(`  ${L("capabilities", "القدرات")}: ${a.features?.declared} (${L("backfilled", "معبأة رجعيًا")} ${a.features?.backfilled}) · ${L("uncovered releases", "إصدارات غير مغطاة")}: ${a.features?.uncoveredReleases}`);

      out.push(L("— Window delta —", "— دلتا النطاق —"));
      out.push(`  ${L("work", "العمل")}: built=${d.work?.built} refactor=${d.work?.refactor} update=${d.work?.update}`);
      if (d.releases?.items?.length)
        out.push(`  ${L("releases", "إصدارات")} (${d.releases.items.length}${d.releases.more ? `+${d.releases.more}` : ""}):\n${d.releases.items.map((r: Row) => `    ${r.version} (${day(r.at)}) — ${r.summary}`).join("\n")}`);
      if (d.problems?.items?.length)
        out.push(`  ${L("problem reports touched", "بلاغات النطاق")} (${d.problems.items.length}${d.problems.more ? `+${d.problems.more}` : ""}):\n${d.problems.items.map((it: Row) => {
          const num = typeof it.num === "number" ? `#${it.num} ` : "";
          const kind = String(it.kind || "").startsWith("security") ? L("sec", "أمان") : L("bug", "خلل");
          const span = it.closedAt ? `${day(it.openedAt)}→${day(it.closedAt)} (${it.ageDays}${L("d", "ي")})` : `${day(it.openedAt)} ${L("OPEN", "مفتوح")}`;
          const reopen = typeof it.reopenOf === "number" ? ` ⟲#${it.reopenOf}` : "";
          return `    ${num}[${kind}]${reopen} ${span} ${it.text}`;
        }).join("\n")}`);
      if (d.knowledge?.items?.length)
        out.push(`  ${L("decisions/insights", "قرارات/رؤى")} (${d.knowledge.items.length}${d.knowledge.more ? `+${d.knowledge.more}` : ""}):\n${d.knowledge.items.map((k: Row) => `    [${k.kind}] ${day(k.at)} ${k.text}`).join("\n")}`);
      if (d.longestClosed?.length)
        out.push(`  ${L("longest-lived items closed in window", "أطول العناصر عمرًا أُغلقت في النطاق")}:\n${d.longestClosed.map((c: Row) => `    ${typeof c.num === "number" ? `#${c.num} ` : ""}[${c.kind}] ${c.ageDays}${L("d", "ي")} — ${c.text}`).join("\n")}`);

      out.push(L(`Write the study now as a stored report: -(doc:report) study-YYYY-MM-DD <title>\\n<markdown>. Analyze discipline, recurring problems, project trajectory and user workflow from the material above — the aggregates are whole-history, the narrative is this window only. End the report with a «الخلاصة» section: it becomes the digest the NEXT study builds on. The study- name prefix is what makes this report the next watermark.`,
                 `اكتب الدراسة الآن كتقرير مخزن: -(doc:report) study-YYYY-MM-DD <عنوان>\\n<markdown>. حلّل الانضباط والمشاكل المتكررة ومسار المشروع وأسلوب العمل من المادة أعلاه — المجاميع على كامل التاريخ والسرد على هذا النطاق فقط. اختم التقرير بقسم «الخلاصة»: هو الموجز الذي تبني عليه الدراسة التالية. بادئة study- في الاسم هي ما يجعل هذا التقرير علامة المياه القادمة.`));

      return out.join("\n");
    },
  },
];

// Re-exported so the hook imports one module, not two.
export { serveAsks, unservedMatches } from "./hook-asks";
export type { AskCtx, AskRow, AskHit } from "./hook-asks";
