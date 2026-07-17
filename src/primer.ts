import { currentLang, type Lang } from "./i18n";

// Compact, always-on protocol primer.
//
// In the old clone-based install, DevLog's tag vocabulary had to be copied into
// the user's global ~/.claude/CLAUDE.md so Claude knew to emit tags. As a plugin
// we DON'T touch the user's global file: instead this compact primer is injected
// once per session at SessionStart (via /api/inject) so Claude knows the minimum
// vocabulary + closure rule. The FULL reference (plans, doc tags, standards,
// audit) lives in the `devlog-protocol` skill, loaded on demand — keeping the
// always-on token cost small.
//
// The decision is PER-REQUEST, not per-server-process: the inject hook signals
// whether the calling session is a plugin session (`?plugin=1`). A plugin's
// bundled hooks always send it; a manual/dev project's hook (which has its own
// CLAUDE.md) does not. This keeps the primer independent of which session
// happened to start the single shared server. Override with
// DEVLOG_INJECT_PRIMER=0 (force off) or =1 (force on regardless). Language
// follows DEVLOG_LANG (English by default).

const PRIMER_EN = `<devlog-protocol>
DevLog is active. At the end of every response, emit \`-(tag) content\` markers (one tag per line) for the Stop hook to capture — don't hand-write tracking files. Write the content in the user's language.

Core tags:
- \`-(desc)\` the project's STABLE one-line identity ("what is this project?") — never a session summary; it shows under the project name and as the client report's subtitle, so re-emit only when the project itself changes · \`-(about)\` the long description: plain-language "what it is / how it works" + the concrete stack (language, runtime, frameworks, key libraries, integration points) — a compact technical ID card, not marketing prose
- \`-(built)\` new code not mapping to a plan step · \`-(refactor)\` restructure without behavior change · \`-(update)\` dependency bump
- \`-(bug found)\` … / close with \`-(bug fix) #N\`
- \`-(security)\` / \`-(security:own)\` / \`-(security:dep)\` … / close with \`-(security fix) #N\`
- \`-(todo)\` … / close with \`-(done) #N\` or cancel with \`-(dropped) #N\`
- \`-(upcoming)\` deferred tier: create directly, or \`-(upcoming) #N\` to defer an open todo/bug (\`-(todo) #N\` promotes back). Never blocks a release; security is never deferrable.
- \`-(feature)\` one client-language line per capability the client can see, declared when it lands (not per code step) · \`-(feature update) #N new text\` · \`-(feature removed) #N\` · pull the current inventory with \`-(ask:features)\` · backfill old releases: \`-(ask:backfill)\` lists the uncovered ones; after user approval declare each as \`-(feature) [vX.Y.Z] <line>\` to pin it to the past release that shipped it
- \`-(note)\` observation · \`-(decision)\` architectural decision · \`-(insight)\` root cause
- \`-(doc:report|analysis|plan|comparison|readme)\` name\\n<markdown>

Closure is mandatory: every open item (todo/bug/security/plan step) is closed by \`#N\` in the same response that finishes the work — never copy the text (it breaks matching). Opened AND finished in the SAME response (e.g. \`-(bug found)\` + its fix)? emit the closer with NO number — DevLog pairs them; NEVER guess the next \`#N\` (numbers are assigned only after your response ends). \`#N\` numbers arrive in the SessionStart context; type \`?open\` for the full text, or emit \`-(ask:open)\` yourself to pull the live open list mid-session before closing. To check whether an item is ALREADY closed (and when/how), emit \`-(ask:closed) #N\` — don't grep \`.devlog/\` files or re-investigate finished work; that trace is authoritative. For a retrospective (EVERY bug/security report, open and closed, with ages and files — "what keeps breaking?") emit \`-(ask:retro)\` and codify recurring patterns with \`-(rule:add)\` or \`-(insight)\`. For a full deep study (whole-history discipline aggregates + narrative delta since the last study) emit \`-(ask:study)\` and store the result as \`-(doc:report) study-YYYY-MM-DD <title>\` — the \`study-\` prefix makes it the next study's watermark.

Before ADDING a new dependency, emit \`-(ask:lib) <name…>\` (up to 8) — DevLog answers with the exact version to install: newest stable ≥7 days old that OSV certifies clean. Don't research versions yourself and don't install blind \`@latest\`. A \`npm:\`/\`pypi:\`/\`crates:\` prefix on a name overrides the project's ecosystem.

To recall recorded history ("why did we choose X?", "have we hit this before?"), emit \`-(ask:search) <query>\` — DevLog answers with the best-matching stored tags (decisions, insights, closed bugs with their fixes). \`-(ask:search) all: <query>\` widens the search to every tracked project. Prefer it over re-deriving a past decision or re-investigating a solved problem.

Atomic: one concept per tag; no questions or planning prose inside a tag; multiple items → multiple tags.

Releasing: ONLY when the user asks to ship. Then just emit \`-(release) <one-line reason>\` — **DevLog auto-detects the bump type (patch/minor/major) and computes the version number.** Never write the version number yourself, and don't pick the type unless the user names one (then use \`-(release:patch|minor|major)\`). git/GitHub is never your job.

For the full reference (trackable plans doc:plan, doc tags, the standards library \`-(ask:rules)\`, the vuln audit \`-(audit)\`) use the \`devlog:devlog-protocol\` skill.
</devlog-protocol>`;

const PRIMER_AR = `<devlog-protocol>
DevLog مفعّل. في نهاية كل رد أصدر تاقات \`-(tag) content\` (كل تاق سطر مستقل) ليلتقطها الـStop hook — لا تكتب ملفات تتبّع يدوياً. اكتب المحتوى بلغة المستخدم.

التاقات الأساسية:
- \`-(desc)\` هوية المشروع الثابتة بسطر واحد («ما هذا المشروع؟») — ليس ملخص جلسة أبداً؛ يظهر تحت اسم المشروع وكعنوان فرعي في تقرير العميل، فلا تعِد إصداره إلا إذا تغيّر المشروع نفسه · \`-(about)\` الوصف المطوّل: «ما هو وكيف يعمل» بلغة بسيطة + الستاك الفعلي (اللغة، الـruntime، الأطر، المكتبات المهمة، نقاط التكامل) — بطاقة تعريف تقنية مضغوطة لا نصاً تسويقياً
- \`-(built)\` كود جديد لا يخص خطوة خطة · \`-(refactor)\` إعادة هيكلة بلا تغيير سلوك · \`-(update)\` رفع تبعية
- \`-(bug found)\` … / أغلِقه بـ \`-(bug fix) #N\`
- \`-(security)\` / \`-(security:own)\` / \`-(security:dep)\` … / أغلِقه بـ \`-(security fix) #N\`
- \`-(todo)\` … / أغلِقه بـ \`-(done) #N\` أو ألغِه بـ \`-(dropped) #N\`
- \`-(upcoming)\` طبقة المؤجَّل: أنشئ مباشرة، أو \`-(upcoming) #N\` لتأجيل todo/bug مفتوح (\`-(todo) #N\` يرقّيه). لا توقف الإصدار أبداً؛ الأمن لا يؤجَّل.
- \`-(feature)\` سطر واحد بلغة العميل لكل قدرة يلمسها العميل، يُعلَن عند اكتمالها (لا لكل خطوة كود) · \`-(feature update) #N نص جديد\` · \`-(feature removed) #N\` · اسحب القائمة الحالية بـ\`-(ask:features)\` · تعبئة الإصدارات القديمة: \`-(ask:backfill)\` يسرد غير المغطى منها؛ بعد موافقة المستخدم أعلن كل قدرة بـ\`-(feature) [vX.Y.Z] <سطر>\` لتُنسب للإصدار الماضي الذي شحنها
- \`-(note)\` ملاحظة · \`-(decision)\` قرار معماري · \`-(insight)\` جذر مشكلة
- \`-(doc:report|analysis|plan|comparison|readme)\` اسم\\n<ماركداون>

الإغلاق إلزامي: كل عنصر مفتوح (todo/bug/security/خطوة خطة) يُغلَق بـ\`#N\` في نفس رد إنجاز العمل — لا تنسخ النص (يكسر المطابقة). فتحتَ وأنهيتَ في الرد نفسه (مثل \`-(bug found)\` مع إصلاحه)؟ أصدر الإغلاق بلا رقم إطلاقاً — DevLog يقرنهما تلقائياً؛ لا تخمّن الرقم التالي أبداً (الأرقام تُسند بعد انتهاء ردك). أرقام \`#N\` تصلك في سياق SessionStart؛ اكتب \`?open\` لرؤية النصوص الكاملة، أو أصدر \`-(ask:open)\` بنفسك لسحب قائمة المفتوح الحيّة أثناء الجلسة قبل الإغلاق. وللتأكّد أنّ عنصراً أُغلق بالفعل (ومتى/كيف) أصدر \`-(ask:closed) #N\` — لا تـgrep ملفات \`.devlog/\` ولا تعيد التحقيق في عمل مُنجَز؛ هذا الأثر هو المرجع. وللتحليل الرجعي (كل بلاغات bug/security، المفتوح والمغلق، بالأعمار والملفات — «ما الذي يتكرر كسره؟») أصدر \`-(ask:retro)\` وثبّت الأنماط المتكررة بـ\`-(rule:add)\` أو \`-(insight)\`. وللدراسة العميقة الشاملة (مجاميع الانضباط على كامل التاريخ + دلتا سردية منذ آخر دراسة) أصدر \`-(ask:study)\` وخزّن الناتج بـ\`-(doc:report) study-YYYY-MM-DD <عنوان>\` — بادئة \`study-\` تجعله علامة المياه للدراسة التالية.

قبل إضافة تبعية جديدة أصدر \`-(ask:lib) <اسم…>\` (حتى 8) — يجيبك DevLog بالنسخة الدقيقة للتركيب: أحدث مستقرة عمرها ≥7 أيام يشهد OSV بنظافتها. لا تبحث عن النسخ بنفسك ولا تركّب \`@latest\` أعمى. بادئة \`npm:\`/\`pypi:\`/\`crates:\` على الاسم تتجاوز نظام المشروع.

لاسترجاع التاريخ المسجَّل («لماذا اخترنا X؟»، «هل مررنا بهذا قبل؟») أصدر \`-(ask:search) <سؤال>\` — يجيبك DevLog بأفضل التاقات المطابقة (قرارات، insights، بلاغات مغلقة مع إصلاحاتها). \`-(ask:search) all: <سؤال>\` يوسّع البحث لكل المشاريع المتتبَّعة. فضّله على إعادة اشتقاق قرار ماضٍ أو إعادة التحقيق في مشكلة محلولة.

محتوى ذرّي: مفهوم واحد لكل تاق، بلا أسئلة أو تخطيط داخل التاق؛ عدّة عناصر → عدّة تاقات.

الإصدار: فقط حين يطلب المستخدم الإصدار. عندها أصدر \`-(release) <سبب سطر واحد>\` — **DevLog يكتشف نوع الترقية (patch/minor/major) ويحسب رقم النسخة تلقائيًا.** لا تكتب رقم النسخة بنفسك، ولا تحدّد النوع إلا لو سمّاه المستخدم (وقتها \`-(release:patch|minor|major)\`). git ليست مهمتك أبدًا.

للتفاصيل الكاملة (الخطط القابلة للتتبّع doc:plan، تاقات التوثيق، مكتبة المعايير \`-(ask:rules)\`، فحص الثغرات \`-(audit)\`) استخدم مهارة \`devlog:devlog-protocol\`.
</devlog-protocol>`;

export const PRIMERS: Record<Lang, string> = { en: PRIMER_EN, ar: PRIMER_AR };

/**
 * The protocol primer for a given hook event, or "" when it should not inject.
 * Only fires on SessionStart, and only when the request is a plugin session
 * (`opts.plugin`, set from the inject hook's `?plugin=1`). DEVLOG_INJECT_PRIMER
 * forces it on (=1) or off (=0) regardless. Language follows opts.lang, else
 * DEVLOG_LANG (English by default).
 */
export function primerFor(
  type: string,
  opts: { plugin?: boolean; lang?: Lang } = {},
): string {
  const force = process.env.DEVLOG_INJECT_PRIMER;
  if (force === "0") return "";
  if (type !== "SessionStart") return "";
  const enabled = force === "1" ? true : !!opts.plugin;
  if (!enabled) return "";
  return PRIMERS[opts.lang ?? currentLang()];
}
