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
import { esc } from "./html-escape";
import { currentLang } from "./i18n";
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

const L = (en: string, ar: string): string => (currentLang() === "ar" ? ar : en);
const BUMP_LABEL: Record<string, [en: string, ar: string]> = {
  patch: ["patch", "ترقيعي"], minor: ["minor", "فرعي"], major: ["major", "رئيسي"],
};

// Bilingual (F-6.18 — the banner was Arabic-only on an otherwise DEVLOG_LANG-
// aware page) and drawn from the page's own theme tokens (the release page
// embeds DL_THEME_ROOT) instead of re-stating its hex: the dl-theme contract
// keeps colour hex in one place. Logical padding so RTL/LTR both indent the list.
function previewBanner(intent: ReleaseIntent, blockers: ReleaseOpenItem[]): string {
  const bump = BUMP_LABEL[intent.bump];
  const bumpLabel = `${bump ? L(...bump) : intent.bump}${intent.auto ? L(" — auto-detected from the evidence", " — مُكتشف تلقائيًا من الأدلة") : ""}`;
  const blockersHtml = blockers.length
    ? `<p style="margin:10px 0 0;color:var(--c-security)"><b>${L(`⛔ ${blockers.length} open item(s) will block this release:`, `⛔ ${blockers.length} عنصر مفتوح سيحجب هذا الإصدار:`)}</b></p>
       <ul style="margin:6px 0 0;padding-inline-start:20px;color:var(--c-security);font-size:0.9em">
         ${blockers.map(b => `<li>${typeof b.num === "number" ? `#${b.num} ` : ""}${esc(b.content.slice(0, 90))}${b.planTitle ? ` <span style="opacity:0.7">(${L("plan", "خطة")}: ${esc(b.planTitle)})</span>` : ""}</li>`).join("\n         ")}
       </ul>`
    : `<p style="margin:10px 0 0;color:var(--c-built)">${L("✓ No open items — the release is ready whenever you ask for it.", "✓ لا عناصر مفتوحة — الإصدار جاهز متى طلبته.")}</p>`;
  return `
  <section class="dl-preview-banner" style="border:1px dashed var(--c-update);background:color-mix(in srgb, var(--c-update) 7%, transparent);border-radius:10px;padding:14px 18px;margin-bottom:18px">
    <strong style="color:var(--c-update)">${L("⚠ Live preview — this release has not shipped and nothing is written to disk", "⚠ معاينة حية — هذا الإصدار لم يُصدر بعد ولا يُكتب شيء على القرص")}</strong>
    <p style="margin:8px 0 0;color:var(--text2);font-size:0.9em">
      ${L("Predicted number", "الرقم المتوقع")} <b style="color:var(--text);font-family:'Cascadia Code',Consolas,monospace">v${esc(intent.version)}</b>
      ${L(`from ${esc(intent.from)} (${esc(bumpLabel)} bump).`, `انطلاقًا من ${esc(intent.from)} (رفع ${esc(bumpLabel)}).`)}
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
    content: L(`v${intent.version} — next release preview`, `v${intent.version} — معاينة الإصدار القادم`),
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
