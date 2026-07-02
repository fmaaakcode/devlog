/**
 * Closure check — given the tags emitted in a single response + the project's
 * still-open items (todos, bugs, security, plan steps), detect `-(built)` /
 * `-(refactor)` content that fuzzy-matches an open item without a matching
 * `-(done) #N` / `-(bug fix) #N` / `-(security fix) #N` closure.
 *
 * Pure: no I/O, no globals. parse-tags.js wraps this around the live data.
 */

const STOPWORDS = new Set([
  // ar
  "في", "من", "إلى", "على", "عن", "مع", "بعد", "قبل", "هذا", "هذه", "ذلك", "كل",
  "ما", "لا", "لم", "بدون", "بين", "عند", "حسب", "كان", "صار", "يصير", "أن", "إن",
  // en
  "the", "a", "an", "of", "in", "on", "for", "to", "and", "or", "with", "without",
  "is", "be", "was", "are", "by", "as", "at", "from", "this", "that", "into",
]);

function tokenize(s: string): Set<string> {
  if (!s) return new Set();
  // Strip code spans, version numbers, file paths, common noise.
  const cleaned = s
    .replace(/`[^`]*`/g, " ")
    .replace(/\bv?\d+(\.\d+){1,3}\b/g, " ")
    .replace(/[/\\]/g, " ")
    .replace(/[#`*_<>(){}[\],.;:!?"'—–-]/g, " ")
    .toLowerCase();
  const toks = cleaned.split(/\s+/).filter(t =>
    t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t)
  );
  return new Set(toks);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface ResponseTag {
  tag: string;
  content: string;
}

export interface OpenItem {
  num: number;
  tag: string;        // "todo" | "bug found" | "security" | "security:own" | "security:dep" | "plan-step"
  content: string;
  planTitle?: string;
}

export interface ClosureMatch {
  built: string;        // the built/refactor content
  item: OpenItem;
  confidence: number;
  strength: "strong" | "weak";
}

export interface ClosureCheckResult {
  unclosed: ClosureMatch[];   // strong matches without closure
  warnings: ClosureMatch[];   // weak matches without closure
  closuresEmitted: number[];  // #N references found in this response's closures
}

const STRONG_THRESHOLD = 0.5;
const WEAK_THRESHOLD = 0.25;
const MIN_SHARED_TOKENS = 3;

const CLOSURE_TAGS = new Set(["done", "dropped", "bug fix", "security fix"]);
const WORK_TAGS = new Set(["built", "refactor"]);

function extractClosureNums(entries: ResponseTag[]): number[] {
  const nums: number[] = [];
  for (const e of entries) {
    if (!CLOSURE_TAGS.has(e.tag)) continue;
    // Each closure entry typically references one #N
    for (const m of (e.content || "").matchAll(/#(\d+)/g)) {
      nums.push(parseInt(m[1], 10));
    }
  }
  return nums;
}

function countSharedTokens(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export function checkClosures(
  responseTags: ResponseTag[],
  openItems: OpenItem[],
): ClosureCheckResult {
  const closuresEmitted = extractClosureNums(responseTags);
  const closedSet = new Set(closuresEmitted);

  const works = responseTags.filter(t => WORK_TAGS.has(t.tag));
  const unclosed: ClosureMatch[] = [];
  const warnings: ClosureMatch[] = [];

  // Pre-tokenize items
  const itemTokens = openItems.map(it => ({ it, toks: tokenize(it.content) }));

  for (const w of works) {
    const wToks = tokenize(w.content);
    if (wToks.size < 2) continue;

    let best: { item: OpenItem; conf: number; shared: number } | null = null;
    for (const { it, toks } of itemTokens) {
      if (closedSet.has(it.num)) continue;  // already closed in this response
      const shared = countSharedTokens(wToks, toks);
      if (shared < MIN_SHARED_TOKENS) continue;
      const conf = jaccard(wToks, toks);
      if (!best || conf > best.conf) best = { item: it, conf, shared };
    }
    if (!best) continue;
    if (best.conf >= STRONG_THRESHOLD) {
      unclosed.push({ built: w.content, item: best.item, confidence: best.conf, strength: "strong" });
    } else if (best.conf >= WEAK_THRESHOLD) {
      warnings.push({ built: w.content, item: best.item, confidence: best.conf, strength: "weak" });
    }
  }

  return { unclosed, warnings, closuresEmitted };
}

export function formatClosureMessage(r: ClosureCheckResult): string {
  if (!r.unclosed.length && !r.warnings.length) return "";
  const lines: string[] = [];
  if (r.unclosed.length) {
    lines.push(`✗ ${r.unclosed.length} عمل بدون إقفال (تطابق قوي):`);
    for (const m of r.unclosed) {
      lines.push(`  • -(${m.item.tag === "plan-step" ? "خطوة" : m.item.tag}) #${m.item.num}: ${m.item.content.slice(0, 80)}`);
      lines.push(`    يطابق: -(built) ${m.built.slice(0, 80)}`);
      lines.push(`    أضف: -(${closureTagFor(m.item.tag)}) #${m.item.num}`);
    }
  }
  if (r.warnings.length) {
    lines.push(`⚠ ${r.warnings.length} عمل قد يحتاج إقفال (تطابق ضعيف — تجاهل لو غير ذي صلة):`);
    for (const m of r.warnings) {
      lines.push(`  • #${m.item.num} ${m.item.content.slice(0, 60)} ↔ ${m.built.slice(0, 60)}`);
    }
  }
  return lines.join("\n");
}

function closureTagFor(itemTag: string): string {
  if (itemTag === "todo" || itemTag === "plan-step") return "done";
  if (itemTag === "bug found") return "bug fix";
  if (itemTag.startsWith("security")) return "security fix";
  return "done";
}
