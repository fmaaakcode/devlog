// Live preview of the NEXT release (#490): renders the exact page a
// `-(release)` would produce RIGHT NOW — predicted version, changelog since the
// last release, the «قادم» snapshot — entirely in memory. Nothing is written to
// disk and nothing is stored, so the preview is always fresh and can never be
// mistaken for (or corrupt) a real baked release page. Served under
// `/releases/:project/preview.html` so every relative link on the page (crumb →
// index.html, prev-version → vX.Y.Z.html) resolves against the real pages.
//
// Honesty rule: the prediction and the content go through the SAME functions
// the real release uses (resolveReleaseIntent → collectRelease →
// renderReleaseHtml, blockers via detectReleaseOpenItems) — no parallel logic
// that could drift into a lying preview.

import type { DevLogData, TagEntry } from "./types";
import { collectRelease, renderReleaseHtml, type ReleaseFacts } from "./release-html";
import {
  resolveReleaseIntent, detectReleaseOpenItems,
  type ReleaseIntent, type ReleaseOpenItem,
} from "./tags-service";

export interface ReleasePreview {
  html: string;
  facts: ReleaseFacts;
  intent: ReleaseIntent;
  blockers: ReleaseOpenItem[];
}

const esc = (s: string): string =>
  String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

const BUMP_AR: Record<string, string> = { patch: "ترقيعي", minor: "فرعي", major: "رئيسي" };

function previewBanner(intent: ReleaseIntent, blockers: ReleaseOpenItem[]): string {
  const bumpLabel = `${BUMP_AR[intent.bump] ?? intent.bump}${intent.auto ? " — مُكتشف تلقائيًا من الأدلة" : ""}`;
  const blockersHtml = blockers.length
    ? `<p style="margin:10px 0 0;color:#ef476f"><b>⛔ ${blockers.length} عنصر مفتوح سيحجب هذا الإصدار:</b></p>
       <ul style="margin:6px 0 0;padding-right:20px;color:#ef476f;font-size:0.9em">
         ${blockers.map(b => `<li>${typeof b.num === "number" ? `#${b.num} ` : ""}${esc(b.content.slice(0, 90))}${b.planTitle ? ` <span style="opacity:0.7">(خطة: ${esc(b.planTitle)})</span>` : ""}</li>`).join("\n         ")}
       </ul>`
    : `<p style="margin:10px 0 0;color:#06d6a0">✓ لا عناصر مفتوحة — الإصدار جاهز متى طلبته.</p>`;
  return `
  <section class="dl-preview-banner" style="border:1px dashed #ffd166;background:rgba(255,209,102,0.07);border-radius:10px;padding:14px 18px;margin-bottom:18px">
    <strong style="color:#ffd166">⚠ معاينة حية — هذا الإصدار لم يُصدر بعد ولا يُكتب شيء على القرص</strong>
    <p style="margin:8px 0 0;color:#9A9A9A;font-size:0.9em">
      الرقم المتوقع <b style="color:#EEEEEE;font-family:'Cascadia Code',Consolas,monospace">v${esc(intent.version)}</b>
      انطلاقًا من ${esc(intent.from)} (رفع ${esc(bumpLabel)}).
    </p>
    ${blockersHtml}
  </section>`;
}

/** Build the next-release preview for `project`, or null when the project is
 *  unknown. Read-only: `data` is never mutated (the intent resolver works on a
 *  local scratch entry) and nothing touches the releases directory. */
export async function buildReleasePreview(data: DevLogData, project: string): Promise<ReleasePreview | null> {
  const p = data.projects[project];
  if (!p) return null;

  // Scratch entry: resolveReleaseIntent mutates ONLY this local object into a
  // standard `vX.Y.Z` release tag; empty content → auto-detected bump type.
  const scratch = { tag: "release", content: "" };
  const intent = await resolveReleaseIntent(scratch, data, project, p.path);
  if (!intent) return null;

  const target: TagEntry = {
    id: "release-preview",
    project,
    tag: "release",
    content: `v${intent.version} — معاينة الإصدار القادم`,
    timestamp: new Date().toISOString(),
  };
  const facts = collectRelease(data, project, target);
  // The synthetic target isn't in data.tags, so collectRelease can't find its
  // predecessor by timestamp — the intent already knows what we're bumping FROM.
  // Baked pages carry the `v` prefix in their filenames (safeVerSlug of the tag
  // content), while intent.from is stripped — restore it so the link resolves.
  if (!facts.prevVersion && intent.from !== "0.0.0") facts.prevVersion = `v${intent.from}`;

  const blockers = detectReleaseOpenItems(data, project, [])?.openItems ?? [];
  const html = renderReleaseHtml(facts, { banner: previewBanner(intent, blockers) });
  return { html, facts, intent, blockers };
}
