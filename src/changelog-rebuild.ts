// DEVLOG_CHANGELOG.md line format + the one-time rebuild GC (#F1). Extracted
// from export.ts (file-size budget): the append path there imports
// changelogLine so both writers share one byte-exact format — the drift between
// them is what let the 70MB duplicate-history changelog happen.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DevLogData, TagEntry } from "./types";

const tagIcon: Record<string, string> = {
  built: "✅", "bug fix": "🔧", security: "🔒", release: "📦",
  update: "📦", refactor: "♻️", note: "📝", "bug found": "🔴",
  plan: "📋", todo: "📌", done: "✔️", outdated: "⏳",
};

// One physical line per entry, tagged with the stable tag `id` (#F1). The old
// format wrote `t.content` raw, so a multi-line body (built/refactor/decision…)
// spanned several lines: the dedup regex — which needs `- … (HH:MM)` on ONE
// line — matched none of them, so the entry never entered `logged` and was
// RE-APPENDED on every POST (the changelog ballooned to 70MB). Flattening +
// the `<!-- id -->` marker (already parsed by the dedup loop) makes the match
// byte-exact and immune to newlines.
export function changelogLine(t: TagEntry): string {
  const icon = tagIcon[t.tag] || "•";
  const time = t.timestamp.split("T")[1]?.slice(0, 5) || "";
  const flat = (t.content || "").replace(/\s*\n\s*/g, " ⏎ ");
  return `- ${icon} **${t.tag}** ${flat} (${time}) <!-- id:${t.id} -->\n`;
}

/**
 * One-time GC (#F1): rebuild every existing project changelog from data.tags,
 * deduped by id, collapsing the runaway duplicate history (the helper project's
 * file had reached 70MB / 527K lines). Idempotent via the
 * `changelog_rebuild_v1` migration flag. Only touches files that already exist
 * (won't create changelogs for projects that never had one). Returns how many
 * were rebuilt; mutates data.migrations (caller persists).
 */
export async function rebuildChangelogsMigration(data: DevLogData): Promise<number> {
  if (!data.migrations) data.migrations = {};
  if (data.migrations.changelog_rebuild_v1) return 0;
  let rebuilt = 0;
  for (const [name, profile] of Object.entries(data.projects)) {
    if (!profile.path) continue;
    const devlogDir = join(profile.path, ".devlog");
    if (!existsSync(join(devlogDir, "DEVLOG_CHANGELOG.md"))) continue;
    try {
      await rebuildChangelog(devlogDir, data.tags.filter(t => t.project === name));
      rebuilt++;
    } catch (e) {
      console.error(`[migrate changelog] ${name}:`, (e as Error)?.message);
    }
  }
  data.migrations.changelog_rebuild_v1 = true;
  return rebuilt;
}

// Rebuild a project's changelog from scratch, deduped by stable id (#F1 GC).
// Used by the one-time migration to collapse the runaway duplicate history.
export async function rebuildChangelog(devlogDir: string, tags: TagEntry[]): Promise<number> {
  const seen = new Set<string>();
  const unique = tags
    .filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; })
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  let out = "# سجل التغييرات\n";
  let lastDay = "";
  for (const t of unique) {
    const day = t.timestamp.split("T")[0];
    if (day !== lastDay) { out += `\n## ${day}\n`; lastDay = day; }
    out += changelogLine(t);
  }
  await Bun.write(join(devlogDir, "DEVLOG_CHANGELOG.md"), out);
  // Keep the append-path dedup index in sync with the freshly rebuilt file.
  await Bun.write(join(devlogDir, ".changelog-index.json"),
    JSON.stringify({ ids: unique.map(t => t.id), lastDay }));
  return unique.length;
}
