import { archiveEvents } from "./event-archive";
import type { DevLogData, EventEntry } from "./types";

const DAY = 24 * 60 * 60 * 1000;
const MAX_EVENTS_LOG = 10000;
// Per-project cap (applied first in pushEvent) is the real fairness limit;
// MAX_EVENTS_LOG is only a global memory safety net. Sized so the active project
// can't starve quiet ones: 200 × ~20 projects stays under the global cap.
const PER_PROJECT_MAX_EVENTS = 200;

/** Append an event to the hot store, honoring the per-project cap first and the
 *  global MAX_EVENTS_LOG safety net second. Lived in server.ts until the
 *  file-size ratchet; it belongs with the caps and capEventsPerProject anyway. */
export function pushEvent(events: EventEntry[], entry: EventEntry) {
  events.push(entry);
  // Per-project cap FIRST so a busy project (the one Claude is working in) can't
  // evict a quiet project's history from a shared global ring (#NNN). Mutate in
  // place to preserve the caller's array reference.
  const capped = capEventsPerProject(events, PER_PROJECT_MAX_EVENTS);
  const evicted: EventEntry[] = [];
  if (capped.length !== events.length) {
    const kept = new Set(capped);
    for (const e of events) if (!kept.has(e)) evicted.push(e);
    events.splice(0, events.length, ...capped);
  }
  // Global memory safety net across many projects.
  if (events.length > MAX_EVENTS_LOG) {
    evicted.push(...events.slice(0, events.length - MAX_EVENTS_LOG));
    events.splice(0, events.length - MAX_EVENTS_LOG);
  }
  // Eviction is archival, not deletion (cold archive — the 2026-07-06 changelog
  // wipe). Fire-and-forget: archiveEvents retries transient locks and logs a
  // failed batch; re-queuing here would break the cap invariant we just applied.
  if (evicted.length) void archiveEvents(evicted);
}
const HOT_DAYS = 7;
const WARM_DAYS = 30;

/**
 * Prune events:
 * - Hot (0-7 days): keep full old_string/new_string/content
 * - Warm (7-30 days): strip content, keep file_path + lines_added/lines_removed
 * - Cold (30+ days): delete entirely
 *
 * Protected: events that fall between the project's two most recent releases
 * keep full content while they remain that window — they back the current
 * release page's diffs. Older inter-release events cold-prune on the normal
 * 30-day schedule, so the log can't grow without bound.
 *
 * Returns counts plus `removedEvents` — the cold-deleted rows themselves, so
 * the caller can archive them before the store persists the deletion (cold
 * archive: pruning archives, never deletes).
 */
export function pruneEvents(data: DevLogData): { warmed: number; removed: number; protected: number; removedEvents: EventEntry[] } {
  const now = Date.now();
  const hotCutoff = now - HOT_DAYS * DAY;
  const warmCutoff = now - WARM_DAYS * DAY;

  // Build per-project release windows: events between prev-release and latest-release are protected.
  const protectedWindows = computeProtectedWindows(data);

  let warmed = 0;
  let protectedCount = 0;
  const kept: EventEntry[] = [];
  const removedEvents: EventEntry[] = [];

  for (const e of data.events || []) {
    const ts = +new Date(e.timestamp) || 0;
    const isChange = e.type === "change" || e.type === "create";

    // Non-change events (commands, sessions, tasks, agents): no content to prune,
    // age out at warm cutoff to keep timeline lean.
    if (!isChange) {
      if (ts < warmCutoff) { removedEvents.push(e); continue; }
      kept.push(e);
      continue;
    }

    // Protected: in a release window → keep full
    if (isInProtectedWindow(e, protectedWindows)) {
      protectedCount++;
      kept.push(e);
      continue;
    }

    // Cold: leaves the hot store (caller archives)
    if (ts < warmCutoff) { removedEvents.push(e); continue; }

    // Warm: strip content, keep counts
    if (ts < hotCutoff && e.retention !== "warm") {
      const next: EventEntry = {
        ...e,
        lines_added: e.lines_added ?? countLines(e.new_string || e.content),
        lines_removed: e.lines_removed ?? countLines(e.old_string),
        retention: "warm",
      };
      delete next.old_string;
      delete next.new_string;
      delete next.content;
      kept.push(next);
      warmed++;
      continue;
    }

    // Hot: untouched
    if (!e.retention) e.retention = "hot";
    kept.push(e);
  }

  data.events = kept;
  return { warmed, removed: removedEvents.length, protected: protectedCount, removedEvents };
}

/**
 * Cap the live event log PER PROJECT: keep at most `perProjectMax` of each
 * project's most-recent events while preserving global chronological order.
 *
 * The hot-path log was a single global FIFO ring (MAX_EVENTS_LOG) shared across
 * every project, so the project Claude is actively working in floods the buffer
 * and evicts quiet projects' history entirely — their dashboard event card
 * flickered then went empty. Per-project capping bounds memory the same way
 * while keeping every project's recent tail intact.
 *
 * Pure: returns a new array, mutates nothing.
 */
export function capEventsPerProject(events: EventEntry[], perProjectMax: number): EventEntry[] {
  if (perProjectMax <= 0) return events.slice();
  const counts = new Map<string, number>();
  const keepReversed: EventEntry[] = [];
  // Walk newest→oldest so the events we drop are each project's OLDEST.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const seen = counts.get(e.project) ?? 0;
    if (seen >= perProjectMax) continue;
    counts.set(e.project, seen + 1);
    keepReversed.push(e);
  }
  return keepReversed.reverse();
}

interface ReleaseWindow { start: number; end: number; }

function computeProtectedWindows(data: DevLogData): Map<string, ReleaseWindow[]> {
  const byProject = new Map<string, number[]>();
  for (const t of data.tags || []) {
    if (t.tag !== "release") continue;
    if (!/^v?\d/.test(t.content)) continue;
    const ts = +new Date(t.timestamp) || 0;
    if (!ts) continue;
    let arr = byProject.get(t.project);
    if (!arr) { arr = []; byProject.set(t.project, arr); }
    arr.push(ts);
  }
  const windows = new Map<string, ReleaseWindow[]>();
  for (const [project, releases] of byProject) {
    // Protect ONLY the window between the two most recent releases — the diff
    // range behind the current release page. Earlier history ages out per the
    // normal policy. The old version started the first window at epoch 0, so the
    // union spanned [0, latest] and every event before the newest release stayed
    // protected forever, growing the log without bound. A single release defines
    // no "between two" window, so nothing is protected until the second ships.
    if (releases.length < 2) continue;
    releases.sort((a, b) => a - b);
    const latest = releases[releases.length - 1];
    const prev = releases[releases.length - 2];
    windows.set(project, [{ start: prev, end: latest }]);
  }
  return windows;
}

function isInProtectedWindow(e: EventEntry, windows: Map<string, ReleaseWindow[]>): boolean {
  const ranges = windows.get(e.project);
  if (!ranges) return false;
  const ts = +new Date(e.timestamp) || 0;
  for (const r of ranges) {
    if (ts > r.start && ts <= r.end) return true;
  }
  return false;
}

function countLines(s: string | undefined): number {
  if (!s) return 0;
  return s.split("\n").length;
}
