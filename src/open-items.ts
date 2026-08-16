// Tag semantics: the closure grammar and the "what is still open?" resolver.
// Extracted from data.ts, which now owns only the STORE (paths, load/save,
// the mutation lock). The split is along a real seam — nothing here touches
// disk or the cache, it is pure functions over the tags/plans arrays — and it
// is what lets these rules be unit-tested without a store at all.
//
// One question — "which items are still open?" — must be answered identically
// by the SessionStart summary (inject.ts), the DEVLOG_STATUS.md export
// (export.ts), the doctor audit (doctor.ts) and the /api/open-items release
// guard. Each used to carry its own copy and they diverged: the export ignored
// `#N` closures and `security:own/:dep` entirely, so a `-(done) #5` item stayed
// open forever in DEVLOG_STATUS.md. This module is the single source of truth.
//
// The whole vocabulary derives from ONE table, CLOSER_FOR (opener → the closer
// verbs that legitimately close it). Every other view — CLOSER_KINDS,
// OPENER_TO_CLOSER, NUMBERED_OPENABLE, NUMBERED_TAGS, CLOSURE_TAGS — is
// computed from it, so adding a tag kind means editing exactly one place and a
// `-(bug fix) #5` can never close todo #5.
//
// Two closure paths coexist and must stay distinguishable: by `#N` (exact, and
// the only one the protocol asks for) and by TEXT (the legacy safety net, which
// is why normalizeTagContent lives here). The text path is deliberately
// ORDER-AWARE — a closer only covers openers at or before its own timestamp —
// so a problem reintroduced after its fix is not born closed.
//
// data.ts re-exports everything below, so existing `from "./data"` imports keep
// working; new code can import from either.

import type { DevLogData, PlanStep, ProjectProfile, TagEntry } from "./types";

/**
 * Normalize tag content for closure matching. Strips inline-code backticks,
 * collapses runs of whitespace, lowercases, and trims. Used by every
 * `text === text` comparison that backs todo↔done, bug found↔fix,
 * security↔security fix, dedup, and plan-step sync.
 *
 * Without this, a one-byte difference (extra space, backtick, hidden zero-
 * width space) leaves an item permanently open. Closure-by-`#N` avoids the
 * issue entirely; this helper is the safety net for the legacy text path.
 */
export function normalizeTagContent(s: string): string {
  return s
    .replace(/`[^`\n]*`/g, " ") // strip inline-code (` `code` ` → ` `)
    .replace(/`/g, "")           // any stray backticks
    .replace(/\s+/g, " ")        // collapse whitespace
    .trim()
    .toLowerCase();
}

// ─── Open-item resolution (single source of truth) ──────────────────────
// One question — "which items are still open?" — must be answered identically
// for the SessionStart summary (inject.ts), the DEVLOG_STATUS.md export
// (export.ts), the doctor audit (doctor.ts), and the /api/open-items
// release-guard (server.ts). Each used to carry its own copy and they diverged:
// export ignored `#N` closures and `security:own/:dep` entirely (so a `-(done)
// #5` item stayed open forever in DEVLOG_STATUS.md), and doctor's `#N` closure
// was not type-matched. Centralizing here is remediation round-3 P1.

/** Open security tags — `security`, `security:own`, `security:dep` all count. */
export const SECURITY_OPEN_TAGS = new Set(["security", "security:own", "security:dep"]);

/** Is this tag a problem REPORT (bug/security opener)? Openers only — a
 *  `startsWith("security")` variant also matched the CLOSER `security fix`,
 *  inflating report counts by every security closure. Four modules carried
 *  private copies of this predicate and one had drifted to exactly that bug
 *  (audit 2026-08-14 C6); one definition, imported everywhere. */
export const isReport = (tag: string): boolean => tag === "bug found" || SECURITY_OPEN_TAGS.has(tag);

// ─── Closure vocabulary (single source of truth, #409) ──────────────────────
// The entire closure grammar derives from ONE table: each OPENER tag → the
// closer verb(s) that legitimately close it (type-matched). tags-service and
// closed-items used to keep their own copies (CLOSER_KINDS, OPENER_TO_CLOSER,
// NUMBERED_OPENABLE, CLOSER_FOR) which could silently drift; they now import
// these derived views so there is exactly one place to change the vocabulary.

/** Opener tag → closer verb(s) that close it (type-matched). */
export const CLOSER_FOR: Record<string, string[]> = {
  "todo": ["done", "dropped"],
  // A report has three honest exits, and only one of them is "solved":
  //   bug fix          — the root cause is gone.
  //   bug fix:interim  — DECLARED stopgap. Sometimes opening the window is the
  //                      right call under time pressure; the danger is never the
  //                      stopgap, it is the stopgap disguised as a real fix. A
  //                      declared one stays visible as debt in retro, and its
  //                      re-opening reads as an expected outcome, not a surprise.
  //   dropped          — WITHDRAWN: not a defect after all (collapsed premise,
  //                      misread, duplicate). Without it the only ways out were a
  //                      fix that never happened — a lie that reaches the release
  //                      notes — or an item open forever, blocking every release.
  // `bug fix` stays FIRST: OPENER_TO_CLOSER suggests cs[0], and the default
  // suggestion must remain the real fix, never the stopgap.
  "bug found": ["bug fix", "bug fix:interim", "dropped"],
  // Security has no withdrawal on purpose: "this isn't really a vulnerability"
  // is exactly the call that must not be made by writing one word.
  "security": ["security fix"],
  "security:own": ["security fix"],
  "security:dep": ["security fix"],
};

/** Closer verb → opener tag(s) it can close (inverse of CLOSER_FOR), so a
 *  `-(bug fix) #5` never closes a todo #5. */
export const CLOSER_KINDS: Record<string, string[]> = (() => {
  const inv: Record<string, string[]> = {};
  for (const [opener, closers] of Object.entries(CLOSER_FOR)) {
    for (const c of closers) {
      if (!inv[c]) inv[c] = [];
      inv[c].push(opener);
    }
  }
  return inv;
})();

/** Opener tag → the single verb to SUGGEST when the wrong closer was used (the
 *  first/primary closer; `dropped` is an alternate for todo, not the suggestion). */
export const OPENER_TO_CLOSER: Record<string, string> =
  Object.fromEntries(Object.entries(CLOSER_FOR).map(([o, cs]) => [o, cs[0]]));

/** All numbered openable tags (keys of CLOSER_FOR). */
export const NUMBERED_OPENABLE = new Set(Object.keys(CLOSER_FOR));

/** Tags that receive a `#N` at ingest: every openable kind plus `feature`,
 *  which is numbered not for closure but so `feature update/removed #N` can
 *  target it. Ingest (routes-tags) and backfill (backfillNums) both import
 *  this — they used to keep divergent local copies, and the backfill's lagged
 *  one left pre-numbering features permanently unnumbered. */
export const NUMBERED_TAGS = new Set([...NUMBERED_OPENABLE, "feature"]);

/** Tags that close an open item (keys of CLOSER_KINDS). */
export const CLOSURE_TAGS = new Set(Object.keys(CLOSER_KINDS));

/**
 * The LEADING `#N #M …` run of a closer's content, as numbers. Matching stops at
 * the first token that isn't a `#N`, so `-(done) #5 #6` yields [5, 6] while a
 * `#N` in trailing prose (`-(done) #5 — same root as bug #11, see PR #312`) does
 * NOT include #11/#312 — that would silently lose an unrelated open item (R4
 * code-quality F3). Shared by closedNums (below) and closed-items (#409).
 */
export function leadingNums(content: string): number[] {
  const prefix = (content || "").match(/^(?:\s*#\d+)+/);
  return prefix ? [...prefix[0].matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10)) : [];
}

/**
 * A closer whose content is a SINGLE bare `#N` (whole content, optional `#`,
 * surrounding whitespace) → N, else null. Distinct from the leading-run parser:
 * used by closure resolution / diagnosis / undo, which act on one number only.
 */
export function singleHashNum(content: string): number | null {
  const m = (content || "").match(/^#?\s*(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Numbers closed via `-(kind) #N`. Pass ONLY the closure kinds that legitimately
 * close the item type ("type-matched"), so a `-(bug fix) #5` never closes a
 * todo #5. Uses leadingNums, so trailing non-`#N` prose is ignored.
 */
export function closedNums(tags: TagEntry[], kinds: string[]): Set<number> {
  const nums = new Set<number>();
  for (const t of tags) {
    if (!kinds.includes(t.tag)) continue;
    for (const n of leadingNums(t.content || "")) nums.add(n);
  }
  return nums;
}

/** What a single response's tags do to open `#N`s, before any of it is stored. */
export interface InflightClosures {
  /** Does this batch close `num`, with a verb the table accepts for `openerTag`? */
  closes(num: number | undefined, openerTag: string): boolean;
  /** `#N`s the batch defers with `-(upcoming)` — deferral is not closure. */
  deferred: Set<number>;
}

/**
 * Index the closers and deferrals a response aims at `#N`s, type-matched through
 * CLOSER_FOR. The release guard needs this because a batch's own closures must
 * count: "close everything, then release" happens in ONE response, so the items
 * being closed are still open in the store when the guard runs.
 *
 * Verbs are kept verbatim and matched against the table at query time, rather
 * than bucketed into hand-written sets (`tag === "bug fix"` …). That shape had
 * to be edited in lockstep with the vocabulary, and silently under-counted the
 * moment a second closer verb was added for an opener.
 */
export function inflightClosures(entries: { tag: string; content?: string }[]): InflightClosures {
  const byNum = new Map<number, Set<string>>();
  const deferred = new Set<number>();
  for (const e of entries) {
    const nums = [...String(e.content || "").matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
    if (!nums.length) continue;
    if (e.tag === "upcoming") { for (const n of nums) deferred.add(n); continue; }
    if (!CLOSURE_TAGS.has(e.tag)) continue;
    for (const n of nums) {
      let verbs = byNum.get(n);
      if (!verbs) { verbs = new Set<string>(); byNum.set(n, verbs); }
      verbs.add(e.tag);
    }
  }
  return {
    closes(num, openerTag) {
      if (typeof num !== "number") return false;
      const verbs = byNum.get(num);
      if (!verbs) return false;
      return (CLOSER_FOR[openerTag] || []).some(v => verbs.has(v));
    },
    deferred,
  };
}

// Orphan closure GC (#230) lives in ./orphan-closures — extracted under the
// file-size budget; pure over the tags array, consumed by server startup only.

export interface OpenItemOpts {
  /**
   * When true, drop items that lack a `num`. The release-guard (/api/open-items)
   * and doctor only track numbered items; the inject summary and the export
   * list everything. This is the ONE axis on which the four consumers legitimately
   * differ — closure semantics stay identical across all of them.
   */
  numberedOnly?: boolean;
}

function passesNum(t: { num?: number }, opts: OpenItemOpts): boolean {
  return !opts.numberedOnly || typeof t.num === "number";
}

// Text closures are ORDER-AWARE (#743): a closer only covers openers at or
// before its own timestamp. Without this, a problem REINTRODUCED after its fix
// (a vulnerable pin re-installed, a bug re-reported verbatim) was born closed —
// the old closure's text shadowed the new report forever, so neither the
// install-override endpoint nor the scan sweep could ever leave an open record.
// `#N` closures need no such treatment: numbers are unique per item, so a
// numbered closure can never swallow a future re-opener (it gets a fresh num).
/** Latest closer timestamp per normalized text, for the given closer verbs. */
export function latestCloserTs(tags: TagEntry[], closers: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of tags) {
    if (!closers.includes(t.tag)) continue;
    const k = normalizeTagContent(t.content);
    if ((m.get(k) ?? "") < (t.timestamp || "")) m.set(k, t.timestamp || "");
  }
  return m;
}
function textClosed(closedAt: Map<string, string>, t: TagEntry): boolean {
  const ts = closedAt.get(normalizeTagContent(t.content));
  return ts !== undefined && ts >= (t.timestamp || "");
}

/** Todos with no matching `-(done)`/`-(dropped)` closure (by text or by `#N`). */
export function openTodos(tags: TagEntry[], opts: OpenItemOpts = {}): TagEntry[] {
  const closedAt = latestCloserTs(tags, CLOSER_FOR.todo);
  const byNum = closedNums(tags, CLOSER_FOR.todo);
  return tags.filter(t => t.tag === "todo"
    && passesNum(t, opts)
    && !textClosed(closedAt, t)
    && !(typeof t.num === "number" && byNum.has(t.num)));
}

/** Bugs with no matching `-(bug fix)` / `-(dropped)` closure (by text or `#N`). */
export function openBugs(tags: TagEntry[], opts: OpenItemOpts = {}): TagEntry[] {
  const closedAt = latestCloserTs(tags, CLOSER_FOR["bug found"]);
  const byNum = closedNums(tags, CLOSER_FOR["bug found"]);
  return tags.filter(t => t.tag === "bug found"
    && passesNum(t, opts)
    && !textClosed(closedAt, t)
    && !(typeof t.num === "number" && byNum.has(t.num)));
}

/** Security items (`security`/`security:own`/`security:dep`) with no matching
 *  `-(security fix)` closure (by text or by `#N`). */
export function openSecurity(tags: TagEntry[], opts: OpenItemOpts = {}): TagEntry[] {
  const closedAt = latestCloserTs(tags, CLOSER_FOR.security);
  const byNum = closedNums(tags, CLOSER_FOR.security);
  return tags.filter(t => SECURITY_OPEN_TAGS.has(t.tag)
    && passesNum(t, opts)
    && !textClosed(closedAt, t)
    && !(typeof t.num === "number" && byNum.has(t.num)));
}

export interface OpenPlanStep {
  num?: number;
  text: string;
  phase?: string;
  planTitle: string;
  planFile: string;
  /** The owning plan is marked «قادمة» — the step stays open (and closable by
   *  `#N`) but guards/summaries must not count it as tracked debt. */
  planUpcoming?: boolean;
  /** ISO creation time of the owning plan — the best available "opened at"
   *  for a step (steps carry no per-step timestamp). */
  openedAt?: string;
}

/**
 * A plan step no longer open. Completed (`[x]` / `-(done)`) OR archived by
 * `-(dropped)`. Dropped steps stay in `plan.steps` (not spliced) so
 * already-closed detection and `-(ask:closed)` can still find them (#410); every
 * "is this step open?" check must go through here so the two closure states
 * can't drift apart the way `s.completed` alone did.
 */
export function isStepClosed(s: PlanStep): boolean {
  return s.completed || !!s.dropped;
}

/** Plan steps not yet completed and not closed by a `-(done)/-(dropped) #N`. */
export function openPlanSteps(data: DevLogData, project: string, opts: OpenItemOpts = {}): OpenPlanStep[] {
  const tags = data.tags.filter(t => t.project === project);
  const closedByDone = closedNums(tags, ["done", "dropped"]);
  const out: OpenPlanStep[] = [];
  for (const plan of data.plans) {
    if (plan.project !== project) continue;
    for (const s of plan.steps) {
      if (isStepClosed(s)) continue;
      if (opts.numberedOnly && typeof s.num !== "number") continue;
      if (typeof s.num === "number" && closedByDone.has(s.num)) continue;
      out.push({
        num: s.num, text: s.text, phase: s.phase, planTitle: plan.title, planFile: plan.file_path,
        ...(plan.upcoming ? { planUpcoming: true } : {}), openedAt: plan.timestamp,
      });
    }
  }
  return out;
}

export interface OutdatedLib {
  name: string;
  current: string;      // installed version, "" if unknown
  latest: string;       // latest available version
  daysSinceLatest: number;
}

/**
 * Libraries with a newer version that has been published longer than
 * `minAgeDays` days ago. Reads the latest vuln-scan snapshot (`vulnResults`),
 * the source of truth for version-behind (`isLatest`) + release age
 * (`daysSinceLatest`). The age gate excludes versions released <1 week ago so a
 * just-cut (possibly unstable) release doesn't immediately read as "open work".
 * Current version comes from `libraries` since VulnResult doesn't carry it.
 */
export function openOutdatedLibs(profile: ProjectProfile, minAgeDays = 7): OutdatedLib[] {
  const results = profile.vulnResults;
  if (!results) return [];
  const versionByName = new Map((profile.libraries || []).map(l => [l.name, l.version]));
  const out: OutdatedLib[] = [];
  for (const [name, r] of Object.entries(results)) {
    if (r.isLatest !== false) continue;                 // up to date or unknown
    if (!r.latestVersion) continue;
    if (typeof r.daysSinceLatest !== "number") continue;
    if (r.daysSinceLatest <= minAgeDays) continue;      // newer version too fresh
    out.push({
      name,
      current: versionByName.get(name) || "",
      latest: r.latestVersion,
      daysSinceLatest: r.daysSinceLatest,
    });
  }
  out.sort((a, b) => b.daysSinceLatest - a.daysSinceLatest);
  return out;
}
