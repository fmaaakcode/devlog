// Data-integrity invariants of the log itself (#583).
//
// doctor's original checks ask "is the PROJECT healthy?" (stale items, ghost
// releases, thin release commits). These four ask a different question: "is the
// LOG itself intact?" — every one of them is the fingerprint of a real corruption
// this repo has already lived through, and each was found by a human reading rows
// by hand, which is exactly the discipline that doesn't scale.
//
//   · duplicate releases   — the same release stored twice (a hook re-post),
//                            splitting a changelog's range material in two (#567).
//   · duplicate tags       — the same shape for everything that ISN'T a release
//                            (#590). Split out rather than folded in because the
//                            release case alone has on-disk consequences.
//   · bloated twins        — the #486/#487 class: a turn re-read re-parsed the SAME
//                            tag with MORE content swallowed from the continuation,
//                            so it stored a SECOND time under a new identity.
//   · multi-line headlines — a single-line-by-protocol tag whose stored content
//                            carries newlines: the body-capture leak the parser cut
//                            has since closed, but the damage already on disk needs
//                            a detector — nothing else surfaces it.
//   · number gaps          — an item number consumed by no item. Usually benign
//                            (an -(undo) removed the tag), which is why this one is
//                            reported LOW: it's a lead, not a verdict.
//
// Pure over the stored data — no server, no disk — so each is unit-testable and
// can also run in-process at SessionStart (see inject-warnings.ts).

import { SINGLE_LINE_TAGS } from "./tag-parser";
import type { DevLogData, TagEntry, PlanEntry } from "./types";
import { currentLang } from "./i18n";

export interface Finding {
  severity: "high" | "medium" | "low";
  code: string;
  title: string;
  detail: string;
  items?: string[];
}

// Two entries written "at the same moment" — a re-post, not two decisions. Wide
// enough to cover a slow continuation chain (a hook re-read minutes later), narrow
// enough that two genuine same-text tags a day apart are not accused.
const NEAR_MS = 15 * 60 * 1000;

const ms = (t: string): number => {
  const v = Date.parse(t);
  return Number.isFinite(v) ? v : 0;
};

// Content compared for IDENTITY, not for display: whitespace runs collapse, case
// folds. Two tags differing only in a trailing newline are the same tag.
const norm = (s: string): string => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

// The reason behind a release's version: `vX.Y.Z — reason` → "reason" (the same
// shape resolveReleaseIntent writes at store time). Content with no leading
// version returns unchanged.
const releaseReason = (s: string): string => {
  const m = (s || "").trim().match(/^v?\d[\w.\-+]*\s*(?:[—–\-:|]\s*)?/);
  return m ? (s || "").trim().slice(m[0].length) : (s || "").trim();
};

/**
 * Releases stored twice: identical content minutes apart (a verbatim re-post) —
 * OR (#594) the same non-empty REASON under two DIFFERENT versions minutes
 * apart. The second shape is what a replayed version-less -(release) mints:
 * each pass re-derives the next number from the then-live state, so the twins
 * never compare text-equal (v3.13.0→v3.13.3 landed from ONE release line) and
 * the old identical-content criterion was blind to exactly the worst case.
 * Version-only releases with no reason are never matched across versions —
 * two bare quick successive releases are plausible, not twins.
 */
export function duplicateReleases(tags: TagEntry[]): Finding | null {
  const releases = tags
    .filter(t => t.tag === "release" || t.tag.startsWith("release:"))
    .sort((a, b) => ms(a.timestamp) - ms(b.timestamp));

  const dups: string[] = [];
  for (let i = 0; i < releases.length; i++) {
    for (let j = i + 1; j < releases.length; j++) {
      const dt = ms(releases[j].timestamp) - ms(releases[i].timestamp);
      if (dt > NEAR_MS) break;                       // sorted → nothing further is near
      const sameText = norm(releases[i].content) === norm(releases[j].content);
      const reason = norm(releaseReason(releases[i].content));
      const sameReason = !sameText && !!reason && reason === norm(releaseReason(releases[j].content));
      if (!sameText && !sameReason) continue;
      dups.push(sameText
        ? `«${(releases[i].content || "").slice(0, 60)}» ×2 (${Math.round(dt / 1000)}s apart)`
        : `«${(releases[i].content || "").slice(0, 40)}» و«${(releases[j].content || "").slice(0, 40)}» — نفس السبب بنسختين (${Math.round(dt / 1000)}s apart)`);
    }
  }
  if (!dups.length) return null;
  return {
    severity: "high",
    code: "DUPLICATE_RELEASES",
    title: `${dups.length} إصدار مخزَّن مرتين — نص متطابق أو نفس السبب بنسختين متقاربتي الطوابع`,
    detail: "إعادة إرسال من الـhook خزّنت الإصدار مرتين (وقد تسك النسخة الثانية رقمًا أعلى) — الثاني يقسّم مادة الـchangelog ويصطدم بحارس «ليس أحدث». احذف التوأم بـ-(undo).",
    items: dups.slice(0, 10),
  };
}

/**
 * The same NON-release tag stored twice, byte-identical, minutes apart.
 *
 * The blind spot this closes (#590): the two checks that look for a re-post each
 * covered half the shape and nothing covered the overlap. duplicateReleases finds
 * an exact re-post but only among releases; bloatedTwins finds a re-post of any
 * tag but only when the second copy GREW ("identical isn't a twin; only growth" —
 * it was written for the #486/#487 swallowed-tail signature). An exact re-post of
 * a `dropped` or `built` tag walked past both: five such pairs were sitting in the
 * live log, four of them 96s apart — ONE hook re-post that left four duplicate rows.
 *
 * MEDIUM, not high: unlike a duplicate release this has no on-disk consequences
 * (no changelog split, no not-newer guard). It lies in the aggregates instead —
 * study counts work tag-by-tag, and release-html prints a row per tag.
 */
export function duplicateTags(tags: TagEntry[]): Finding | null {
  // Releases are duplicateReleases' beat: same shape, different remedy (rollback),
  // different severity. Filtering them here keeps one finding per corruption.
  const sorted = [...tags]
    .filter(t => t.tag !== "release" && !t.tag.startsWith("release:"))
    .sort((a, b) => ms(a.timestamp) - ms(b.timestamp));

  const dups: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const an = norm(a.content);
    if (!an) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const dt = ms(b.timestamp) - ms(a.timestamp);
      if (dt > NEAR_MS) break;                       // sorted → nothing further is near
      if (b.tag !== a.tag || norm(b.content) !== an) continue;
      dups.push(`[${a.tag}] «${(a.content || "").slice(0, 50)}» ×2 (${Math.round(dt / 1000)}s apart)`);
    }
  }
  if (!dups.length) return null;
  return {
    severity: "medium",
    code: "DUPLICATE_TAGS",
    title: `${dups.length} تاق مخزَّن مرتين بنص متطابق خلال دقائق`,
    detail: "إعادة إرسال من الـhook: حدث واحد خلّف صفين. لا أثر على القرص كتكرار الإصدار، لكن الصف المكرر يتضاعف في مجاميع الدراسة ويُطبع مرتين في صفحة الإصدار. احذف الزائدة بـ-(undo).",
    items: dups.slice(0, 10),
  };
}

/**
 * Bloated twins: same tag type, one content a strict PREFIX of the other, minutes
 * apart. Two causes produce that shape, and the check deliberately doesn't try to
 * tell them apart (the live log holds both): a turn re-read that re-parsed the tag
 * with the continuation's prose glued on (#486/#487), or a continuation that
 * re-emitted the tag with a fuller wording — which slips past the server's content
 * dedup precisely BECAUSE the text changed. Either way the log now carries two
 * entries for one event, which is the finding. The cause is for the human to read.
 */
export function bloatedTwins(tags: TagEntry[]): Finding | null {
  const sorted = [...tags].sort((a, b) => ms(a.timestamp) - ms(b.timestamp));
  const twins: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const an = norm(a.content);
    if (an.length < 10) continue;                    // too short to judge a prefix on
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (ms(b.timestamp) - ms(a.timestamp) > NEAR_MS) break;
      if (b.tag !== a.tag) continue;
      const bn = norm(b.content);
      if (an === bn || !bn.startsWith(an)) continue;  // identical isn't a twin; only growth
      twins.push(`[${a.tag}] «${(a.content || "").slice(0, 40)}…» ثم نسخة أطول بـ${bn.length - an.length} حرفًا`);
    }
  }
  if (!twins.length) return null;
  return {
    severity: "high",
    code: "BLOATED_TWINS",
    title: `${twins.length} توأم متضخّم — نفس التاق مخزَّن مرتين خلال دقائق، الثانية امتداد نصّي للأولى`,
    detail: "إما ذيل مبتلَع من إعادة قراءة الدور (#486/#487)، وإما إعادة إصدار بصياغة أوسع في متابعة (تتجاوز فلتر التكرار لأن النص تغيّر). في الحالتين: مدخلتان لحدث واحد. اقرأ الزوج واحذف الزائدة بـ-(undo).",
    items: twins.slice(0, 10),
  };
}

/** A single-line-by-protocol tag whose stored content spans lines. */
export function multilineHeadlines(tags: TagEntry[]): Finding | null {
  const bad = tags.filter(t => SINGLE_LINE_TAGS.has(t.tag) && /\r?\n/.test(t.content || ""));
  if (!bad.length) return null;
  return {
    severity: "medium",
    code: "MULTILINE_HEADLINE_TAGS",
    title: `${bad.length} تاق أحادي السطر بحكم البروتوكول مخزَّن بمحتوى متعدد الأسطر`,
    detail: "أثر تسريب قديم من البارسر (يُقصّ عند السطر الأول الآن). المحتوى بعد السطر الأول ليس جزءًا من التاق — نقّه أو أعد إصداره.",
    items: bad.slice(0, 10).map(t => `${typeof t.num === "number" ? `#${t.num} ` : ""}[${t.tag}] ${(t.content || "").split(/\r?\n/)[0].slice(0, 60)}… (+${(t.content.match(/\r?\n/g) || []).length} سطر)`),
  };
}

/** Item numbers consumed by no surviving item. */
export function numberGaps(tags: TagEntry[], plans: PlanEntry[]): Finding | null {
  const used = new Set<number>();
  for (const t of tags) if (typeof t.num === "number") used.add(t.num);
  for (const p of plans) for (const s of p.steps || []) if (typeof s.num === "number") used.add(s.num);
  if (!used.size) return null;

  const max = Math.max(...used);
  const gaps: number[] = [];
  for (let n = 1; n <= max; n++) if (!used.has(n)) gaps.push(n);
  if (!gaps.length) return null;

  // Compact consecutive runs: "#12–#15" reads; twelve separate numbers don't.
  const runs: string[] = [];
  for (let i = 0; i < gaps.length;) {
    let j = i;
    while (j + 1 < gaps.length && gaps[j + 1] === gaps[j] + 1) j++;
    runs.push(i === j ? `#${gaps[i]}` : `#${gaps[i]}–#${gaps[j]}`);
    i = j + 1;
  }
  return {
    severity: "low",
    code: "ITEM_NUMBER_GAPS",
    title: `${gaps.length} رقم عنصر لا يحمله أي عنصر (من #1 إلى #${max})`,
    detail: "غالبًا حميد: -(undo) حذف تاقًا فبقي رقمه شاغرًا. يصير مقلقًا لو تزامن مع كتابات ضائعة — قارنه بسجل الأحداث.",
    items: runs.slice(0, 15),
  };
}

/** Every invariant, for one project's slice of the log. */
export function checkInvariants(tags: TagEntry[], plans: PlanEntry[]): Finding[] {
  return [
    duplicateReleases(tags),
    duplicateTags(tags),
    bloatedTwins(tags),
    multilineHeadlines(tags),
    numberGaps(tags, plans),
  ].filter((f): f is Finding => f !== null);
}

/** How far back the automatic check looks. See integrityWarning. */
export const RECENT_DAYS = 7;

/**
 * The automation (#583): doctor only ever ran when a human remembered to type it,
 * and log corruption is exactly what nobody thinks to look for. The invariants are
 * pure and in-memory, so SessionStart can run them on the project it touches —
 * free enough to be regular, regular enough to catch damage the week it happens.
 *
 * Two deliberate narrowings, both learned from running this against the live log:
 *
 *   · RECENT WINDOW. The real log carries years of historical damage (8 twins from
 *     April, 17 multi-line releases from v0.x). Alerting on the whole backlog would
 *     fire EVERY session forever with nothing the user can plausibly clear — the
 *     definition of a nag, and the fastest way to teach someone to skip the line.
 *     The automation asks "did we break something THIS week?"; the full history
 *     stays doctor's job, on demand, when a human is actually there to clean it.
 *   · A POINTER, never a second report. The finding lists belong to doctor (one
 *     surface per audience); this line only says "there is something to look at".
 *
 * LOW findings (number gaps — usually just an -(undo)) never surface here.
 */
export function integrityWarning(data: DevLogData, project: string, recentDays = RECENT_DAYS): string | null {
  const since = Date.now() - recentDays * 86400000;
  const tags = (data.tags || []).filter(t => t.project === project && ms(t.timestamp) >= since);
  if (!tags.length) return null;

  // Number gaps are excluded by construction, not by severity: computed over a
  // 7-day slice, EVERY number below the window reads as a gap. A window-scoped
  // check must only run invariants that are meaningful within the window.
  const findings = [
    duplicateReleases(tags),
    duplicateTags(tags),
    bloatedTwins(tags),
    multilineHeadlines(tags),
  ].filter((f): f is Finding => f !== null && f.severity !== "low");
  if (!findings.length) return null;

  const codes = findings.map(f => f.code).join(", ");
  return currentLang() === "ar"
    ? `[DevLog] ⚠ سلامة السجل: ${findings.length} خلل بنيوي في تاقات «${project}» خلال آخر ${recentDays} أيام (${codes}). شغّل \`bun src/doctor.ts\` للتفاصيل والإصلاح.`
    : `[DevLog] ⚠ log integrity: ${findings.length} structural problem(s) in «${project}»'s tags in the last ${recentDays} days (${codes}). Run \`bun src/doctor.ts\` for the detail and the fix.`;
}
