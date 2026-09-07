// DEVLOG_STACK.md — the deep-analysis artifact written into the user's repo.
// Split out of export.ts (size ratchet, wave 3); export.ts re-exports the two
// entry points so every caller keeps importing from "./export".
//
// Regeneration policy (#1093): the file carries a body-hash trailer; the
// automatic path (first hook, every scan) overwrites it while the trailer still
// matches — i.e. nobody edited it by hand. A hand-edited file is kept until the
// dashboard's explicit regenerate. Section headings are the contract
// stack-parser.ts reads back; the two files change together.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectProfile } from "./types";
import { analyzeProject } from "./analyze";
import { currentLang } from "./i18n";

const L = (en: string, ar: string): string => (currentLang() === "ar" ? ar : en);
// Every heuristic section of DEVLOG_STACK.md carries this line so the reader
// (human or agent) never takes a text-signature match for an established fact.
const INFERENCE_NOTE = (tail?: string): string => L(
  `> Textual inference from the code${tail ? ` — ${tail}` : ""}.`,
  `> استدلال نصّي من الكود${tail ? ` — ${tail}` : ""}.`);

// Trailer written at the end of a generated DEVLOG_STACK.md: a hash of the body
// above it. On the next generation the file is overwritten only if its body
// still hashes to its trailer — i.e. nobody edited it by hand. That replaces
// "generate once, then never" (#1093): the file was written at a project's
// FIRST hook, usually before any code existed, and no automatic path ever
// touched it again — 35 of 55 tracked maps were empty, and DevLog's own sat 27
// days stale while the dashboard read it as the source of truth.
const STACK_HASH_RE = /\n<!-- devlog:stack ([0-9a-f]+) -->\s*$/;
function stackBodyHash(body: string): string {
  return Bun.hash(body).toString(16);
}
function stackTrailer(body: string): string {
  return `\n<!-- devlog:stack ${stackBodyHash(body)} -->\n`;
}
/** True when an existing stack file may be overwritten by an automatic regeneration. */
export function stackFileIsGenerated(content: string): boolean {
  const m = content.match(STACK_HASH_RE);
  if (!m) {
    // Legacy files (pre-trailer): the empty-analysis residue of the old lib/
    // skip (R9 F2) is regenerated; a legacy file WITH content is treated as
    // generated too — it is a machine artifact that was frozen at first hook,
    // and the one-time regeneration writes the trailer that protects any
    // manual edit made from here on.
    return true;
  }
  const body = content.slice(0, content.length - m[0].length);
  return stackBodyHash(body) === m[1];
}

export async function generateStackMd(projectPath: string, project: ProjectProfile, force = false) {
  const devlogDir = join(projectPath, ".devlog");
  const stackFile = join(devlogDir, "DEVLOG_STACK.md");

  // Regenerate unless the existing file carries manual edits (see
  // stackFileIsGenerated); force = explicit regen from the dashboard button.
  const file = Bun.file(stackFile);
  if (!force && await file.exists()) {
    const current = await file.text().catch(() => "");
    if (current && !stackFileIsGenerated(current)) return;
    // A legacy file (no trailer) with real content is overwritten exactly once
    // — and archived first, as every overwrite of user-repo data is (§0.6):
    // it MAY carry hand edits the old generate-once contract promised to keep.
    // The empty-analysis residue of the old lib/ skip (R9 F2) has nothing to keep.
    if (current && !STACK_HASH_RE.test(current) && !/\| 0 (?:سطر \| 0 دالة|lines \| 0 functions)/.test(current)) {
      const legacy = join(devlogDir, "DEVLOG_STACK.legacy.md");
      if (!existsSync(legacy)) await Bun.write(legacy, current).catch(() => { /* archive is best-effort; the regeneration itself is the fix */ });
    }
  }
  if (!existsSync(projectPath)) return;   // same rule as exportStatusMd (#1058/#1063): never create the project folder

  try { await mkdir(devlogDir, { recursive: true }); } catch { /* best-effort: a real failure resurfaces at the write below */ }

  // Deep analysis
  const analysis = await analyzeProject(projectPath);

  const lines: string[] = [];
  lines.push(`# ${project.name}`);
  lines.push("");

  // Detect all languages used and runtimes
  const cppFiles = (project.files.cpp || 0) + (project.files.cc || 0) + (project.files.cxx || 0) + (project.files.c || 0) + (project.files.h || 0) + (project.files.hpp || 0) + (project.files.cu || 0);
  const tsFiles = (project.files.ts || 0) + (project.files.tsx || 0);
  const jsFiles = (project.files.js || 0) + (project.files.jsx || 0);
  const pyFiles = (project.files.py || 0);
  const rsFiles = (project.files.rs || 0);
  const goFiles = (project.files.go || 0);

  // Build language list (dominant first)
  const langs: string[] = [];
  const langCounts: [string, number][] = [];
  if (cppFiles > 0) langCounts.push(["C++", cppFiles]);
  if (tsFiles > 0) langCounts.push(["TypeScript", tsFiles]);
  if (jsFiles > 0) langCounts.push(["JavaScript", jsFiles]);
  if (rsFiles > 0) langCounts.push(["Rust", rsFiles]);
  if (pyFiles > 0) langCounts.push(["Python", pyFiles]);
  if (goFiles > 0) langCounts.push(["Go", goFiles]);
  langCounts.sort((a, b) => b[1] - a[1]);
  for (const [lang] of langCounts) langs.push(lang);
  if (langs.length === 0) langs.push(project.language);

  // Detect standard/runtime for each language
  const qualifiers: string[] = [];
  if (langs.includes("C++")) {
    if (analysis.patterns.includes("CUDA")) qualifiers.push("CUDA");
    if (analysis.patterns.includes("CMake")) qualifiers.push("CMake");
    // Detect C++ standard from CMakeLists or code
    if (project.files.cu) qualifiers.push("CUDA");
  }
  if (langs.includes("TypeScript") || langs.includes("JavaScript")) {
    const bunLock = await Bun.file(join(projectPath, "bun.lockb")).exists() || await Bun.file(join(projectPath, "bunfig.toml")).exists();
    if (bunLock || (tsFiles > 0 && !project.libraries.some(l => l.name === "typescript"))) qualifiers.push("Bun");
    else if (await Bun.file(join(projectPath, "package-lock.json")).exists()) qualifiers.push("Node.js");
    else if (await Bun.file(join(projectPath, "yarn.lock")).exists()) qualifiers.push("Yarn");
    else if (await Bun.file(join(projectPath, "pnpm-lock.yaml")).exists()) qualifiers.push("pnpm");
    // Deno detection
    if (await Bun.file(join(projectPath, "deno.json")).exists() || await Bun.file(join(projectPath, "deno.jsonc")).exists()) {
      qualifiers.length = 0; // clear Bun detection
      qualifiers.push("Deno");
    }
  }

  const langStr = langs.join(" / ") + (qualifiers.length > 0 ? ` (${[...new Set(qualifiers)].join(", ")})` : "");

  // The project description is the DECLARED one (`-(desc)`), never a guess.
  // It used to be assembled from detected patterns, which states things nobody
  // claimed: a Bun/TypeScript project came out as "P2P + واجهة Qt" because two
  // text signatures matched (#791). Patterns are still listed below under
  // «الأنماط», where they read as evidence rather than as an identity. No
  // `-(desc)` yet → no line at all; the describe-nudge already asks for one.
  const declaredDesc = (project.description || "").trim();

  // Stack. Headings follow the i18n policy like STATUS/GITHUB (#892/#906):
  // English default, DEVLOG_LANG=ar for Arabic.
  lines.push("## Stack");
  lines.push(L(`- **Language**: ${langStr}`, `- **اللغة**: ${langStr}`));
  if (declaredDesc) lines.push(L(`- **Description**: ${declaredDesc}`, `- **الوصف**: ${declaredDesc}`));
  if (project.framework) lines.push(L(`- **Framework**: ${project.framework}`, `- **الإطار**: ${project.framework}`));
  if (analysis.patterns.length > 0) lines.push(L(`- **Patterns**: ${analysis.patterns.join(", ")}`, `- **الأنماط**: ${analysis.patterns.join("، ")}`));
  lines.push(L(
    `- **Files**: ${project.totalFiles} files | ${analysis.totalLines} lines | ≈${analysis.totalFunctions} functions`,
    `- **الملفات**: ${project.totalFiles} ملف | ${analysis.totalLines} سطر | ≈${analysis.totalFunctions} دالة`));
  lines.push("");

  // Libraries
  const prodLibs = project.libraries.filter(l => !l.dev);
  const devLibs = project.libraries.filter(l => l.dev);
  if (project.libraries.length > 0) {
    lines.push(L("## Libraries", "## المكتبات"));
    if (prodLibs.length > 0) {
      for (const l of prodLibs) lines.push(`- ${l.name} \`${l.version}\``);
    }
    if (devLibs.length > 0) {
      lines.push("");
      lines.push("**Dev:**");
      for (const l of devLibs) lines.push(`- ${l.name} \`${l.version}\``);
    }
    lines.push("");
  }

  // Importance indicator based on rank
  const maxFileRank = Math.max(...Object.values(analysis.fileRanks || {}), 0.001);
  function importanceLabel(rank: number, max: number): string {
    const pct = rank / max;
    if (pct > 0.7) return "███";
    if (pct > 0.4) return "██░";
    if (pct > 0.15) return "█░░";
    return "░░░";
  }

  // File map — sorted by importance (already sorted by PageRank)
  if (analysis.files.length > 0) {
    lines.push(L("## File map (sorted by importance)", "## خريطة الملفات (مرتبة بالأهمية)"));
    lines.push(L("| Importance | File | Lines | Description | Exports |", "| الأهمية | الملف | الأسطر | الوصف | يصدّر |"));
    lines.push("|---------|-------|--------|-------|-------|");
    for (const f of analysis.files) {
      const rank = analysis.fileRanks?.[f.path] || 0;
      const bar = importanceLabel(rank, maxFileRank);
      const exportsStr = f.exports.slice(0, 4).join(", ") + (f.exports.length > 4 ? " ..." : "");
      lines.push(`| ${bar} | \`${f.path}\` | ${f.lines} | ${f.description} | ${exportsStr || "—"} |`);
    }
    lines.push("");
  }

  // Functions — sorted by importance within each file
  const maxFnRank = Math.max(...Object.values(analysis.fnRanks || {}), 0.001);
  const filesWithFns = analysis.files.filter(f => f.functions.length > 0);
  if (filesWithFns.length > 0) {
    lines.push(L("## Key functions", "## الدوال الرئيسية"));
    for (const f of filesWithFns) {
      const fname = f.path.split("/").pop()?.replace(/\.\w+$/, "") || f.path;
      // Sort functions by rank
      const sortedFns = [...f.functions].sort((a, b) => {
        const ra = analysis.fnRanks?.[`${f.path}:${a.name}`] || 0;
        const rb = analysis.fnRanks?.[`${f.path}:${b.name}`] || 0;
        return rb - ra;
      });
      lines.push(`### ${fname}`);
      for (const fn of sortedFns) {
        const fnRank = analysis.fnRanks?.[`${f.path}:${fn.name}`] || 0;
        const bar = importanceLabel(fnRank, maxFnRank);
        const prefix = fn.isExported ? "**" : "";
        const suffix = fn.isExported ? "**" : "";
        const async_ = fn.isAsync ? "async " : "";
        let line = `- ${bar} ${prefix}${async_}${fn.name}${fn.params}${suffix}`;
        if (fn.description) line += ` — ${fn.description}`;
        if (fn.lines > 1) line += L(` [${fn.lines} lines]`, ` [${fn.lines} سطر]`);
        lines.push(line);
        if (fn.calls.length > 0) {
          lines.push(L(`  - calls: ${fn.calls.map(c => `\`${c}\``).join(", ")}`, `  - ينادي: ${fn.calls.map(c => `\`${c}\``).join("، ")}`));
        }
      }
      lines.push("");
    }
  }

  // Dependency graph — show both "imports" and "imported by". BOTH ends are the
  // file's full project path, the same identity `files[].path` carries:
  // `analysis.graph` holds the resolved edges (import-resolve.ts). The old
  // lines wrote `→` with the raw specifier (packages included) and `← used by`
  // with a basename, so the parser saw one edge under two identities and the
  // map could not join them to their nodes (#1092).
  if (analysis.files.length > 0) {
    const known = new Set(analysis.files.map(f => f.path));
    const importedBy: Record<string, string[]> = {};
    for (const f of analysis.files) {
      for (const target of analysis.graph[f.path] ?? []) {
        if (target === f.path || !known.has(target)) continue;
        (importedBy[target] ||= []);
        if (!importedBy[target].includes(f.path)) importedBy[target].push(f.path);
      }
    }

    lines.push(L("## File relationships", "## العلاقات بين الملفات"));
    for (const f of analysis.files) {
      const deps = (analysis.graph[f.path] ?? []).filter(p => p !== f.path && known.has(p));
      const usedBy = importedBy[f.path] || [];
      if (deps.length === 0 && usedBy.length === 0) continue;

      let line = `- \`${f.path}\``;
      if (deps.length > 0) line += ` → ${deps.map(d => `\`${d}\``).join("، ")}`;
      if (usedBy.length > 0) line += L(` ← used by: ${usedBy.map(u => `\`${u}\``).join(", ")}`, ` ← يستخدمه: ${usedBy.map(u => `\`${u}\``).join("، ")}`);
      lines.push(line);
    }
    lines.push("");
  }

  // Entry points — heuristic (import in-degree, server signatures, index.html),
  // labelled as such like IPC below; written as bare facts they read as an
  // identity the analyzer never established (#1094).
  if (analysis.entryPoints.length > 0) {
    lines.push(L("## Entry points", "## نقاط الدخول"), INFERENCE_NOTE());
    for (const ep of analysis.entryPoints) {
      lines.push(`- \`${ep}\``);
    }
    lines.push("");
  }

  // API Routes
  if (analysis.apiRoutes.length > 0) {
    lines.push(L("## APIs", "## الـ APIs"));
    // Group by method
    const byMethod: Record<string, { path: string; file: string }[]> = {};
    for (const r of analysis.apiRoutes) {
      if (!byMethod[r.method]) byMethod[r.method] = [];
      byMethod[r.method].push(r);
    }
    for (const [method, routes] of Object.entries(byMethod)) {
      for (const r of routes) {
        lines.push(`- **${method}** \`${r.path}\` ← \`${r.file}\``);
      }
    }
    lines.push("");
  }

  // Data flow (only if we can confidently detect it)
  const hasServer = analysis.patterns.includes("HTTP Server");
  const hasWS = analysis.patterns.includes("WebSocket");
  const hasDB = analysis.patterns.includes("Database");
  const hasFileIO = analysis.patterns.includes("File I/O");
  const hasHooks = analysis.apiRoutes.some(r => r.path.includes("hook"));
  const hasClient = analysis.files.some(f => f.context === "client");

  if (hasServer) {
    lines.push(L("## Data flow", "## تدفق البيانات"));
    lines.push("```");
    if (hasHooks && hasWS) {
      lines.push("Hooks → API → data.json → WebSocket → Dashboard");
    } else if (hasDB && hasWS && hasClient) {
      lines.push("Client → API → Database → WebSocket → Client");
    } else if (hasDB && hasClient) {
      lines.push("Client → API → Database → Response → Client");
    } else if (hasFileIO && hasWS) {
      lines.push("Input → API → Files → WebSocket → Client");
    } else if (hasClient) {
      lines.push("Client → API → Server → Response → Client");
    } else {
      lines.push("Request → API → Process → Response");
    }
    lines.push("```");
    lines.push("");
  }

  // Threads
  if (analysis.threads.length > 0) {
    lines.push(L("## Threads", "## الخيوط (Threads)"));
    for (let i = 0; i < analysis.threads.length; i++) {
      const t = analysis.threads[i];
      lines.push(`- **Thread ${i + 1}**: ${t.purpose} ← \`${t.file}\``);
    }
    lines.push("");
  }

  // IPC Messages
  if (analysis.ipcMessages.length > 0) {
    lines.push("## IPC Protocol", INFERENCE_NOTE(L(
      "a list of likely candidates, not a confirmed protocol inventory",
      "قائمة مرشّحات محتملة، لا حصرًا مؤكَّدًا للبروتوكول"))); // heuristic harvest, never authoritative
    const jsToNative = analysis.ipcMessages.filter(m => m.direction === "js→native");
    const nativeToJs = analysis.ipcMessages.filter(m => m.direction === "native→js");
    if (jsToNative.length > 0) {
      lines.push("**JS → Native:**");
      for (const m of jsToNative) lines.push(`- \`${m.name}\` ← \`${m.file}\``);
    }
    if (nativeToJs.length > 0) {
      if (jsToNative.length > 0) lines.push("");
      lines.push("**Native → JS:**");
      for (const m of nativeToJs) lines.push(`- \`${m.name}\` ← \`${m.file}\``);
    }
    lines.push("");
  }

  // Data Types (structs, enums, interfaces)
  if (analysis.dataTypes.length > 0) {
    lines.push(L("## Data types", "## أنواع البيانات"));
    for (const dt of analysis.dataTypes) {
      const fieldsStr = dt.fields.slice(0, 8).join(", ") + (dt.fields.length > 8 ? ` ... (+${dt.fields.length - 8})` : "");
      lines.push(`- **${dt.name}** (${dt.kind}) — ${fieldsStr} ← \`${dt.file}\``);
    }
    lines.push("");
  }

  // Security — text signatures over the comment-stripped code (#1076); still
  // inference, and labelled so (#1094).
  if (analysis.security.length > 0) {
    lines.push(L("## Security", "## الأمان"), INFERENCE_NOTE());
    // Deduplicate by type
    const seen = new Set<string>();
    for (const s of analysis.security) {
      if (seen.has(s.type)) continue;
      seen.add(s.type);
      const locations = analysis.security.filter(x => x.type === s.type).map(x => `\`${x.location}\``);
      lines.push(`- **${s.type}** — ${locations.join("، ")}`);
    }
    lines.push("");
  }

  // File types
  const exts = Object.entries(project.files).sort((a, b) => b[1] - a[1]);
  if (exts.length > 0) {
    lines.push(L("## File types", "## أنواع الملفات"));
    for (const [ext, count] of exts) lines.push(`- \`.${ext}\` ${count}`);
    lines.push("");
  }

  // Directories the walk did not reach (depth cap, #1078) — stated, not silent.
  if (analysis.skippedDirs.length > 0) {
    lines.push(L("## Not analyzed", "## لم يُحلَّل"));
    lines.push(L(
      `> ${analysis.skippedDirs.length} director${analysis.skippedDirs.length === 1 ? "y" : "ies"} below the walk depth cap: ${analysis.skippedDirs.slice(0, 5).map(d => `\`${d}\``).join(", ")}${analysis.skippedDirs.length > 5 ? " …" : ""}`,
      `> ${analysis.skippedDirs.length} مجلد تحت سقف عمق المسح: ${analysis.skippedDirs.slice(0, 5).map(d => `\`${d}\``).join("، ")}${analysis.skippedDirs.length > 5 ? " …" : ""}`));
    lines.push("");
  }

  const body = lines.join("\n");
  await Bun.write(stackFile, body + stackTrailer(body));
}
