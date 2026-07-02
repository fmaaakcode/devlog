// Disk persistence for -(doc) tag bodies. Writes both .md (source of truth)
// and .html (rendered copy via doc-templates). Files live under
//   <projectPath>/.devlog/docs/<slug>.{md,html}
// alongside a small index.json tracking metadata.

import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { join } from "node:path";
import { renderDocHtml, docSlug, DOC_TYPES, MAX_DOC_BYTES, type DocType } from "./doc-templates";
import type { PlanStep } from "./types";

interface DocIndexEntry {
  slug: string;
  name: string;
  type: DocType;
  createdAt: string;
  updatedAt: string;
}

export interface DocWriteResult {
  slug: string;
  type: DocType;
  mdPath: string;
  htmlPath: string;
  /** GFM-style checkboxes parsed from the body. Empty for non-plan docs. */
  steps: PlanStep[];
}

function docsDirFor(projectPath: string): string {
  return join(projectPath, ".devlog", "docs");
}

async function readIndex(dir: string): Promise<DocIndexEntry[]> {
  try {
    const parsed = await Bun.file(join(dir, "index.json")).json();
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writeIndex(dir: string, entries: DocIndexEntry[]): Promise<void> {
  // Atomic temp+rename so a crash mid-write can't truncate index.json — matches
  // the house pattern in version-writer.ts / data.ts (R3 P5).
  const target = join(dir, "index.json");
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(entries, null, 2), "utf-8");
  await rename(tmp, target);
}

// Split the doc payload: first non-empty line is the doc name (slug source),
// everything after is the markdown body. The user writes:
//   -(doc:report) my-review-name
//   # heading
//   body...
function splitNameAndBody(raw: string): { name: string; body: string } {
  const idx = raw.indexOf("\n");
  if (idx < 0) return { name: raw.trim() || "untitled", body: "" };
  const name = raw.slice(0, idx).trim() || "untitled";
  const body = raw.slice(idx + 1);
  return { name, body };
}

function isValidType(t: string): t is DocType {
  return (DOC_TYPES as readonly string[]).includes(t);
}

// GFM checkbox extractor:  "- [ ] step"  or  "- [x] done step"  (or * + as bullet,
// case-insensitive on x). Returns empty list if no checkboxes — caller treats
// the doc as a free-form static page.
//
// Each step also carries the phase code from its nearest preceding heading
// like "### P0 — Bootloader" → phase "P0". Sub-codes like "### P4.1 …" are
// captured as "P4.1". Enables phase-level -(done) Pn closure server-side.
const CHECKBOX_LINE_RE = /^[ \t]*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const PHASE_HEADING_RE = /^(P\d+(?:\.\d+)?)\b/;

export function extractCheckboxes(md: string): PlanStep[] {
  const out: PlanStep[] = [];
  let currentPhase: string | undefined;
  for (const line of md.split("\n")) {
    const h = line.match(HEADING_RE);
    if (h) {
      // Any heading at the section level (### or shallower) resets the
      // active phase. Non-phase headings clear it so unrelated checkboxes
      // (e.g. "الخطوات الفورية") aren't tagged with the previous phase.
      // Deeper headings (#### …) inside a phase are left alone.
      if (h[1].length <= 3) {
        const p = h[2].match(PHASE_HEADING_RE);
        currentPhase = p ? p[1] : undefined;
      }
      continue;
    }
    const c = line.match(CHECKBOX_LINE_RE);
    if (c) {
      const step: { text: string; completed: boolean; phase?: string } = {
        text: c[2].trim(),
        completed: c[1].toLowerCase() === "x",
      };
      if (currentPhase) step.phase = currentPhase;
      out.push(step);
    }
  }
  return out;
}

// Mark a single step done/undone in the .md body by exact-text match. Returns
// the new body if any line was updated, else null. Used when -(done)/-(dropped)
// arrives and we need to flip the checkbox in a doc:plan file.
// parse-tags replaces inline `…` in tag content with run-of-spaces (to preserve
// offsets while killing fake-tag injection). Match the same shape on the step
// side: drop the backticked content entirely, then collapse whitespace.
const normalizeStepText = (s: string) =>
  s.replace(/`[^`\n]*`/g, " ").replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();

export function toggleCheckboxInBody(body: string, stepText: string, done: boolean): string | null {
  const target = normalizeStepText(stepText);
  if (!target) return null;
  let changed = false;
  const out = body.replace(/^([ \t]*[-*+]\s+\[)([ xX])(\]\s+)(.+?)([ \t]*)$/gm, (full, p1, mark, p3, text, p5) => {
    if (normalizeStepText(text) !== target) return full;
    const newMark = done ? "x" : " ";
    if (mark === newMark) return full;            // already in target state
    changed = true;
    return p1 + newMark + p3 + text + p5;
  });
  return changed ? out : null;
}

// Remove a checkbox line from the body by exact text match. Used when
// -(dropped) arrives — the step is cancelled, not just unchecked. Returns
// the new body when a line was removed, else null.
export function removeCheckboxFromBody(body: string, stepText: string): string | null {
  const target = normalizeStepText(stepText);
  if (!target) return null;
  let changed = false;
  // Match the whole line including its trailing newline so we don't leave a
  // blank gap; if it's the last line, the trailing newline may be missing.
  const out = body.replace(/^([ \t]*[-*+]\s+\[[ xX]\]\s+)(.+?)([ \t]*)$\n?/gm, (full, _prefix, text) => {
    if (normalizeStepText(text) !== target) return full;
    changed = true;
    return "";
  });
  return changed ? out : null;
}

// Create or replace a doc. Returns the absolute path of the .html file plus
// metadata the server uses to keep tag-side bookkeeping in sync.
export async function writeDoc(
  projectPath: string,
  projectName: string,
  type: string,
  rawContent: string
): Promise<DocWriteResult> {
  if (!isValidType(type)) throw new Error(`unknown doc type: ${type}`);
  if (rawContent.length > MAX_DOC_BYTES) {
    throw new Error(`doc body too large: ${rawContent.length} bytes (max ${MAX_DOC_BYTES})`);
  }

  const { name, body } = splitNameAndBody(rawContent);
  const slug = docSlug(name);
  const dir = docsDirFor(projectPath);
  await mkdir(dir, { recursive: true });

  const now = new Date().toISOString();
  const index = await readIndex(dir);
  const existing = index.find(e => e.slug === slug);
  const meta = existing
    ? { ...existing, name, type, updatedAt: now }
    : { slug, name, type, createdAt: now, updatedAt: now };

  if (existing) Object.assign(existing, meta);
  else index.push(meta);

  const mdPath = join(dir, `${slug}.md`);
  await writeFile(mdPath, body, "utf-8");
  const html = renderDocHtml({ ...meta, project: projectName }, body);
  const htmlPath = join(dir, `${slug}.html`);
  await writeFile(htmlPath, html, "utf-8");
  await writeIndex(dir, index);

  return { slug, type, mdPath, htmlPath, steps: extractCheckboxes(body) };
}

// Append additional content to an existing doc by slug match. Used by
// -(doc:update) name. The existing doc keeps its type; body grows by
// `\n\n` + new content. Re-renders HTML.
export async function appendDoc(
  projectPath: string,
  projectName: string,
  rawContent: string
): Promise<DocWriteResult> {
  if (rawContent.length > MAX_DOC_BYTES) {
    throw new Error(`update body too large: ${rawContent.length} bytes (max ${MAX_DOC_BYTES})`);
  }

  const { name, body } = splitNameAndBody(rawContent);
  const slug = docSlug(name);
  const dir = docsDirFor(projectPath);
  try { await access(dir); } catch { throw new Error(`no docs directory for ${projectName}`); }

  const index = await readIndex(dir);
  const meta = index.find(e => e.slug === slug);
  if (!meta) throw new Error(`doc not found for update: ${slug}`);

  const mdPath = join(dir, `${slug}.md`);
  const oldBody = await readFile(mdPath, "utf-8");
  const newBody = `${oldBody.trimEnd()}\n\n${body.trim()}\n`;
  if (newBody.length > MAX_DOC_BYTES) {
    throw new Error(`merged doc would exceed max size (${newBody.length} > ${MAX_DOC_BYTES})`);
  }

  meta.updatedAt = new Date().toISOString();
  await writeFile(mdPath, newBody, "utf-8");
  const html = renderDocHtml({ ...meta, project: projectName }, newBody);
  const htmlPath = join(dir, `${slug}.html`);
  await writeFile(htmlPath, html, "utf-8");
  await writeIndex(dir, index);

  return { slug, type: meta.type, mdPath, htmlPath, steps: extractCheckboxes(newBody) };
}

// Apply a single step completion to an existing doc:plan file. Looks up the
// doc by mdPath, mutates the checkbox line, re-renders HTML, bumps updatedAt.
// Returns true if the file changed, false if no matching unticked step.
export async function applyTaskCompletion(
  projectPath: string,
  projectName: string,
  mdPath: string,
  stepText: string,
  done: boolean
): Promise<boolean> {
  return applyDocMutation(projectPath, projectName, mdPath, body => toggleCheckboxInBody(body, stepText, done));
}

// Remove a step entirely (used by -(dropped)). Returns true if the line was
// removed, false if no matching step was found.
export async function applyTaskDrop(
  projectPath: string,
  projectName: string,
  mdPath: string,
  stepText: string
): Promise<boolean> {
  return applyDocMutation(projectPath, projectName, mdPath, body => removeCheckboxFromBody(body, stepText));
}

// Shared helper: read .md, apply mutation, re-render .html, bump updatedAt.
async function applyDocMutation(
  projectPath: string,
  projectName: string,
  mdPath: string,
  mutate: (body: string) => string | null,
): Promise<boolean> {
  const dir = docsDirFor(projectPath);
  try { await access(mdPath); } catch { return false; }
  const body = await readFile(mdPath, "utf-8");
  const next = mutate(body);
  if (next === null) return false;

  await writeFile(mdPath, next, "utf-8");

  const index = await readIndex(dir);
  const slug = (mdPath.split(/[\\/]/).pop() ?? "").replace(/\.md$/, "");
  const meta = index.find(e => e.slug === slug);
  if (meta) {
    meta.updatedAt = new Date().toISOString();
    const html = renderDocHtml({ ...meta, project: projectName }, next);
    const htmlPath = join(dir, `${slug}.html`);
    await writeFile(htmlPath, html, "utf-8");
    await writeIndex(dir, index);
  }
  return true;
}
