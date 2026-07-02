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
// happened to start the single shared server — otherwise a manual session
// starting it first would starve later plugin sessions of the primer. Override
// with DEVLOG_INJECT_PRIMER=0 (force off) or =1 (force on regardless).
export const PROTOCOL_PRIMER = `<devlog-protocol>
DevLog مفعّل. في نهاية كل رد أصدر تاقات \`-(tag) content\` (كل تاق سطر مستقل) ليلتقطها الـStop hook — لا تكتب ملفات تتبّع يدوياً. اكتب المحتوى بلغة المستخدم.

التاقات الأساسية:
- \`-(desc)\` وصف سطر واحد · \`-(about)\` وصف مطوّل متعدّد الأسطر
- \`-(built)\` كود جديد لا يخص خطوة خطة · \`-(refactor)\` إعادة هيكلة بلا تغيير سلوك · \`-(update)\` رفع تبعية
- \`-(bug found)\` … / أغلِقه بـ \`-(bug fix) #N\`
- \`-(security)\` / \`-(security:own)\` / \`-(security:dep)\` … / أغلِقه بـ \`-(security fix) #N\`
- \`-(todo)\` … / أغلِقه بـ \`-(done) #N\` أو ألغِه بـ \`-(dropped) #N\`
- \`-(note)\` ملاحظة · \`-(decision)\` قرار معماري · \`-(insight)\` جذر مشكلة
- \`-(doc:report|analysis|plan|comparison|readme)\` اسم\\n<ماركداون>

الإغلاق إلزامي: كل عنصر مفتوح (todo/bug/security/خطوة خطة) يُغلَق بـ\`#N\` في نفس رد إنجاز العمل — لا تنسخ النص (يكسر المطابقة). أرقام \`#N\` تصلك في سياق SessionStart؛ اكتب \`?open\` لرؤية النصوص الكاملة.

محتوى ذرّي: مفهوم واحد لكل تاق، بلا أسئلة أو تخطيط داخل التاق؛ عدّة عناصر → عدّة تاقات.

الإصدارات وGitHub ليست مهمتك — لا \`-(release)\` ولا git إلا بطلب صريح.

للتفاصيل الكاملة (الخطط القابلة للتتبّع doc:plan، تاقات التوثيق، مكتبة المعايير \`-(ask:rules)\`، فحص الثغرات \`-(audit)\`) استخدم مهارة \`devlog:devlog-protocol\`.
</devlog-protocol>`;

/**
 * The protocol primer for a given hook event, or "" when it should not inject.
 * Only fires on SessionStart, and only when the request is a plugin session
 * (`opts.plugin`, set from the inject hook's `?plugin=1`). DEVLOG_INJECT_PRIMER
 * forces it on (=1) or off (=0) regardless.
 */
export function primerFor(
  type: string,
  opts: { plugin?: boolean } = {},
): string {
  const force = process.env.DEVLOG_INJECT_PRIMER;
  if (force === "0") return "";
  if (type !== "SessionStart") return "";
  const enabled = force === "1" ? true : !!opts.plugin;
  return enabled ? PROTOCOL_PRIMER : "";
}
