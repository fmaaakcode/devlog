// Story nudge (narrative layer P2): a batch that closes a RUN of items (≥2) is
// a chapter ending, and the tags alone record WHAT happened, never the turning
// points between them. The nudge asks for ONE `-(story)`.
//
// It used to BLOCK the batch ("nothing was recorded yet — re-emit the closers
// with or without a story"): 85 of 207 Stop-hook blocks in 53 days, more than
// any safety guard, each one a full extra turn spent re-writing every tag. It
// now rides the batch as a whisper: the closers are recorded first, and a
// story written later names the numbers it narrates (`-(story) #4 #5 …`) —
// linkStoryNums turns that lead into `relatedNums` at ingest.
// Closers-only on purpose: a bare -(release) narrates nothing itself.
// Mute: DEVLOG_STORY_NUDGE=0.

type Lang = (en: string, ar: string) => string;

const STORY_CLOSERS = new Set(["done", "bug fix", "bug fix:interim", "security fix"]);

/** How many closers in the batch make it a chapter ending; 0 = no nudge due
 *  (fewer than 2 closers, a story already present, or muted). */
export function storyNudgeCloserCount(entries: ReadonlyArray<{ tag: string }>, env = process.env): number {
  if (env.DEVLOG_STORY_NUDGE === "0" || entries.some(e => e.tag === "story")) return 0;
  const n = entries.filter(e => STORY_CLOSERS.has(e.tag)).length;
  return n >= 2 ? n : 0;
}

/** The whisper — non-blocking; the batch is already recorded when it is read. */
export function storyWhisper(L: Lang, closerCount: number, closedNums: number[]): string {
  const nums = closedNums.length ? closedNums.map(n => `#${n}`).join(" ") : "#N";
  return [
    "",
    "════════ DevLog Story Nudge ════════",
    L(`This batch closed ${closerCount} item(s) — the tags say WHAT, nothing says HOW it went. They are recorded.`,
      `هذه الدفعة أغلقت ${closerCount} عناصر — التاقات تقول «ماذا»، ولا شيء يقول «كيف جرت». وقد سُجّلت.`),
    L("If the road had turning points worth keeping — an approach that failed, a change of direction, a deliberate deferral — add ONE story at the end of your next response (≤1200 chars, turning points only, never a re-list of the tags):",
      "إن كان للطريق منعطفات تستحق الحفظ — نهج فشل، تغيير اتجاه، تأجيل متعمد — أضف قصةً واحدة في آخر ردّك القادم (≤1200 حرف، المنعطفات فقط، لا إعادة سرد للتاقات):"),
    L(`  -(story) ${nums} <text>`, `  -(story) ${nums} <النص>`),
    L("A straight road with no turns? Nothing to do.", "طريق مستقيم بلا منعطفات؟ لا شيء عليك."),
    "════════════════════════════════════",
    "",
  ].join("\n");
}

/** A story's leading `#N #M` names the items it narrates (the whisper's form,
 *  for a story written AFTER its closers were recorded). Returns the numbers
 *  and the text without them; no lead → no numbers, text unchanged. */
export function linkStoryNums(content: string): { nums: number[]; text: string } {
  const m = content.match(/^\s*((?:#\d+[\s,،]*)+)/);
  if (!m) return { nums: [], text: content };
  const nums = [...new Set([...m[1].matchAll(/#(\d+)/g)].map(x => Number(x[1])))];
  return { nums, text: content.slice(m[0].length).trim() || content };
}
