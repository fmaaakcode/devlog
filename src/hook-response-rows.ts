// The Stop hook's RESPONSE-BLOCK table (#897). Fifteen near-identical blocks
// used to live inline in parse-tags.ts — one per /api/tags response field
// (releaseDowngrade, closed, upcomingChanges, …), each re-encoding the same
// moves: detect the field, compose a message, log, then block or ride the
// feedback channel. They are now DATA ROWS run by one engine (runResponseRows),
// in the same fixed order the inline chain had — order is behavior, because a
// blocking row exits the process and everything pushed before it rides along.
// Texts were transferred VERBATIM (pinned by test/response-blocks-pin.test.ts
// and the #898 before/after replay); do not reword them here casually.
//
// Row anatomy: `applies` = presence + env/session gates; `text` = the exact
// composition; `deliver` = "block" (blockContinue with `blockKey`) or "info"
// (feedback.push, then optional `after` side effects and an optional escalation
// via `flushKey` — the upcoming/divergence pattern). `suppressedLog` speaks when
// the base condition holds but a once-per-session gate mutes the row.

import type { BlockKey } from "./block-channel";

// The wire shapes this table consumes — the /api/tags response fields as the
// server sends them. All optional: an ordinary store returns none of them.
interface OpenItemRef { num?: number; tag: string; content?: string; planTitle?: string; upcoming?: boolean }
export interface TagsResponse {
  releaseDowngrade?: { version: string; latest: string };
  releaseIntentConflict?: { declared: string; version: string };
  releaseBlocked?: { openItems?: OpenItemRef[] };
  rollback?: { version: string; restoredTo?: string; htmlDeleted?: boolean; indexRebuilt?: boolean };
  closed?: Array<{ num: number; text: string }>;
  repairedClosures?: Array<{ from: number | null; num: number }>;
  reopenHints?: Array<{ reportNum: number; num: number; closedAt?: string; text: string }>;
  upcomingChanges?: Array<{ kind: string; num?: number | null; text?: string }>;
  verifyHint?: { closers: Array<{ tag: string }>; reason?: string } | null;
  regressionHint?: { closers: Array<{ tag: string }> } | null;
  sweepHint?: { num: number; similar: Array<{ num?: number | null; text: string; closerFiles?: string[] }> } | null;
  closureTextWarnings?: Array<{ num: number; openerText: string }>;
  closureHints?: Array<{ kind: string; num: number; openerTag?: string; usedCloser?: string; suggested?: string }>;
  openSnapshot?: OpenItemRef[];
  featureHints?: Array<{ kind: string; tag?: string; num?: number }>;
  release?: {
    version: string;
    bumped?: Array<{ file: string; from: string; to: string }>;
    rejected?: Array<{ file: string; current?: string; attempted?: string; reason?: string }>;
    htmlGenerated?: boolean;
  };
  releaseIntent?: { auto?: boolean; bump: string; from: string; version: string; warning?: { suggested: string } };
}

export interface ResponseRowCtx {
  L: (en: string, ar: string) => string;
  log: (line: string) => Promise<void> | void;
  feedback: string[];
  blockContinue: (text: string, key: BlockKey) => Promise<never>;
  flushBlock: (key: BlockKey) => Promise<never>;
  /** The turn ledger's session section — rows mutate the hinted* gates and
   *  persist through persistLedger. */
  session: { hintedVerify?: boolean; hintedRegression?: boolean; hintedSweep?: boolean };
  persistLedger: () => Promise<void>;
}

export interface ResponseRow {
  /** The /api/tags response field this row consumes (documentation + tracing). */
  key: string;
  applies(resp: TagsResponse, ctx: ResponseRowCtx): boolean;
  text(resp: TagsResponse, ctx: ResponseRowCtx): string;
  logLine(resp: TagsResponse): string;
  deliver: "block" | "info";
  blockKey?: BlockKey;
  after?(resp: TagsResponse, ctx: ResponseRowCtx): Promise<void>;
  flushKey?(resp: TagsResponse): BlockKey | null;
  suppressedLog?(resp: TagsResponse, ctx: ResponseRowCtx): string | null;
}

const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

// `applies()` proved the field's presence, but the type system can't carry
// that proof across the row's other methods — this is the one sanctioned
// assertion bridging them. Never call it on a field applies() didn't check.
const sure = <T>(v: T | null | undefined): T => v as T;

export const RESPONSE_ROWS: ResponseRow[] = [
  // Release downgrade rejected wholesale: the release was NOT NEWER than
  // the latest one (older = typo, equal = duplicate tag that splits the
  // range material, #567), so the server stored nothing (no
  // tag/HTML/index/bump). Tell Claude with a block so it re-issues a
  // correct version.
  {
    key: "releaseDowngrade",
    applies: resp => !!resp.releaseDowngrade,
    text(resp, { L }) {
      const dg = sure(resp.releaseDowngrade);
      const out = [
        "════════ DevLog Release Rejected ════════",
        L(`🛑 Version ${dg.version} is not newer than the latest release (${dg.latest}) — rejected entirely.`,
          `🛑 الإصدار ${dg.version} ليس أحدث من آخر إصدار (${dg.latest}) — رُفض بالكامل.`),
        L("Nothing was recorded: no tag, no HTML, no index, no version bump.",
          "لم يُسجَّل أي شيء: لا وسم، لا HTML، لا index، ولا رفع نسخة."),
        "",
        L(`Release a version newer than ${dg.latest}, or double-check the number.`,
          `أصدر نسخة أحدث من ${dg.latest}، أو تأكّد من الرقم.`),
        "═════════════════════════════════════════",
      ].join("\n");
      return `\n${out}\n`;
    },
    logLine: resp => `release-downgrade rejected: ${sure(resp.releaseDowngrade).version} <= ${sure(resp.releaseDowngrade).latest}`,
    deliver: "block",
    blockKey: "release-downgrade",
  },
  // Type+number conflict: -(release:minor) v1.102.0 — the intent tag
  // treats the whole reason as prose, so the number would be silently
  // swallowed and a DIFFERENT version recorded (field incident: user
  // wrote v1.102.0, DevLog recorded v1.104.0, rollback needed). The
  // server stored nothing; block so Claude re-emits ONE valid form.
  {
    key: "releaseIntentConflict",
    applies: resp => !!resp.releaseIntentConflict,
    text(resp, { L }) {
      const c = sure(resp.releaseIntentConflict);
      const out = [
        "════════ DevLog Release Rejected ════════",
        L(`🛑 -(release:${c.declared}) starts with an explicit version (${c.version}) — a type tag never accepts a number and would silently ignore it. Nothing was recorded.`,
          `🛑 -(release:${c.declared}) يبدأ برقم نسخة صريح (${c.version}) — تاق النوع لا يقبل رقمًا وكان سيتجاهله بصمت. لم يُسجَّل أي شيء.`),
        "",
        L("Re-emit exactly ONE of the two forms:", "أعد الإصدار بإحدى الصيغتين فقط:"),
        `  -(release:${c.declared}) <reason>${L("      → DevLog computes the next number", "      → DevLog يحسب الرقم التالي")}`,
        `  -(release) ${c.version} — <reason>${L("  → your number is honored", "  → رقمك يُنفَّذ")}`,
        "═════════════════════════════════════════",
      ].join("\n");
      return `\n${out}\n`;
    },
    logLine: resp => `release-intent-conflict rejected: ${sure(resp.releaseIntentConflict).declared} + ${sure(resp.releaseIntentConflict).version}`,
    deliver: "block",
    blockKey: "release-intent",
  },
  // Open-items guard fired on the SERVER (defense in depth). Reached when
  // the pre-send guard was bypassed — server unreachable at pre-check
  // (fail-open), un-numbered open items, or the hook not wired. The server
  // stored nothing; tell Claude to close the items, then re-release.
  {
    key: "releaseBlocked",
    applies: resp => !!resp.releaseBlocked,
    text(resp, { L }) {
      const items = sure(resp.releaseBlocked).openItems || [];
      const byTag: Record<string, OpenItemRef[]> = {};
      for (const it of items) {
        byTag[it.tag] ||= [];
        byTag[it.tag].push(it);
      }
      const out = ["════════ DevLog Release Blocked ════════",
        L(`🛑 ${items.length} open item(s) — the release was NOT recorded (no tag, no HTML, no version bump):`,
          `🛑 ${items.length} مهمة مفتوحة — لم يُسجَّل الإصدار (لا وسم، لا HTML، لا رفع نسخة):`)];
      for (const [tag, arr] of Object.entries(byTag)) {
        out.push(`  ${tag} (${arr.length}):`);
        for (const it of arr.slice(0, 20)) {
          const ref = typeof it.num === "number" ? `#${it.num}` : `«${(it.content || "").slice(0, 40)}»`;
          const plan = it.planTitle ? ` [plan: ${it.planTitle}]` : "";
          out.push(`    · ${ref} ${(it.content || "").slice(0, 80)}${plan}`);
        }
        if (arr.length > 20) out.push(L(`    ... +${arr.length - 20} more`, `    ... +${arr.length - 20} أخرى`));
      }
      out.push("", L("Close every item with -(done)/-(dropped)/-(bug fix)/-(security fix) (by number, or by text for items with no #N),",
        "أَغلِق كل عنصر بـ -(done)/-(dropped)/-(bug fix)/-(security fix) (بالرقم، أو بالنص للعناصر بلا #N)،"),
        L("then re-emit -(release). Or bypass with DEVLOG_RELEASE_GUARD=0.",
          "ثم أعد إصدار -(release). أو تجاوز بـ DEVLOG_RELEASE_GUARD=0."),
        "═════════════════════════════════════════");
      return `\n${out.join("\n")}\n`;
    },
    logLine: resp => `release-blocked (server): open_items=${(sure(resp.releaseBlocked).openItems || []).length}`,
    deliver: "block",
    blockKey: "release-blocked",
  },
  // Release rollback outcome (QA #2): undoing a release reverses its
  // effects; report them so the manifest state is never silently out of
  // sync. Informational — no block.
  {
    key: "rollback",
    applies: resp => !!resp.rollback,
    text(resp, { L }) {
      const rb = sure(resp.rollback);
      const manifest = rb.restoredTo
        ? L(`manifest restored to ${rb.restoredTo}`, `استُرجِع المانيفست إلى ${rb.restoredTo}`)
        : L("manifest not restored (no prior reference) — check manually if needed",
            "لم يُسترجَع المانيفست (لا مرجع سابق) — تحقّق يدوياً إن لزم");
      return `\n[devlog rollback]\n${L(`↩ Release ${rb.version} removed`, `↩ أُزيل الإصدار ${rb.version}`)}: ${manifest}` +
        `${rb.htmlDeleted ? L(", page deleted", "، حُذِفت الصفحة") : ""}${rb.indexRebuilt ? L(", index rebuilt", "، أُعيد بناء الفهرس") : ""}.\n`;
    },
    logLine: resp => `rollback: ${sure(resp.rollback).version} restoredTo=${sure(resp.rollback).restoredTo}`,
    deliver: "info",
  },
  // Positive closure confirmation (#228): echo what each `#N` closure
  // actually closed, text included. Informational only — no block, so
  // it never forces an extra turn; it just surfaces alongside any other
  // feedback. The text lets Claude catch a wrong-but-compatible number
  // (closed #229 when #228 was meant — a slip the mismatch check can't
  // see because both are open todos).
  {
    key: "closed",
    applies: resp => nonEmpty(resp.closed),
    text(resp, { L }) {
      const lines = sure(resp.closed).map((c) => L(`✓ closed #${c.num} — ${c.text}`, `✓ أُغلق #${c.num} — ${c.text}`));
      return `\n[devlog closure]\n${lines.join("\n")}\n`;
    },
    logLine: resp => `closure-confirm: ${sure(resp.closed).map((c) => c.num).join(", ")}`,
    deliver: "info",
  },
  // Same-response pairing echo (#633): a closer that resolved to nothing
  // was paired with the single work item opened in this same response.
  // Informational, no block — the closure already applied; the echo just
  // keeps the wrong guess (or the number-less form) visible.
  {
    key: "repairedClosures",
    applies: resp => nonEmpty(resp.repairedClosures),
    text(resp, { L }) {
      const lines = sure(resp.repairedClosures).map((r) =>
        r.from != null
          ? L(`🔗 #${r.from} matches nothing — auto-paired with #${r.num}, the item you opened in this same response (next time close same-response items with NO number).`,
              `🔗 #${r.from} لا يطابق شيئاً — قُرن تلقائياً بـ#${r.num}، العنصر الذي فتحتَه في هذا الرد نفسه (المرة القادمة أغلق عناصر نفس الرد بلا رقم).`)
          : L(`🔗 number-less closure paired with #${r.num}, the item opened in this same response.`,
              `🔗 إغلاق بلا رقم قُرن بـ#${r.num}، العنصر المفتوح في هذا الرد نفسه.`));
      return `\n[devlog closure-pair]\n${lines.join("\n")}\n`;
    },
    logLine: resp => `closure-pair: ${sure(resp.repairedClosures).map((r) => r.num).join(", ")}`,
    deliver: "info",
  },
  // Reopen linkage (#556): a stored problem report matched a CLOSED one
  // — the fix didn't hold. Informational only, no block: the relation
  // is already stored; Claude just learns the history exists.
  {
    key: "reopenHints",
    applies: resp => nonEmpty(resp.reopenHints),
    text(resp, { L }) {
      const day = (s: string) => String(s).slice(0, 10);
      const lines = sure(resp.reopenHints).map((h) => {
        const when = h.closedAt
          ? L(` (closed ${day(h.closedAt)})`, ` (أُغلق ${day(h.closedAt)})`)
          : "";
        return L(
          `⟲ #${h.reportNum} likely REOPENS #${h.num}${when} — ${String(h.text).slice(0, 80)}. Check whether the old fix regressed before treating it as new.`,
          `⟲ ‏#${h.reportNum} يبدو إعادة فتح لـ#${h.num}${when} — ${String(h.text).slice(0, 80)}. افحص هل انتكس الإصلاح القديم قبل معالجته كجديد.`);
      });
      return `\n[devlog reopen]\n${lines.join("\n")}\n`;
    },
    logLine: resp => `reopen: ${sure(resp.reopenHints).map((h) => `#${h.reportNum}→#${h.num}`).join(", ")}`,
    deliver: "info",
  },
  // «قادمة» outcomes: echo what -(upcoming) / a `-(todo) #N` promotion
  // actually did. Successes are informational; a no-match or a refused
  // security deferral blocks once so Claude corrects the number instead
  // of believing a conversion that never happened.
  {
    key: "upcomingChanges",
    applies: resp => nonEmpty(resp.upcomingChanges),
    text(resp, { L }) {
      const fmt = (c: NonNullable<TagsResponse["upcomingChanges"]>[number]) => {
        const t = c.text ? ` — ${String(c.text).slice(0, 80)}` : "";
        switch (c.kind) {
          case "created":          return L(`☾ #${c.num} recorded as upcoming${t}`, `☾ سُجّل #${c.num} ضمن القادمة${t}`);
          case "deferred":         return L(`☾ #${c.num} moved to upcoming${t}`, `☾ صار #${c.num} من القادمة${t}`);
          case "promoted":         return L(`⬆ #${c.num} promoted to a tracked todo${t}`, `⬆ رُقّي #${c.num} لالتزام حالي${t}`);
          case "step-deferred":    return L(`☾ plan step #${c.num} moved to upcoming — its siblings stay committed${t}`, `☾ خطوة الخطة #${c.num} صارت قادمة — بقية الخطوات ما زالت ملتزمة${t}`);
          case "step-promoted":    return L(`⬆ plan step #${c.num} is current again${t}`, `⬆ خطوة الخطة #${c.num} عادت حالية${t}`);
          case "plan-promoted":    return L(`⬆ plan «${c.text}» is current again (via #${c.num})`, `⬆ خطة «${c.text}» عادت حالية (عبر #${c.num})`);
          case "security-refused": return L(`✗ #${c.num} is a security item — security is never deferred; close it with -(security fix)${t}`, `✗ #${c.num} عنصر أمني — الأمن لا يؤجَّل؛ أغلقه بـ-(security fix)${t}`);
          case "duplicate":        return L(`· identical to OPEN item ${c.num != null ? `#${c.num}` : "(unnumbered)"} — nothing new stored; to defer that one use -(upcoming) ${c.num != null ? `#${c.num}` : "#N"}`, `· مطابق للعنصر المفتوح ${c.num != null ? `#${c.num}` : "(بلا رقم)"} — لم يُخزَّن جديد؛ لتأجيله استخدم -(upcoming) ${c.num != null ? `#${c.num}` : "#N"}`);
          default:                 return L(`✗ #${c.num} matches no open item — nothing was deferred; check the number`, `✗ #${c.num} لا يطابق أي عنصر مفتوح — لم يُؤجَّل شيء؛ تحقّق من الرقم`);
        }
      };
      return `\n[devlog upcoming]\n${sure(resp.upcomingChanges).map(fmt).join("\n")}\n`;
    },
    logLine(resp) {
      const bad = sure(resp.upcomingChanges).some((c) => c.kind === "no-match" || c.kind === "security-refused");
      return `upcoming: ${sure(resp.upcomingChanges).map((c) => `${c.kind}#${c.num ?? "?"}`).join(", ")}${bad ? " (blocking)" : ""}`;
    },
    deliver: "info",
    flushKey: resp =>
      sure(resp.upcomingChanges).some((c) => c.kind === "no-match" || c.kind === "security-refused") ? "upcoming" : null,
  },
  // Optional verify nudge (#232): closed something without running tests
  // this session. Informational only — never blocks. Mute with
  // DEVLOG_VERIFY_HINT=0. Once-per-session gate: a nudge is a reminder,
  // not a nag. Emitting it on every closing turn is what let an
  // unsatisfiable detector spin into a loop; after the first surface we
  // stay quiet for the rest of the session even if more closures land.
  {
    key: "verifyHint",
    applies: (resp, ctx) =>
      !!(resp.verifyHint && Array.isArray(resp.verifyHint.closers) && resp.verifyHint.closers.length)
      && process.env.DEVLOG_VERIFY_HINT !== "0" && !ctx.session.hintedVerify,
    text(resp, { L }) {
      const verbs = [...new Set(sure(resp.verifyHint).closers.map((c) => c.tag))].join("/");
      // Reason-aware since verify-hint v2: say WHAT evidence is missing
      // (none / last run failed / all runs predate the edits) instead of
      // the generic line a failing or stale run used to satisfy.
      const msg = sure(resp.verifyHint).reason === "failing-tests"
        ? L(`💡 You closed (${verbs}) but the last test run AFTER your edits FAILED — that's closing over red. Make it pass, or reopen.`,
            `💡 أغلقتَ (${verbs}) وآخر تشغيل اختبار بعد تعديلاتك فاشل — هذا إغلاق فوق أحمر. اجعله ينجح أو تراجع عن الإغلاق.`)
        : sure(resp.verifyHint).reason === "stale-tests"
        ? L(`💡 You closed (${verbs}) but every test run predates your last code edit — it proves nothing about it. Re-run the tests now.`,
            `💡 أغلقتَ (${verbs}) وكل تشغيلات الاختبار سبقت آخر تعديل كود — لا تثبت عنه شيئًا. أعد تشغيل الاختبارات الآن.`)
        : L(`💡 You closed (${verbs}) without running any test this session. "Verified" = observed evidence (a passing test in the conversation), not reading the code. Run the test to confirm.`,
            `💡 أغلقتَ (${verbs}) بلا تشغيل أي اختبار في هذه الجلسة. «التحقّق» = دليل مُلاحَظ (اختبار ناجح في المحادثة)، لا قراءة الكود. شغّل الاختبار للتأكيد.`);
      return `\n[devlog verify]\n${msg}\n`;
    },
    logLine: resp => `verify-hint: ${sure(resp.verifyHint).closers.length} closer(s), reason=${sure(resp.verifyHint).reason}`,
    deliver: "info",
    async after(_resp, ctx) {
      ctx.session.hintedVerify = true;
      await ctx.persistLedger();
    },
    suppressedLog: (resp, ctx) =>
      resp.verifyHint && Array.isArray(resp.verifyHint.closers) && resp.verifyHint.closers.length
      && process.env.DEVLOG_VERIFY_HINT !== "0" && ctx.session.hintedVerify
        ? `verify-hint: suppressed (already hinted this session)` : null,
  },
  // Regression-test nudge (#683): a bug fix / security fix closed, tests
  // ran green, but the session never wrote a test file — the fix shipped
  // without a regression test (the retro's 3/41 stat). Informational
  // only, once per session. Mute with DEVLOG_REGRESSION_HINT=0.
  {
    key: "regressionHint",
    applies: (resp, ctx) =>
      !!(resp.regressionHint && Array.isArray(resp.regressionHint.closers) && resp.regressionHint.closers.length)
      && process.env.DEVLOG_REGRESSION_HINT !== "0" && !ctx.session.hintedRegression,
    text(resp, { L }) {
      const verbs = [...new Set(sure(resp.regressionHint).closers.map((c) => c.tag))].join("/");
      return `\n[devlog regression]\n${L(
        `💡 You closed (${verbs}) but this session never touched a test file — a fix without a regression test can silently break again. Add a test that pins the fix.`,
        `💡 أغلقتَ (${verbs}) وهذه الجلسة لم تلمس أي ملف اختبار — إصلاح بلا اختبار انحدار قد يعود دون أن ينتبه أحد. أضِف اختبارًا يثبّت الإصلاح.`)}\n`;
    },
    logLine: resp => `regression-hint: ${sure(resp.regressionHint).closers.length} fix closer(s), no test file written`,
    deliver: "info",
    async after(_resp, ctx) {
      ctx.session.hintedRegression = true;
      await ctx.persistLedger();
    },
    suppressedLog: (resp, ctx) =>
      resp.regressionHint && Array.isArray(resp.regressionHint.closers) && resp.regressionHint.closers.length
      && process.env.DEVLOG_REGRESSION_HINT !== "0" && ctx.session.hintedRegression
        ? `regression-hint: suppressed (already hinted this session)` : null,
  },
  // Pattern-sweep nudge (#682): the bug just fixed resembles previously
  // closed bugs — a recurring pattern family (the retro counted the same
  // defect re-fixed module by module three times). Push a same-pattern
  // sweep across the rest of the code while the fix is fresh. Once per
  // session; mute with DEVLOG_SWEEP_HINT=0.
  {
    key: "sweepHint",
    applies: (resp, ctx) =>
      !!(resp.sweepHint && Array.isArray(resp.sweepHint.similar) && resp.sweepHint.similar.length)
      && process.env.DEVLOG_SWEEP_HINT !== "0" && !ctx.session.hintedSweep,
    text(resp, { L }) {
      const sibs = sure(resp.sweepHint).similar.map((s) =>
        `· ${s.num != null ? `#${s.num} ` : ""}«${s.text}»${s.closerFiles?.length ? ` — ${s.closerFiles.join(" · ")}` : ""}`);
      return `\n[devlog sweep]\n${L(
        `🔁 The bug you fixed (#${sure(resp.sweepHint).num}) resembles previously closed bugs — a recurring pattern:`,
        `🔁 العلة التي أصلحتها (#${sure(resp.sweepHint).num}) تشبه عللًا مغلقة سابقًا — نمط متكرر:`)}\n${sibs.join("\n")}\n${L(
        "Sweep the same pattern across the OTHER modules now, while the fix is fresh — the log shows this class of bug returns elsewhere.",
        "امسح نفس النمط في بقية الوحدات الآن والإصلاح طازج — السجل يُظهر أن هذا الصنف من العلل يعود في مواضع أخرى.")}\n`;
    },
    logLine: resp => `sweep-hint: #${sure(resp.sweepHint).num} ~ ${sure(resp.sweepHint).similar.length} sibling(s)`,
    deliver: "info",
    async after(_resp, ctx) {
      ctx.session.hintedSweep = true;
      await ctx.persistLedger();
    },
    suppressedLog: (resp, ctx) =>
      resp.sweepHint && Array.isArray(resp.sweepHint.similar) && resp.sweepHint.similar.length
      && process.env.DEVLOG_SWEEP_HINT !== "0" && ctx.session.hintedSweep
        ? `sweep-hint: suppressed (already hinted this session)` : null,
  },
  // Closure text divergence (#315): the closure APPLIED (valid number +
  // verb), but the trailing description shares no token with the item #N
  // is about — a likely wrong-but-compatible number (the #310/#311 slip).
  // Objection, not a skip: verify you closed the intended item, then undo
  // + re-close if wrong. Fires once (the item is now closed, so a correct
  // re-run won't retrigger). Mute with DEVLOG_CLOSURE_TEXT_CHECK=0.
  // Only self-flushes when there's no harder closure mismatch behind it
  // (that one blocks too, flushing this along with it); avoids double handling.
  {
    key: "closureTextWarnings",
    applies: resp => nonEmpty(resp.closureTextWarnings) && process.env.DEVLOG_CLOSURE_TEXT_CHECK !== "0",
    text(resp, { L }) {
      const lines = sure(resp.closureTextWarnings).map((w) =>
        L(`· #${w.num} is about: «${w.openerText}» — your closure text is unrelated. Did you mean a different number?`,
          `· #${w.num} موضوعه: «${w.openerText}» — نص إغلاقك لا يمتّ له بصلة. هل قصدتَ رقماً آخر؟`));
      const out = [
        "════════ DevLog Closure Text Divergence ════════",
        L(`⚠ ${sure(resp.closureTextWarnings).length} closure(s) applied, but the text diverges from the item:`,
          `⚠ ${sure(resp.closureTextWarnings).length} إغلاق طُبِّق، لكن نصّه يتنافر مع العنصر:`),
        ...lines,
        "",
        L("If the number is wrong: -(undo) #N to reopen, then close the intended item.",
          "إن كان الرقم خاطئاً: -(undo) #N لإعادة الفتح، ثم أغلِق العنصر المقصود."),
        "═════════════════════════════════════════════════",
      ].join("\n");
      return `\n${out}\n`;
    },
    logLine: resp => `closure-text-divergence: ${sure(resp.closureTextWarnings).map((w) => w.num).join(", ")}`,
    deliver: "info",
    flushKey: resp =>
      Array.isArray(resp.closureHints) && resp.closureHints.length ? null : "closure-divergence",
  },
  // Closure mismatch: Claude closed an item that won't actually close —
  // wrong verb for an open item (`-(done)` on a bug), or a #N matching no
  // open item (typo'd / already-closed number). The server skipped the
  // junk tag; tell Claude how to fix it. Fires once — a correct closure
  // produces no hint next turn (no loop). Checked before release so
  // closures get fixed first (the release-guard would block anyway).
  {
    key: "closureHints",
    applies: resp => nonEmpty(resp.closureHints),
    text(resp, { L }) {
      const lines = sure(resp.closureHints).map((h) =>
        h.kind === "no-match"
          ? L(`· #${h.num} matches no open item — check the number (closure not applied).`,
              `· #${h.num} لا يطابق أي عنصر مفتوح — تحقّق من الرقم (الإغلاق لم يُطبَّق).`)
        : h.kind === "already-closed-wrong-verb"
          ? L(`· #${h.num} is already closed (a «${h.openerTag}») and -(${h.usedCloser}) can't close that type anyway — you likely meant a different OPEN item; check the number.`,
              `· #${h.num} مغلق سابقاً (نوعه «${h.openerTag}») و-(${h.usedCloser}) لا يُغلِق هذا النوع أصلاً — على الأرجح قصدت عنصراً مفتوحاً آخر؛ تحقّق من الرقم.`)
          : L(`· #${h.num} is a «${h.openerTag}» — close it with -(${h.suggested}) #${h.num}, not -(${h.usedCloser}).`,
              `· #${h.num} نوعه «${h.openerTag}» — أغلِقه بـ-(${h.suggested}) #${h.num}، لا -(${h.usedCloser}).`));
      // #632: the live open list rides the rejection itself — fixing the
      // number no longer costs an -(ask:open) round-trip (the Mac field
      // test burned two extra turns exactly here).
      const snapshot: string[] = [];
      if (Array.isArray(resp.openSnapshot) && resp.openSnapshot.length) {
        snapshot.push("", L("Currently open:", "المفتوح حالياً:"));
        for (const it of resp.openSnapshot) {
          const up = it.upcoming ? L(" [deferred]", " [مؤجَّل]") : "";
          snapshot.push(`  #${it.num} (${it.tag}) ${it.content}${up}`);
        }
      } else if (Array.isArray(resp.openSnapshot)) {
        snapshot.push("", L("Nothing is open right now — the item may already be closed; check with -(ask:closed) #N.",
                            "لا شيء مفتوح الآن — قد يكون العنصر مغلقاً أصلاً؛ تحقّق بـ-(ask:closed) #N."));
      }
      const out = [
        "════════ DevLog Closure Mismatch ════════",
        L(`⚠ ${sure(resp.closureHints).length} closure(s) not recorded (closed nothing):`,
          `⚠ ${sure(resp.closureHints).length} إغلاق لم يُسجَّل (لم يُغلِق شيئاً):`),
        ...lines,
        ...snapshot,
        "",
        L("Fix the number or the verb above, then re-close.",
          "صحّح الرقم أو الـverb أعلاه ثم أعد الإغلاق."),
        "═════════════════════════════════════════",
      ].join("\n");
      return `\n${out}\n`;
    },
    logLine: resp => `closure-mismatch: served ${sure(resp.closureHints).length}`,
    deliver: "block",
    blockKey: "closure-mismatch",
  },
  // Feature-reference problems: a -(feature update)/-(feature removed)
  // whose #N points at no recorded feature (or lost its ref/text). The
  // server skipped the junk tag; tell Claude so it corrects the number
  // instead of believing an update that never applied. Fires once — a
  // corrected reference produces no hint next turn.
  {
    key: "featureHints",
    applies: resp => nonEmpty(resp.featureHints),
    text(resp, { L }) {
      const lines = sure(resp.featureHints).map((h) =>
        h.kind === "no-ref"
          ? L(`· -(${h.tag}) needs a leading #N naming the feature it targets.`,
              `· -(${h.tag}) يحتاج #N في البداية يحدد القدرة المستهدفة.`)
        : h.kind === "no-text"
          ? L(`· -(feature update) #${h.num} carries no new text — nothing to update to.`,
              `· -(feature update) #${h.num} بلا نص جديد — لا شيء يُحدَّث إليه.`)
        : h.kind === "already-removed"
          ? L(`· feature #${h.num} is already removed — check the number.`,
              `· القدرة #${h.num} أُزيلت سابقًا — تحقّق من الرقم.`)
          : L(`· #${h.num} matches no recorded feature — check the number (nothing stored). Pull the list with -(ask:features).`,
              `· #${h.num} لا يطابق أي قدرة مسجّلة — تحقّق من الرقم (لم يُخزَّن شيء). اسحب القائمة بـ-(ask:features).`));
      const out = [
        "════════ DevLog Feature Reference ════════",
        L(`⚠ ${sure(resp.featureHints).length} feature tag(s) not recorded:`,
          `⚠ ${sure(resp.featureHints).length} وسم قدرات لم يُسجَّل:`),
        ...lines,
        "",
        L("Fix the reference above, then re-emit.", "صحّح المرجع أعلاه ثم أعد الإصدار."),
        "══════════════════════════════════════════",
      ].join("\n");
      return `\n${out}\n`;
    },
    logLine: resp => `feature-hints: served ${sure(resp.featureHints).length}`,
    deliver: "block",
    blockKey: "feature-hints",
  },
  // Release response: feed the outcome back so Claude knows DevLog
  // processed the release (version bumped, HTML/changelog written) and
  // can continue post-release steps (e.g. build) WITHOUT stopping to ask
  // the user. The server only returns a result for a newly-stored release
  // tag — a re-emit dedups to null, so this row fires once (no loop).
  // Delivery: it hands back the version the -(release) tag asked for.
  {
    key: "release",
    applies: resp => !!resp.release,
    text(resp, { L }) {
      const rel = sure(resp.release);
      const intent = resp.releaseIntent;   // present when the version was computed from -(release:type)
      const sep = L(", ", "، ");
      const bumps = (rel.bumped || []).map((u) => `${u.file} ${u.from}→${u.to}`).join(sep) || L("no manifest to bump", "لا مانيفست لرفعه");
      // Entries without a reason predate the field → they are downgrades.
      const downgrades = (rel.rejected || []).filter((u) => u.reason !== "unsupported-layout")
        .map((u) => `${u.file} ${u.current}→${u.attempted}`).join(sep);
      const unsupported = (rel.rejected || []).filter((u) => u.reason === "unsupported-layout")
        .map((u) => u.file).join(sep);
      const out = [
        "════════ DevLog Release ════════",
        L(`✓ Release ${rel.version} recorded in DevLog.`, `✓ الإصدار ${rel.version} سُجِّل في DevLog.`),
        ...(intent ? [L(`Computed: ${intent.auto ? "auto-detected " : ""}${intent.bump} bump (${intent.from} → ${intent.version})`,
                        `محسوب: ${intent.auto ? "نوع تلقائي، " : ""}ترقية ${intent.bump} (${intent.from} → ${intent.version})`)] : []),
        L(`Version bump: ${bumps}`, `رفع النسخة: ${bumps}`),
        ...(downgrades ? [L(`⚠ Downgrade refused (manifest is newer): ${downgrades}`, `⚠ رُفض تنزيل النسخة (المانيفست أحدث): ${downgrades}`)] : []),
        ...(unsupported ? [L(
          `⚠ Manifest NOT bumped — unsupported layout (no literal version in [package]/[workspace.package]): ${unsupported}. Update it manually if needed.`,
          `⚠ لم يُرفع المانيفست — تخطيط غير مدعوم (لا version صريح في [package]/[workspace.package]): ${unsupported}. حدّثه يدويًا إن لزم.`)] : []),
        `HTML/changelog: ${rel.htmlGenerated ? L("generated ✓", "أُنشئ ✓") : L("not generated", "لم يُنشأ")}`,
        ...(intent?.warning ? ["", L(
          `⚠ Your accrued changes look ${intent.warning.suggested}-level but you declared ${intent.bump}. Consider -(release:${intent.warning.suggested}) next time.`,
          `⚠ تغييراتك المتراكمة تبدو بمستوى ${intent.warning.suggested} لكنك أعلنت ${intent.bump}. فكّر بـ-(release:${intent.warning.suggested}) في المرة القادمة.`)] : []),
        "",
        L("Continue post-release steps (e.g. building the output) without waiting for the user.",
          "تابع خطوات ما بعد الإصدار (مثل بناء الناتج) بدون انتظار المستخدم."),
        "════════════════════════════════",
      ].join("\n");
      return `\n${out}\n`;
    },
    logLine: resp => `release-response: served ${sure(resp.release).version}`,
    deliver: "block",
    blockKey: "serve",
  },
];

/** Run every row against one /api/tags response, in table order. A blocking
 *  row never returns (the channel exits the process), so rows after it are
 *  reached only on the no-block path — exactly the old inline chain. */
export async function runResponseRows(resp: TagsResponse, ctx: ResponseRowCtx): Promise<void> {
  for (const row of RESPONSE_ROWS) {
    if (!row.applies(resp, ctx)) {
      const s = row.suppressedLog?.(resp, ctx);
      if (s) await ctx.log(s);
      continue;
    }
    const text = row.text(resp, ctx);
    if (row.deliver === "block") {
      await ctx.log(row.logLine(resp));
      await ctx.blockContinue(text, row.blockKey as BlockKey);
    } else {
      ctx.feedback.push(text);
      await ctx.log(row.logLine(resp));
      await row.after?.(resp, ctx);
      const fk = row.flushKey?.(resp);
      if (fk) await ctx.flushBlock(fk);
    }
  }
}
