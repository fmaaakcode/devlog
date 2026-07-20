// The deps explainer (#663): merges the manifest's installed libraries with
// their locally-recorded purpose lines (`-(lib) name — غرض` stored tags) and
// the registry's official one-liner cached by the vuln scan — answering the
// two questions every dependency raises: what IS this library (official
// description, free from the registry JSON) and why is it in THIS project
// (the purpose line, which only the project's own log can know).

import type { DevLogData } from "./types";

export interface DepPurpose {
  purpose: string;
  at: string; // ISO timestamp of the tag that recorded it
}

/** `-(lib) name — غرض` → {name, purpose}. The separator dash (—/–/-) is
 *  optional; a name with no purpose text is invalid (nothing to record). */
export function parseLibTag(content: string): { name: string; purpose: string } | null {
  const m = (content || "").trim().match(/^(\S+)\s+(.+)$/);
  if (!m) return null;
  // Strip the separator AFTER capture, so a bare `name —` can't pass the
  // separator itself off as the purpose.
  const purpose = m[2].replace(/^[—–-]+\s*/, "").trim();
  if (!purpose) return null;
  return { name: m[1], purpose };
}

/**
 * Latest purpose per package name (features.ts's latest-wins pattern: tags are
 * appended in order, so a re-emitted `-(lib) name — new text` replaces the old
 * purpose on read). Keys are lowercased — npm forbids uppercase and the other
 * registries fold case, so a case-variant re-emit must replace, not duplicate.
 * Pure — derived from the tag log on every read, so undo/edit reflects
 * immediately.
 */
export function depPurposes(data: DevLogData, project: string): Map<string, DepPurpose> {
  const out = new Map<string, DepPurpose>();
  for (const t of data.tags) {
    if (t.project !== project || t.tag !== "lib") continue;
    const p = parseLibTag(t.content);
    if (!p) continue;
    out.set(p.name.toLowerCase(), { purpose: p.purpose, at: t.timestamp });
  }
  return out;
}

export interface DepExplainItem {
  name: string;
  version: string;
  dev?: boolean;
  eco?: string;
  purpose?: string;
  purposeAt?: string;
  /** Official registry one-liner — absent until a vuln scan has cached it. */
  description?: string;
  vulns?: number;
  severity?: string;
  isLatest?: boolean;
  latestVersion?: string;
  detailsUrl?: string;
}

export interface DepsExplainPayload {
  project: string;
  total: number;
  /** Coverage: how many libraries carry a recorded purpose line. */
  withPurpose: number;
  libraries: DepExplainItem[];
}

/** The /api/deps payload: every manifest library, annotated. Null when the
 *  project is unknown. Uncovered libraries sort first so both the page and the
 *  ask:deps answer surface the backfill gap before the finished rows. */
export function buildDepsPayload(data: DevLogData, project: string): DepsExplainPayload | null {
  const p = data.projects[project];
  if (!p) return null;
  const purposes = depPurposes(data, project);
  const vulns = p.vulnResults || {};
  const libraries: DepExplainItem[] = (p.libraries || []).map((l) => {
    const pur = purposes.get(l.name.toLowerCase());
    const v = vulns[l.name];
    return {
      name: l.name,
      version: l.version,
      ...(l.dev ? { dev: true } : {}),
      ...(l.eco ? { eco: l.eco } : {}),
      ...(pur ? { purpose: pur.purpose, purposeAt: pur.at } : {}),
      ...(v?.description ? { description: v.description } : {}),
      ...(typeof v?.vulns === "number" && v.vulns > 0 ? { vulns: v.vulns, ...(v.severity ? { severity: v.severity } : {}) } : {}),
      ...(typeof v?.isLatest === "boolean" ? { isLatest: v.isLatest } : {}),
      ...(v?.latestVersion ? { latestVersion: v.latestVersion } : {}),
      ...(v?.detailsUrl ? { detailsUrl: v.detailsUrl } : {}),
    };
  });
  libraries.sort((a, b) => Number(!!a.purpose) - Number(!!b.purpose) || a.name.localeCompare(b.name));
  return {
    project,
    total: libraries.length,
    withPurpose: libraries.filter((l) => l.purpose).length,
    libraries,
  };
}
