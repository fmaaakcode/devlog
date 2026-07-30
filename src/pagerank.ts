// PageRank over the two analysis graphs, extracted from analyze.ts (R9 size
// ratchet — the heuristics engine kept its budget by shedding this cohesive
// pair). File ranks walk the import graph, function ranks walk the call graph;
// both feed the stack map's importance ordering.
import type { FileAnalysis } from "./analyze";

// PageRank for files — based on import graph
export function pageRankFiles(files: FileAnalysis[], graph: Record<string, string[]>): Record<string, number> {
  const nodes = files.map(f => f.path);
  const N = nodes.length;
  if (N === 0) return {};

  const d = 0.85; // damping factor
  const iterations = 20;

  // Build adjacency: file → files it imports (resolved)
  const outLinks: Record<string, string[]> = {};
  const inLinks: Record<string, string[]> = {};
  for (const node of nodes) { outLinks[node] = []; inLinks[node] = []; }

  // Resolve imports to targets by BASENAME (no extension), not substring. The
  // old `target.includes(normalized)` let a short import like `./data` link to
  // `metadata.ts` and `path` match `path-utils.ts`, corrupting the rank graph —
  // the same collision computeImportedBy was fixed for (R4 code-quality F2).
  const baseName = (p: string) => (p.split("/").pop() ?? "").replace(/\.\w+$/, "");
  const byBase = new Map<string, string[]>();
  for (const node of nodes) {
    const b = baseName(node);
    const arr = byBase.get(b);
    if (arr) arr.push(node); else byBase.set(b, [node]);
  }

  for (const [file, imports] of Object.entries(graph)) {
    if (!outLinks[file]) continue;
    for (const imp of imports) {
      const impBase = baseName(imp.replace(/^\.+\//, ""));
      for (const target of byBase.get(impBase) ?? []) {
        if (target === file) continue;   // ignore self-import
        outLinks[file].push(target);
        inLinks[target].push(file);
      }
    }
  }

  // Initialize ranks
  let ranks: Record<string, number> = {};
  for (const node of nodes) ranks[node] = 1 / N;

  // Iterate
  for (let i = 0; i < iterations; i++) {
    const newRanks: Record<string, number> = {};
    for (const node of nodes) {
      let sum = 0;
      for (const src of inLinks[node]) {
        const outCount = outLinks[src].length || 1;
        sum += ranks[src] / outCount;
      }
      newRanks[node] = (1 - d) / N + d * sum;
    }
    ranks = newRanks;
  }

  // Boost: entry points, main files, files with routes
  for (const f of files) {
    const fname = f.path.split("/").pop()?.replace(/\.\w+$/, "").toLowerCase() || "";
    // Main/index/app files are always important
    if (["main", "index", "app", "server", "mod"].includes(fname)) ranks[f.path] = (ranks[f.path] || 0) * 2.0;
    if (f.patterns.includes("HTTP Server") || f.imports.length > 3) ranks[f.path] = (ranks[f.path] || 0) * 1.3;
    if (f.routes.length > 0) ranks[f.path] = (ranks[f.path] || 0) * 1.2;
    if (f.exports.length > 3) ranks[f.path] = (ranks[f.path] || 0) * 1.1;
  }

  return ranks;
}

// PageRank for functions — based on call graph
export function pageRankFunctions(files: FileAnalysis[], callGraph: { caller: string; callee: string; file: string }[]): Record<string, number> {
  // Collect all function nodes as "file:name"
  const fnNodes = new Set<string>();
  for (const f of files) {
    for (const fn of f.functions) {
      fnNodes.add(`${f.path}:${fn.name}`);
    }
  }
  const nodes = [...fnNodes];
  const N = nodes.length;
  if (N === 0) return {};

  const d = 0.85;
  const iterations = 20;

  // Build links from call graph
  const inLinks: Record<string, string[]> = {};
  const outLinks: Record<string, string[]> = {};
  for (const node of nodes) { inLinks[node] = []; outLinks[node] = []; }

  // callee → declaring node keys, built once (O(functions)). The old per-edge
  // scan over every file was O(edges × files) fully synchronous — tens of
  // seconds of blocked event loop on big projects, and this runs on the
  // /api/hook hot path for new projects (R9 F1). Set dedupes a function name
  // declared twice in one file, matching the old per-file single push.
  const keysByCallee = new Map<string, Set<string>>();
  for (const f of files) {
    for (const fn of f.functions) {
      let keys = keysByCallee.get(fn.name);
      if (!keys) {
        keys = new Set();
        keysByCallee.set(fn.name, keys);
      }
      keys.add(`${f.path}:${fn.name}`);
    }
  }

  for (const edge of callGraph) {
    // caller is already "file:name"; callee is just a name — resolve via index
    const callerKey = edge.caller;
    if (!outLinks[callerKey]) continue;

    for (const targetKey of keysByCallee.get(edge.callee) ?? []) {
      outLinks[callerKey].push(targetKey);
      inLinks[targetKey].push(callerKey);
    }
  }

  // Initialize
  let ranks: Record<string, number> = {};
  for (const node of nodes) ranks[node] = 1 / N;

  // Iterate
  for (let i = 0; i < iterations; i++) {
    const newRanks: Record<string, number> = {};
    for (const node of nodes) {
      let sum = 0;
      for (const src of inLinks[node]) {
        const outCount = outLinks[src].length || 1;
        sum += ranks[src] / outCount;
      }
      newRanks[node] = (1 - d) / N + d * sum;
    }
    ranks = newRanks;
  }

  // Boost based on actual importance, not size
  for (const f of files) {
    for (const fn of f.functions) {
      const key = `${f.path}:${fn.name}`;
      if (fn.isExported) ranks[key] = (ranks[key] || 0) * 1.5;
      // Penalize small utility functions (< 8 lines)
      if (fn.lines <= 8 && !fn.isAsync) ranks[key] = (ranks[key] || 0) * 0.3;
      // Don't boost just for being big — boost for being called by many
      // (PageRank already handles this via inLinks)
    }
  }

  return ranks;
}
