// The `-(ask:study)` corpus: deep-study material for one project, from its
// first tag to now. Same architectural split as retro/backfill — the server
// computes FACTS; the interpretation (the report Claude stores back as
// `-(doc:report) study-…`) is language work done in-context, never here.
//
// Studies are RANGES, exactly like releases: study N covers (study N−1, now].
// The watermark is the PREVIOUS STUDY REPORT ITSELF — the newest `doc:report`
// tag whose name line starts with `study`/`دراسة` — so incrementality needs no
// new storage. The corpus splits by how material grows with project age:
//   - aggregates: whole-history statistics (medians, monthly trend, release
//     hygiene). Naturally compact — 3 years of trend is 36 rows — so every
//     study recomputes them over the FULL history and keeps its spine.
//   - delta: narrative material (problem texts, decisions, releases). Grows
//     linearly with age, so it's served only for the window since the
//     watermark, capped like backfill's MATERIAL_CAP.
// Delta membership is "TOUCHED since", not "created since": an old item
// reopened or closed after the watermark enters the window — recurrence is the
// one signal that must cross study boundaries (⟲ reopenOf).
//
// The previous study's conclusions ride along as a digest, so Claude BUILDS ON
// its own prior interpretation (confirm a pattern held, or declare it broken)
// instead of re-deriving a studied year from scratch.

import type { DevLogData, TagEntry } from "./types";
import {
  openTodos, openBugs, openSecurity, openPlanSteps,
  CLOSER_FOR, normalizeTagContent,
} from "./data";
import { closedItems } from "./closed-items";
import { retroCorpus, fragileFiles, regressionGap, type FragileFile, type RetroItem, type TestGap } from "./retro";
import { backfillCorpus } from "./features";
import { isRealVersion, parseVersion } from "./release-html";

// Caps keep the corpus in-context small on old projects (house pattern:
// backfill's MATERIAL_CAP). Aggregates are exempt — they don't grow that way.
const DELTA_PROBLEMS_CAP = 60;
const DELTA_RELEASES_CAP = 40;
const DELTA_KNOWLEDGE_CAP = 30;
const DELTA_LONGEST_CAP = 8;
const DELTA_LINE_CAP = 160;
const DIGEST_CAP = 1200;

const DAY_MS = 86_400_000;
const days = (a: string | number, b: string | number) =>
  Math.max(0, Math.round(((+new Date(b)) - (+new Date(a))) / DAY_MS));
const cap = (s: string, n = DELTA_LINE_CAP) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ── Watermark: the previous study report ────────────────────────────────────

/** Name-line convention that marks a doc:report as a STUDY (the watermark).
 *  Documented in the skill: `-(doc:report) study-YYYY-MM-DD …` (or دراسة-…). */
export const STUDY_NAME_RE = /^\s*(study|دراسة)(?:[\s\-_:.]|$)/i;

/** A previous study sourced from the DOC STORE (.devlog/docs) rather than the
 *  tags store. doc:* tags stopped being persisted as tag rows, so a study saved
 *  since then is invisible to findPrevStudy — every ask:study came back
 *  FOUNDATIONAL and the conclusions chain silently broke (#618). The route
 *  reads the newest study-named report doc and passes it in; `content` follows
 *  the tag convention (name line + markdown body) so studyDigest applies as-is. */
export interface PrevStudyDoc { name: string; at: string; content: string }

/** Newest stored study report tag, or undefined when none exists yet
 *  (→ the next study is FOUNDATIONAL: its window is the whole history). */
export function findPrevStudy(tags: TagEntry[]): TagEntry | undefined {
  let best: TagEntry | undefined;
  for (const t of tags) {
    if (t.tag !== "doc:report") continue;
    const name = t.content.split("\n", 1)[0] ?? "";
    if (!STUDY_NAME_RE.test(name)) continue;
    if (!best || +new Date(t.timestamp) > +new Date(best.timestamp)) best = t;
  }
  return best;
}

/**
 * Compact digest of a study report body: the conclusions section when one
 * exists (heading containing خلاصة/استنتاج/conclusion/summary), else the head
 * of the document. Feeding conclusions — not the whole report — is what lets
 * study N+1 stand on N without re-reading it.
 */
export function studyDigest(content: string): string {
  const body = content.split("\n").slice(1).join("\n");
  const lines = body.split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (h && /خلاصة|استنتاج|conclusion|summary/i.test(h[2])) { start = i + 1; level = h[1].length; break; }
  }
  let picked: string[];
  if (start >= 0) {
    picked = [];
    for (let i = start; i < lines.length; i++) {
      const h = lines[i].match(/^(#{1,6})\s/);
      if (h && h[1].length <= level) break;   // section ends at same-or-shallower heading
      picked.push(lines[i]);
    }
  } else {
    picked = lines;
  }
  const text = picked.map(l => l.trim()).filter(Boolean).join("\n");
  return text.length > DIGEST_CAP ? `${text.slice(0, DIGEST_CAP)}…` : text;
}

// ── Corpus shapes ────────────────────────────────────────────────────────────

export interface StudyWindow {
  /** ISO start (the previous study's timestamp). Absent = foundational. */
  from?: string;
  to: string;
  foundational: boolean;
  prevStudy?: { name: string; at: string; digest: string };
}

export interface MonthRow { month: string; opened: number; closed: number; released: number; }
export interface ClosureRow { kind: string; closed: number; medianDays: number; maxDays: number; }

/** Work-rhythm profile derived from tag timestamps (SERVER-LOCAL time — the
 *  daemon runs on the user's machine, so local == the user's clock). Tags are
 *  the one store that reaches the project's first day uncapped, which makes
 *  this the only user-behavior signal that can be recovered retroactively;
 *  session events started much later and prompts are never stored at all. */
export interface BehaviorProfile {
  /** Tag count per local hour-of-day, index 0–23. */
  hourHistogram: number[];
  /** Tag count per local weekday, index 0–6 (0 = Sunday). */
  weekdayHistogram: number[];
  /** Days with ≥1 tag / calendar days first→last. */
  activeDays: number;
  spanDays: number;
  longestStreakDays: number;
  longestGapDays: number;
  sessions: { count: number; medianTags: number; medianSpanMinutes: number; maxTags: number };
}

export interface StudyAggregates {
  firstTagAt?: string;
  lastTagAt?: string;
  totalTags: number;
  taggedSessions: number;
  byType: Record<string, number>;
  monthly: MonthRow[];
  closure: ClosureRow[];
  openNow: { todos: number; bugs: number; security: number; planSteps: number; deferred: number; oldestOpenDays?: number };
  behavior: BehaviorProfile;
  releases: { total: number; dirty: number; securityDirty: number; latest?: { version: string; at: string } };
  plans: { total: number; steps: number; closedSteps: number };
  problems: { reports: number; reopens: number; fragile: FragileFile[]; testGap: TestGap };
  features: { declared: number; backfilled: number; uncoveredReleases: number };
}

export interface StudyDelta {
  releases: { items: Array<{ version: string; at: string; summary: string }>; more: number };
  /** Problem reports TOUCHED in the window (opened, closed or reopened). */
  problems: { items: RetroItem[]; more: number };
  knowledge: { items: Array<{ kind: string; at: string; text: string }>; more: number };
  /** Longest-lived items CLOSED in the window — the debt the period paid off. */
  longestClosed: Array<{ num?: number; kind: string; ageDays: number; text: string }>;
  work: { built: number; refactor: number; update: number };
}

export interface StudyCorpus { window: StudyWindow; aggregates: StudyAggregates; delta: StudyDelta; }

// ── Aggregates (whole history — compact by nature) ──────────────────────────

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Local calendar day of a timestamp (the daemon's clock == the user's). */
const localDay = (ts: string): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function buildBehavior(tags: TagEntry[]): BehaviorProfile {
  const hourHistogram = new Array<number>(24).fill(0);
  const weekdayHistogram = new Array<number>(7).fill(0);
  const days = new Set<string>();
  const bySession = new Map<string, { first: number; last: number; n: number }>();
  for (const t of tags) {
    const d = new Date(t.timestamp);
    hourHistogram[d.getHours()]++;
    weekdayHistogram[d.getDay()]++;
    days.add(localDay(t.timestamp));
    if (t.session_id) {
      const ms = +d;
      const s = bySession.get(t.session_id);
      if (!s) bySession.set(t.session_id, { first: ms, last: ms, n: 1 });
      else { s.first = Math.min(s.first, ms); s.last = Math.max(s.last, ms); s.n++; }
    }
  }

  // Streaks and gaps over the active-day calendar. Day keys are local and
  // zero-padded, so lexicographic sort == chronological.
  const sorted = [...days].sort();
  let longestStreakDays = sorted.length ? 1 : 0;
  let longestGapDays = 0;
  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = Math.round((+new Date(sorted[i]) - +new Date(sorted[i - 1])) / DAY_MS);
    if (gap === 1) streak++;
    else { longestGapDays = Math.max(longestGapDays, gap - 1); streak = 1; }
    longestStreakDays = Math.max(longestStreakDays, streak);
  }
  const spanDays = sorted.length
    ? Math.round((+new Date(sorted[sorted.length - 1]) - +new Date(sorted[0])) / DAY_MS) + 1
    : 0;

  const sess = [...bySession.values()];
  const sessions = {
    count: sess.length,
    medianTags: median(sess.map(s => s.n)),
    medianSpanMinutes: Math.round(median(sess.map(s => (s.last - s.first) / 60_000))),
    maxTags: sess.length ? Math.max(...sess.map(s => s.n)) : 0,
  };

  return { hourHistogram, weekdayHistogram, activeDays: days.size, spanDays, longestStreakDays, longestGapDays, sessions };
}

/** todo | bug found | security — security:* folds into one row. */
const closureKind = (kind: string): string | null =>
  kind === "todo" || kind === "bug found" ? kind : kind.startsWith("security") ? "security" : null;

function buildAggregates(data: DevLogData, project: string, now: number): StudyAggregates {
  const tags = data.tags.filter(t => t.project === project);
  const closed = closedItems(data, project);
  const openerTags = new Set(Object.keys(CLOSER_FOR));
  const openers = tags.filter(t => openerTags.has(t.tag));

  const byType: Record<string, number> = {};
  const sessions = new Set<string>();
  let firstTagAt: string | undefined;
  let lastTagAt: string | undefined;
  for (const t of tags) {
    byType[t.tag] = (byType[t.tag] ?? 0) + 1;
    if (t.session_id) sessions.add(t.session_id);
    if (!firstTagAt || t.timestamp < firstTagAt) firstTagAt = t.timestamp;
    if (!lastTagAt || t.timestamp > lastTagAt) lastTagAt = t.timestamp;
  }

  // Monthly trend: opened work items / closed items / releases per month.
  const monthMap = new Map<string, MonthRow>();
  const row = (m: string) => {
    let r = monthMap.get(m);
    if (!r) { r = { month: m, opened: 0, closed: 0, released: 0 }; monthMap.set(m, r); }
    return r;
  };
  for (const t of openers) row(t.timestamp.slice(0, 7)).opened++;
  for (const c of closed) if (c.closedAt) row(c.closedAt.slice(0, 7)).closed++;
  const releaseTags = tags
    .filter(t => t.tag === "release" && isRealVersion(t.content))
    .sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp));
  for (const r of releaseTags) row(r.timestamp.slice(0, 7)).released++;
  const monthly = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));

  // Time-to-close per kind (closed items with both endpoints).
  const byKind = new Map<string, number[]>();
  for (const c of closed) {
    const k = closureKind(c.kind);
    if (!k || !c.openedAt || !c.closedAt) continue;
    const arr = byKind.get(k) ?? [];
    arr.push(days(c.openedAt, c.closedAt));
    byKind.set(k, arr);
  }
  const closure: ClosureRow[] = [...byKind.entries()].map(([kind, ages]) => ({
    kind, closed: ages.length, medianDays: median(ages), maxDays: Math.max(...ages),
  })).sort((a, b) => a.kind.localeCompare(b.kind));

  // Open now (openTodos/... include deferred items; count them apart so the
  // report can tell tracked debt from recorded ambition).
  const oTodos = openTodos(tags), oBugs = openBugs(tags), oSec = openSecurity(tags);
  const oSteps = openPlanSteps(data, project);
  const allOpen = [...oTodos, ...oBugs, ...oSec];
  const deferred = allOpen.filter(t => t.upcoming).length;
  const activeOpen = allOpen.filter(t => !t.upcoming);
  const openNow = {
    todos: oTodos.length, bugs: oBugs.length, security: oSec.length,
    planSteps: oSteps.length, deferred,
    ...(activeOpen.length
      ? { oldestOpenDays: Math.max(...activeOpen.map(t => days(t.timestamp, now))) }
      : {}),
  };

  // Release hygiene: releases cut while a non-deferred work item stayed open —
  // the exact gap the server-side release guard now closes; measured here so a
  // study can show the before/after. Closure time resolved the same way the
  // closed view pairs items (kind + normalized text); currently-open items
  // count against every release after they opened. Items deferred TODAY are
  // excluded wholesale (their deferral date isn't stored), security never.
  const closedAtOf = new Map<string, string | undefined>();
  for (const c of closed) closedAtOf.set(`${c.kind}␟${normalizeTagContent(c.text)}`, c.closedAt);
  const openIdsNow = new Set(allOpen.map(t => t.id));
  let dirty = 0, securityDirty = 0;
  for (const r of releaseTags) {
    const relMs = +new Date(r.timestamp);
    let open = 0, sec = 0;
    for (const t of openers) {
      if (t.upcoming || +new Date(t.timestamp) >= relMs) continue;
      const cAt = closedAtOf.get(`${t.tag}␟${normalizeTagContent(t.content)}`);
      const openAtRelease = openIdsNow.has(t.id) || (cAt !== undefined && +new Date(cAt) > relMs);
      if (!openAtRelease) continue;
      open++;
      if (t.tag.startsWith("security")) sec++;
    }
    if (open > 0) dirty++;
    if (sec > 0) securityDirty++;
  }
  const last = releaseTags[releaseTags.length - 1];
  const releases = {
    total: releaseTags.length, dirty, securityDirty,
    ...(last ? { latest: { version: parseVersion(last.content).version, at: last.timestamp } } : {}),
  };

  const projPlans = data.plans.filter(p => p.project === project);
  const plans = {
    total: projPlans.length,
    steps: projPlans.reduce((s, p) => s + p.steps.length, 0),
    closedSteps: projPlans.reduce((s, p) => s + p.steps.filter(x => x.completed || x.dropped).length, 0),
  };

  const retro = retroCorpus(data, project);
  const problems = {
    reports: retro.length,
    reopens: retro.filter(i => typeof i.reopenOf === "number").length,
    fragile: fragileFiles(data, project),
    // #585: the regression-test gap belongs with the reopen count — a fix with no
    // test and a fix that came back are the two halves of the same discipline
    // question, and the study is where a whole history is read at once.
    testGap: regressionGap(data, project),
  };

  const featureTags = tags.filter(t => t.tag === "feature");
  const backfilled = featureTags.filter(t => /^\s*\[v?\d+\.\d+\.\d+\]/i.test(t.content)).length;
  const features = {
    declared: featureTags.length,
    backfilled,
    uncoveredReleases: backfillCorpus(data, project).uncovered.length,
  };

  return {
    ...(firstTagAt ? { firstTagAt } : {}), ...(lastTagAt ? { lastTagAt } : {}),
    totalTags: tags.length, taggedSessions: sessions.size,
    byType, monthly, closure, openNow, behavior: buildBehavior(tags), releases, plans, problems, features,
  };
}

// ── Delta (narrative material since the watermark) ──────────────────────────

function buildDelta(data: DevLogData, project: string, fromMs: number): StudyDelta {
  const tags = data.tags.filter(t => t.project === project);
  const inWindow = (ts?: string) => !!ts && +new Date(ts) > fromMs;

  const relTags = tags
    .filter(t => t.tag === "release" && isRealVersion(t.content) && inWindow(t.timestamp))
    .sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))
    .map(t => ({
      version: parseVersion(t.content).version,
      at: t.timestamp,
      summary: cap(parseVersion(t.content).summary || t.content.split("\n", 1)[0]),
    }));
  const releases = { items: relTags.slice(0, DELTA_RELEASES_CAP), more: Math.max(0, relTags.length - DELTA_RELEASES_CAP) };

  // "Touched in window": opened OR closed inside it. A reopen is itself a new
  // report (opened in window) and carries reopenOf across the boundary.
  const touched = retroCorpus(data, project).filter(i => inWindow(i.openedAt) || inWindow(i.closedAt));
  const problems = { items: touched.slice(0, DELTA_PROBLEMS_CAP), more: Math.max(0, touched.length - DELTA_PROBLEMS_CAP) };

  const knowledgeTags = tags
    .filter(t => (t.tag === "decision" || t.tag === "insight") && inWindow(t.timestamp))
    .sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))
    .map(t => ({ kind: t.tag, at: t.timestamp, text: cap(t.content.replace(/\s+/g, " ").trim()) }));
  const knowledge = { items: knowledgeTags.slice(0, DELTA_KNOWLEDGE_CAP), more: Math.max(0, knowledgeTags.length - DELTA_KNOWLEDGE_CAP) };

  const longestClosed = closedItems(data, project)
    .filter(c => c.openedAt && inWindow(c.closedAt))
    .map(c => ({
      ...(typeof c.num === "number" ? { num: c.num } : {}),
      kind: c.kind, ageDays: days(c.openedAt as string, c.closedAt as string), text: cap(c.text),
    }))
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, DELTA_LONGEST_CAP);

  const work = { built: 0, refactor: 0, update: 0 };
  for (const t of tags) {
    if (!inWindow(t.timestamp)) continue;
    if (t.tag === "built") work.built++;
    else if (t.tag === "refactor") work.refactor++;
    else if (t.tag === "update") work.update++;
  }

  return { releases, problems, knowledge, longestClosed, work };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** The full study corpus for `project`. Pure; `now` injectable for tests. */
export function studyCorpus(data: DevLogData, project: string, now = Date.now(), prevDoc: PrevStudyDoc | null = null): StudyCorpus {
  const tags = data.tags.filter(t => t.project === project);
  // Watermark: newest of the two sources. Tag rows cover the pre-change era
  // (studies that WERE stored as doc:report tags); the doc-store entry covers
  // everything since doc:* tags stopped persisting as rows (#618).
  const prevTag = findPrevStudy(tags);
  let prev: PrevStudyDoc | null = prevTag
    ? { name: (prevTag.content.split("\n", 1)[0] ?? "").trim(), at: prevTag.timestamp, content: prevTag.content }
    : null;
  if (prevDoc && (!prev || +new Date(prevDoc.at) >= +new Date(prev.at))) prev = prevDoc;
  const window: StudyWindow = {
    to: new Date(now).toISOString(),
    foundational: !prev,
    ...(prev ? {
      from: prev.at,
      prevStudy: {
        name: prev.name,
        at: prev.at,
        digest: studyDigest(prev.content),
      },
    } : {}),
  };
  return {
    window,
    aggregates: buildAggregates(data, project, now),
    delta: buildDelta(data, project, prev ? +new Date(prev.at) : 0),
  };
}
