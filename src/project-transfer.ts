// ─── Project transfer: portable export/import of one project's history ───────
// The DevLog store is per-machine (~/.devlog/data) — git carries the code, but
// the project's log never leaves the computer it was written on. When
// development moves between machines (clone on laptop, push, pull on desktop)
// each machine grows a separate, partial history of the SAME project. This
// module makes the log itself portable: a single-JSON bundle (profile + tags +
// plans + events + worklog + monthly archive) downloadable from the dashboard,
// and a merge-import that folds a bundle from another machine into the local
// store.
//
// Merge rules (directive 2026-07-21):
// - Rows keep their original UUID `id` across export/import — importing the
//   same bundle twice skips existing rows instead of duplicating them.
// - `#N` numbers are PER-PROJECT (nextItemNum), so two machines that each
//   started counting independently collide. Imported numbered rows renumber
//   from the local high-water mark up; `relatedTo` follows through the same
//   map. A row already present keeps its local number AND still enters the
//   map, so a re-import remaps references identically every time.
// - Profile: local wins; imported values only fill locally-empty fields.
// - Archive months merge file-by-file, id-deduped, rewritten sorted.
// - Machine-local state (injections log, descendants, rejections, migrations)
//   deliberately stays out of the bundle — it describes the machine, not the
//   project.

import { DATA_DIR, normalizeTagContent } from "./data";
import { listArchiveMonths, readArchiveMonth, readUndoneMonth, rewriteArchiveMonth } from "./event-archive";
import type {
  DevLogData, EventEntry, InjectionConfig, PlanEntry, ProjectProfile,
  TagEntry, UndoneRecord, WorklogEntry,
} from "./types";

export const TRANSFER_KIND = "devlog-project-export";
export const TRANSFER_SCHEMA_VERSION = 1;

export interface TransferBundle {
  kind: typeof TRANSFER_KIND;
  schemaVersion: number;
  exportedAt: string;
  project: string;
  profile: ProjectProfile;
  injectionConfig?: Partial<InjectionConfig>;
  tags: TagEntry[];
  plans: PlanEntry[];
  events: EventEntry[];
  worklog: WorklogEntry[];
  /** Monthly archive rows for this project, keyed by "YYYY-MM". */
  archive: { events: Record<string, EventEntry[]>; undone: Record<string, UndoneRecord[]> };
}

export interface ImportSummary {
  project: string;
  /** True when the project did not exist locally (registered as-is, numbers kept). */
  created: boolean;
  added: { tags: number; events: number; plans: number; planSteps: number; worklog: number };
  /** Rows skipped because they already exist locally (same id / same step text). */
  skipped: number;
  /** Numbered items whose `#N` shifted to clear the local sequence. */
  renumbered: number;
  /** Filled by the route after the store merge (separate file-level pass). */
  archive?: { added: number; months: number };
}

/** Collect everything the store holds for one project into a portable bundle.
 *  Archive months are read through the same helpers the history views use, so
 *  gz/plain resolution and corrupt-line skipping behave identically. */
export async function buildExportBundle(data: DevLogData, name: string): Promise<TransferBundle | null> {
  const profile = data.projects[name];
  if (!profile) return null;
  const archive: TransferBundle["archive"] = { events: {}, undone: {} };
  for (const month of await listArchiveMonths("events")) {
    const rows = (await readArchiveMonth(month)).filter(e => e.project === name);
    if (rows.length) archive.events[month] = rows;
  }
  for (const month of await listArchiveMonths("undone")) {
    const rows = (await readUndoneMonth(month)).filter(r => r.project === name);
    if (rows.length) archive.undone[month] = rows;
  }
  return {
    kind: TRANSFER_KIND,
    schemaVersion: TRANSFER_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    project: name,
    profile,
    injectionConfig: data.projectInjectionConfigs[name],
    tags: data.tags.filter(t => t.project === name),
    plans: data.plans.filter(p => p.project === name),
    events: data.events.filter(e => e.project === name),
    worklog: data.worklog.filter(w => w.project === name),
    archive,
  };
}

/** Shape-check an uploaded bundle. Returns a human-readable rejection reason,
 *  or null when the bundle is importable. */
export function validateBundle(raw: unknown): string | null {
  const b = raw as Partial<TransferBundle> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return "body is not a JSON object";
  if (b.kind !== TRANSFER_KIND) return `kind must be "${TRANSFER_KIND}"`;
  if (typeof b.schemaVersion !== "number" || b.schemaVersion < 1 || b.schemaVersion > TRANSFER_SCHEMA_VERSION)
    return `unsupported schemaVersion ${b.schemaVersion} (this server reads 1..${TRANSFER_SCHEMA_VERSION})`;
  if (typeof b.project !== "string" || !b.project.trim()) return "missing project name";
  if (!b.profile || typeof b.profile !== "object") return "missing profile";
  for (const k of ["tags", "plans", "events", "worklog"] as const)
    if (!Array.isArray(b[k])) return `${k} must be an array`;
  return null;
}

// A bundle plan matches a local plan by id (same origin — an earlier import of
// the same machine's history), else by normalized title within the project —
// the same doc:plan re-emitted on two machines mints two ids for one plan.
function findLocalPlan(data: DevLogData, project: string, bp: PlanEntry): PlanEntry | undefined {
  return data.plans.find(p => p.id === bp.id)
    ?? data.plans.find(p => p.project === project && normalizeTagContent(p.title) === normalizeTagContent(bp.title));
}

/** Fold a bundle into the store. Pure mutation on `data` — no file I/O — so the
 *  merge semantics are unit-testable; call under withData(). Archive months are
 *  a separate pass (mergeArchiveBundle) because they live outside the store. */
export function applyImportBundle(data: DevLogData, bundle: TransferBundle): ImportSummary {
  const name = bundle.project;
  const existing = data.projects[name];
  const created = !existing;
  const summary: ImportSummary = {
    project: name, created,
    added: { tags: 0, events: 0, plans: 0, planSteps: 0, worklog: 0 },
    skipped: 0, renumbered: 0,
  };

  const localTagById = new Map<string, TagEntry>();
  for (const t of data.tags) localTagById.set(t.id, t);

  // Local #N high-water mark: the persisted counter OR the highest number any
  // row actually carries — whichever is ahead (same defense assignNum uses).
  let next = 1;
  if (existing) {
    next = existing.nextItemNum || 1;
    for (const t of data.tags) if (t.project === name && t.num && t.num >= next) next = t.num + 1;
    for (const p of data.plans) if (p.project === name) for (const s of p.steps) if (s.num && s.num >= next) next = s.num + 1;
  }

  // Pass 1 — number map over ALL imported numbered items (tags + plan steps
  // share one per-project sequence). Already-present rows map to their LOCAL
  // number; the rest renumber from the high-water mark up, sorted by original
  // number so relative order survives. A brand-new project keeps its numbers
  // verbatim — there is nothing local to collide with.
  const numMap = new Map<number, number>();
  if (!created) {
    const pending: number[] = [];
    for (const t of bundle.tags) {
      if (t.num == null) continue;
      const local = localTagById.get(t.id);
      if (local?.num != null) numMap.set(t.num, local.num);
      else pending.push(t.num);
    }
    for (const bp of bundle.plans) {
      const localPlan = findLocalPlan(data, name, bp);
      for (const s of bp.steps) {
        if (s.num == null) continue;
        const ls = localPlan?.steps.find(x => normalizeTagContent(x.text) === normalizeTagContent(s.text));
        if (ls?.num != null) numMap.set(s.num, ls.num);
        else pending.push(s.num);
      }
    }
    for (const n of [...new Set(pending)].sort((a, b) => a - b)) {
      if (numMap.has(n)) continue;
      numMap.set(n, next++);
      summary.renumbered++;
    }
  }

  // Tags. relatedTo remaps through the same table; a reference the map cannot
  // resolve is dropped — a dangling pointer at some unrelated local item is
  // worse than no pointer (relatedTo is advisory recurrence data).
  for (const t of bundle.tags) {
    if (localTagById.has(t.id)) { summary.skipped++; continue; }
    const row: TagEntry = { ...t, project: name };
    if (!created) {
      if (row.num != null) row.num = numMap.get(row.num) ?? row.num;
      if (row.relatedTo != null) {
        const m = numMap.get(row.relatedTo);
        if (m != null) row.relatedTo = m; else delete row.relatedTo;
      }
    }
    data.tags.push(row);
    summary.added.tags++;
  }

  // Plans: unmatched plans import whole; a matched plan merges step-by-step —
  // steps matched by normalized text keep the LOCAL completion state, new
  // steps append with remapped numbers.
  for (const bp of bundle.plans) {
    const localPlan = created ? undefined : findLocalPlan(data, name, bp);
    if (!localPlan) {
      const steps = bp.steps.map(s => ({
        ...s,
        num: !created && s.num != null ? (numMap.get(s.num) ?? s.num) : s.num,
      }));
      data.plans.push({ ...bp, project: name, steps });
      summary.added.plans++;
      continue;
    }
    for (const s of bp.steps) {
      const ls = localPlan.steps.find(x => normalizeTagContent(x.text) === normalizeTagContent(s.text));
      if (ls) { summary.skipped++; continue; }
      localPlan.steps.push({ ...s, num: s.num != null ? (numMap.get(s.num) ?? s.num) : undefined });
      summary.added.planSteps++;
    }
    if ((bp.updatedAt || "") > (localPlan.updatedAt || "")) localPlan.updatedAt = bp.updatedAt;
  }

  // Events + worklog: plain id-dedup append.
  const eventIds = new Set(data.events.map(e => e.id));
  for (const ev of bundle.events) {
    if (eventIds.has(ev.id)) { summary.skipped++; continue; }
    data.events.push({ ...ev, project: name });
    summary.added.events++;
  }
  const worklogIds = new Set(data.worklog.map(w => w.id));
  for (const w of bundle.worklog) {
    if (worklogIds.has(w.id)) { summary.skipped++; continue; }
    data.worklog.push({ ...w, project: name });
    summary.added.worklog++;
  }

  // Profile.
  if (created) {
    const profile: ProjectProfile = { ...bundle.profile, name };
    // The exporting machine's disconnection marker describes ITS disk, not
    // this one — cleanupMissingProjects re-derives it locally if warranted.
    delete profile.disconnectedSince;
    let hw = profile.nextItemNum || 1;
    for (const t of bundle.tags) if (t.num && t.num >= hw) hw = t.num + 1;
    for (const p of bundle.plans) for (const s of p.steps) if (s.num && s.num >= hw) hw = s.num + 1;
    profile.nextItemNum = hw;
    data.projects[name] = profile;
  } else {
    for (const k of ["description", "about", "gitRemote", "gitRepoSlug"] as const) {
      if (!existing[k] && bundle.profile[k]) existing[k] = bundle.profile[k];
    }
    existing.nextItemNum = Math.max(existing.nextItemNum || 1, next);
  }
  if (bundle.injectionConfig && !data.projectInjectionConfigs[name]) {
    data.projectInjectionConfigs[name] = bundle.injectionConfig;
  }

  // Restore the order natural ingestion would have produced: imported historic
  // rows appended at the tail would leave consumers that read "latest by
  // position" seeing years-old rows as newest. Stable sort by ISO timestamp.
  if (summary.added.tags) data.tags.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  if (summary.added.events) data.events.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  if (summary.added.worklog) data.worklog.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));

  return summary;
}

/** Merge the bundle's archive months into the local archive files. Id-deduped
 *  per month, rewritten sorted; months keep their original names so history
 *  stays where a reader expects it. Renumbering does NOT reach into archived
 *  undone entries — they are frozen evidence, restored manually if ever. */
export async function mergeArchiveBundle(
  archive: TransferBundle["archive"] | undefined,
  project: string,
): Promise<{ added: number; months: number }> {
  const out = { added: 0, months: 0 };
  if (!archive) return out;
  for (const [month, rows] of Object.entries(archive.events || {})) {
    if (!Array.isArray(rows)) continue;
    const local = await readArchiveMonth(month);
    const seen = new Set(local.map(e => e.id));
    const fresh = rows.filter(e => e && typeof e === "object" && e.id && e.project === project && !seen.has(e.id));
    if (!fresh.length) continue;
    const merged = [...local, ...fresh].sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
    if (await rewriteArchiveMonth("events", month, merged)) { out.added += fresh.length; out.months++; }
  }
  const undoneKey = (r: UndoneRecord) => {
    const entry = r.entry as { id?: string; text?: string };
    return `${r.undoneAt}|${entry.id ?? ""}|${entry.text ?? ""}`;
  };
  for (const [month, rows] of Object.entries(archive.undone || {})) {
    if (!Array.isArray(rows)) continue;
    const local = await readUndoneMonth(month);
    const seen = new Set(local.map(undoneKey));
    const fresh = rows.filter(r => r && typeof r === "object" && r.undoneAt && r.entry && r.project === project && !seen.has(undoneKey(r)));
    if (!fresh.length) continue;
    const merged = [...local, ...fresh].sort((a, b) => (a.undoneAt || "").localeCompare(b.undoneAt || ""));
    if (await rewriteArchiveMonth("undone", month, merged)) { out.added += fresh.length; out.months++; }
  }
  return out;
}

/** Copy the five split stores to dated `.bak` twins before an import mutates
 *  them — same suffix the existing backup pruning already manages, so the
 *  copies age out on their own. */
export async function backupStores(label: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const n of ["projects", "tags", "events", "plans", "meta"]) {
    const src = Bun.file(`${DATA_DIR}/${n}.json`);
    if (await src.exists()) await Bun.write(`${DATA_DIR}/${n}.${stamp}-${label}.bak`, src);
  }
}
