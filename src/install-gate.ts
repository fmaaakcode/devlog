// Install-gate decision logic — the pure half of pre-install-hook.js (the
// PreToolUse gate that turns `-(ask:lib)` from optional discipline into
// structural enforcement). The hook intercepts package-add commands BEFORE they
// run: a blind install (no pinned version) is blocked with the advisor's exact
// pick in the block message, a pinned install that disagrees with the advisor
// gets a one-time advisory block (re-issuing the same command passes — pinning
// is deliberate, possibly the USER's explicit order, and must stay possible).
// Split like dep-check/osv: parsing + verdict here (unit-tested, no I/O); the
// hook script owns stdin/ack-files/fetch and stays a thin shell.

export interface InstallPkg {
  name: string;
  /** "" = blind install (no version, or a floating dist-tag like @latest). */
  version: string;
  eco: "npm" | "pypi" | "crates";
}

// Floating dist-tags install "whatever is newest right now" — that's a blind
// install wearing an @, not a pin.
const FLOATING_TAGS = new Set(["latest", "next", "canary", "beta", "alpha", "rc", "nightly"]);

// Flags that consume the NEXT token as their value — that token must not be
// mistaken for a package name (`cargo add serde --features derive`).
const VALUE_FLAGS = new Set([
  "--features", "-F", "--registry", "--package", "-p", "--manifest-path", "--rename",
  "--target", "--profile", "--git", "--branch", "--tag", "--rev", "--path",      // cargo
  "--filter", "--cwd", "--workspace", "-w", "--prefix", "--dir",                  // npm family
  "-r", "--requirement", "-i", "--index-url", "--extra-index-url",
  "-c", "--constraint", "-t", "-e", "--editable", "--python",                     // pip/uv
]);

// One matcher per package manager family → the ecosystem its names live in.
const MANAGERS: Array<{ re: RegExp; eco: InstallPkg["eco"] }> = [
  { re: /(?:^|\s)(?:bun|pnpm|yarn)\s+add\s+(.+)$/, eco: "npm" },
  { re: /(?:^|\s)npm\s+(?:install|i|add)\s+(.+)$/, eco: "npm" },
  { re: /(?:^|\s)cargo\s+add\s+(.+)$/, eco: "crates" },
  { re: /(?:^|\s)(?:pip3?|python3?\s+-m\s+pip)\s+install\s+(.+)$/, eco: "pypi" },
  { re: /(?:^|\s)uv\s+(?:add|pip\s+install)\s+(.+)$/, eco: "pypi" },
];

// A token that is clearly not a registry package: local paths, URLs, git refs,
// tarballs, workspace/link protocols.
function isNonRegistryToken(tok: string): boolean {
  return /^(?:\.|\/|~|[A-Za-z]:[\\/])/.test(tok)
    || tok.includes("://") || /^(?:git\+|file:|link:|workspace:)/.test(tok)
    || /\.(?:tgz|tar\.gz|whl)$/.test(tok);
}

/** Registry packages a shell command would install, across compound commands
 *  (`cd x && bun add y`). Empty array = not an install command / nothing named
 *  (a bare `bun install` reinstall never gates). Capped at 8 like the advisor. */
export function parseInstallCommands(cmd: string): InstallPkg[] {
  const out: InstallPkg[] = [];
  const seen = new Set<string>();
  for (const segment of String(cmd || "").split(/&&|\|\||;|\|/)) {
    for (const { re, eco } of MANAGERS) {
      const m = segment.match(re);
      if (!m) continue;
      let skipNext = false;
      for (const rawTok of m[1].trim().split(/\s+/)) {
        if (out.length >= 8) return out;
        if (skipNext) { skipNext = false; continue; }
        const tok = rawTok.replace(/^["']+|["']+$/g, ""); // shell quoting is not part of the name
        if (rawTok.startsWith("-")) { skipNext = VALUE_FLAGS.has(rawTok); continue; }
        if (!tok || isNonRegistryToken(tok)) continue;
        const pkg = eco === "pypi" ? parsePipToken(tok) : parseAtToken(tok, eco);
        if (pkg && !seen.has(`${pkg.eco}:${pkg.name}`)) {
          seen.add(`${pkg.eco}:${pkg.name}`);
          out.push(pkg);
        }
      }
    }
  }
  return out;
}

// npm / cargo style: `name@version`, scoped `@scope/name@version`.
function parseAtToken(tok: string, eco: InstallPkg["eco"]): InstallPkg | null {
  const at = tok.indexOf("@", 1); // index 0 = npm scope, never a version split
  let name = tok;
  let version = "";
  if (at > 0) {
    name = tok.slice(0, at);
    version = tok.slice(at + 1);
  }
  if (!/^[@A-Za-z0-9][@A-Za-z0-9._/-]*$/.test(name)) return null;
  if (FLOATING_TAGS.has(version.toLowerCase())) version = "";
  return { name, version, eco };
}

// pip style: `name==1.2`, `name>=2`, extras `name[extra]==1.2`. Any explicit
// specifier counts as a deliberate pin; extras are stripped from the name.
function parsePipToken(tok: string): InstallPkg | null {
  const m = tok.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?(?:(===|==|>=|<=|~=|!=|>|<)(.+))?$/);
  if (!m) return null;
  return { name: m[1], version: m[3] ? (m[2] === "==" || m[2] === "===" ? m[3] : m[2] + m[3]) : "", eco: "pypi" };
}

// ── Verdict ──────────────────────────────────────────────────────────────────

/** The advisor response item shape the gate consumes (loose — network JSON). */
export interface GateAdvice {
  name: string;
  verdict: string;
  suggest?: string;
  suggestAgeDays?: number | null;
  latest?: string;
  latestAgeDays?: number | null;
  installCmd?: string;
  vulnNote?: string;
}

export interface GateDecision {
  /** Blind installs the gate refuses — each line carries the advisor's pick. */
  blocks: string[];
  /** Pinned installs that disagree with the advisor — advisory, block-once. */
  warns: string[];
}

const eq = (a: string, b: string) => a.replace(/^[\^~>=<\s]+/, "") === b.replace(/^[\^~>=<\s]+/, "");

export function decideGate(pkgs: InstallPkg[], advice: GateAdvice[], lang: "ar" | "en" = "en"): GateDecision {
  const L = (en: string, ar: string) => (lang === "ar" ? ar : en);
  const byName = new Map(advice.map(a => [a.name, a]));
  const blocks: string[] = [];
  const warns: string[] = [];
  for (const pkg of pkgs) {
    const a = byName.get(pkg.name);
    if (!a) continue;
    const age = typeof a.suggestAgeDays === "number" ? a.suggestAgeDays : null;
    if (!pkg.version) {
      // Blind install: block whenever the advisor has something to say. A name
      // it can't resolve (not-found / unsupported-eco / invalid) passes — the
      // gate must never hold private-registry or workspace names hostage.
      if (a.verdict === "ok" || a.verdict === "ok-unverified") {
        const cert = a.verdict === "ok"
          ? L("OSV clean", "نظيفة OSV")
          : L("⚠ OSV did not answer — maturity only", "⚠ لم يُجب OSV — نضج فقط");
        blocks.push(`⛔ ${pkg.name}: ${L(`blind install (no version) — the advisor picks ${a.suggest}${age != null ? ` (${age}d old, ` : " ("}${cert}):`, `تركيب أعمى بلا نسخة — المستشار يختار ${a.suggest}${age != null ? ` (عمرها ${age} يوم، ` : " ("}${cert}):`)} ${a.installCmd || `${pkg.name}@${a.suggest}`}`);
      } else if (a.verdict === "no-clean") {
        blocks.push(`⛔ ${pkg.name}: ${L(`no OSV-clean version among the matured releases (${a.vulnNote || ""}) — do not install blind; report to the user.`, `لا نسخة نظيفة ضمن الناضجات (${a.vulnNote || ""}) — لا تركيب أعمى؛ أبلغ المستخدم.`)}`);
      } else if (a.verdict === "no-mature") {
        blocks.push(`⛔ ${pkg.name}: ${L(`nothing matured yet (newest ${a.latest} is ${a.latestAgeDays}d old) — pin a version explicitly if this is a conscious call.`, `لا نسخة ناضجة بعد (الأحدث ${a.latest} عمرها ${a.latestAgeDays} يوم) — ثبّت نسخة صراحةً إن كان قراراً واعياً.`)}`);
      }
    } else if (a.verdict === "ok" && a.suggest && !eq(pkg.version, a.suggest)) {
      warns.push(`⚠ ${pkg.name}@${pkg.version}: ${L(`the advisor recommends ${a.suggest} (matured, OSV clean). If this pin is deliberate, re-issue the same command — it will pass.`, `المستشار يوصي بـ${a.suggest} (ناضجة، نظيفة OSV). إن كان تثبيتك مقصوداً أعد الأمر نفسه — سيمرّ.`)}`);
    }
  }
  return { blocks, warns };
}
