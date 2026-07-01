import { PLUGIN_MODE } from "./data";

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
// Gated on PLUGIN_MODE so a dev session (which already loads the global
// CLAUDE.md) doesn't get the same instructions twice. Override with
// DEVLOG_INJECT_PRIMER=0 (force off) or =1 (force on even outside plugin mode).
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
 * Only fires on SessionStart, only in plugin mode (unless forced via env).
 */
export function primerFor(
  type: string,
  opts: { pluginMode?: boolean } = {},
): string {
  const force = process.env.DEVLOG_INJECT_PRIMER;
  if (force === "0") return "";
  const enabled = force === "1" ? true : (opts.pluginMode ?? PLUGIN_MODE);
  if (!enabled) return "";
  if (type !== "SessionStart") return "";
  return PROTOCOL_PRIMER;
}
