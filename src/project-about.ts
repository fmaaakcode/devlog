// The `-(ask:about)` payload (#1342): one answer to "what is this project and
// what is it built on?" — the stored description in full (the SessionStart
// block only says `about: yes`), the facts the scanner found on its own, and
// the drift checks (#1344) that tell the reader how far to trust the text.
//
// Why drift lives here: the description is hand-written and ages silently. In
// D:\kb it was 20 releases old, named an MCP package the project had replaced,
// and the library list mixed a finished experiment's folder into the system's
// — all three read as fact by a fresh session. The checks are deliberately
// narrow so they never cry wolf: a SCOPED package name (`@scope/name`) the
// manifest lacks, or a name whose `-(lib)` purpose outlived its removal from
// the manifest. Plain words ("hono") are only checked against that second
// list, because prose is full of words that merely look like package names.
//
// Pure: the route supplies the ABOUT.md modification time.

import { buildDepsPayload } from "./deps-explain";
import type { DevLogData } from "./types";

export interface AboutFacts {
  language: string;
  framework: string;
  runtime?: string;
  totalFiles: number;
  directories: string[];
  libraries: { runtime: number; dev: number; forced: number };
  /** Manifest folders when more than one ("" = root). */
  dirs?: string[];
}

export interface AboutDrift {
  /** The description was written this many releases ago. */
  releasesSince: number;
  /** Library names the description mentions that the manifest no longer has. */
  missingLibs: string[];
  /** `-(lib)` purposes kept for libraries the manifest no longer has. */
  stalePurposes: string[];
}

export interface AboutPayload {
  project: string;
  desc: string;
  about: string;
  /** When the description was last written (ABOUT.md mtime, else the last
   *  `-(about)` tag). Absent when neither exists. */
  aboutAt?: string;
  facts: AboutFacts;
  drift: AboutDrift;
}

const MAX_DIRS = 8;
// npm scoped names — the one package-name shape prose never produces by accident.
const SCOPED = /@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/gi;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names in `about` that point at libraries the manifest does not hold. */
export function missingLibMentions(about: string, known: Set<string>, removed: string[]): string[] {
  const out = new Set<string>();
  for (const m of about.matchAll(SCOPED)) {
    const name = m[0].replace(/[.]+$/, "");
    if (!known.has(name.toLowerCase())) out.add(name);
  }
  for (const name of removed) {
    // Word-ish boundary: not part of a longer identifier on either side.
    const re = new RegExp(`(^|[^\\w@/.-])${escapeRe(name)}(?![\\w/-])`, "i");
    if (re.test(about)) out.add(name);
  }
  return [...out].sort();
}

export function buildAboutPayload(data: DevLogData, project: string, aboutFileMtime?: string): AboutPayload | null {
  const p = data.projects[project];
  if (!p) return null;
  const tags = data.tags.filter(t => t.project === project);
  const lastAboutTag = [...tags].reverse().find(t => t.tag === "about");
  const aboutAt = aboutFileMtime || lastAboutTag?.timestamp;
  const releasesSince = aboutAt
    ? tags.filter(t => t.tag === "release" && t.timestamp > aboutAt).length
    : 0;

  const deps = buildDepsPayload(data, project);
  const libs = p.libraries || [];
  const known = new Set([...libs, ...(p.forced || [])].map(l => l.name.toLowerCase()));
  const stalePurposes = (deps?.orphans || []).map(o => o.name);
  const about = p.about || "";

  const rt = p.runtime;
  const runtime = rt?.name ? [rt.name, rt.version].filter(Boolean).join(" ") : undefined;

  return {
    project,
    desc: p.description || "",
    about,
    ...(aboutAt ? { aboutAt } : {}),
    facts: {
      language: p.language || "",
      framework: p.framework || "",
      ...(runtime ? { runtime } : {}),
      totalFiles: p.totalFiles || 0,
      directories: (p.directories || []).slice(0, MAX_DIRS),
      libraries: {
        runtime: libs.filter(l => !l.dev).length,
        dev: libs.filter(l => l.dev).length,
        forced: (p.forced || []).length,
      },
      ...(deps?.dirs ? { dirs: deps.dirs } : {}),
    },
    drift: {
      releasesSince,
      missingLibs: about ? missingLibMentions(about, known, stalePurposes) : [],
      stalePurposes,
    },
  };
}
