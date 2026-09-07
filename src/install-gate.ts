// Install-gate decision logic — the pure half of pre-install-hook.js (the
// PreToolUse gate that turns `-(ask:lib)` from optional discipline into
// structural enforcement). The hook intercepts package-add commands BEFORE they
// run: a blind install (no pinned version) is blocked with the advisor's exact
// pick in the block message, a pinned install that disagrees with the advisor
// gets a one-time advisory block (re-issuing the same command passes — pinning
// is deliberate, possibly the USER's explicit order, and must stay possible).
// Split like dep-check/osv: parsing + verdict here (unit-tested, no I/O); the
// hook script owns stdin/ack-files/fetch and stays a thin shell.
//
// Parsing runs over shellSegments (src/shell-write.ts — import-free, so the
// hook's load stays light): verbs and flags are judged on the literal-stripped
// words, names are read from the words as typed. That is what makes `bun add \`
// + newline + `react` one command (#1036), `echo "bun add x"` / a heredoc that
// mentions `npm install` no command at all (#1172), and `bun add "react"` still
// name react.

import { isBlankTok, shellSegments, type ShellTok } from "./shell-write";

export interface InstallPkg {
  name: string;
  /** "" = blind install (no version, or a floating dist-tag like @latest). */
  version: string;
  eco: "npm" | "pypi" | "crates";
  /**
   * Set when the package arrived via a scaffold command (#606): the original
   * invocation minus version (`bun create astro`), so block messages can show
   * the re-issue in the shape the user typed — `bun add create-astro@X` would
   * be wrong guidance for a `bun create` flow.
   */
  scaffoldCmd?: string;
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

// ── Scaffolders (#606) ───────────────────────────────────────────────────────
// `bun create astro@5` installed the old generation with zero gating in the
// wild: scaffold commands both pick a framework version and install it, yet
// none of them says `add`. npm-family only, by the ecosystems' nature — cargo
// new/init and uv init scaffold zero third-party deps; those arrive later via
// the gated add/install commands, or via manifest edits only the scan backstop
// sees. Unlike add commands, a scaffold takes exactly ONE package — everything
// after it is template arguments (`bun create astro@5 . --template minimal`),
// so parsing stops at the first name.
const SCAFFOLDERS: Array<{ re: RegExp; literal: boolean }> = [
  // The name resolves to the npm `create-` package (npm-init rules): astro →
  // create-astro, @scope → @scope/create, @scope/x → @scope/create-x.
  { re: /(?:^|\s)((?:bun|npm|pnpm|yarn)\s+create|npm\s+init)\s+(.+)$/, literal: false },
  // Direct executors run the named package as-is — only `create-*` names gate
  // (`npx prettier` must never gate).
  { re: /(?:^|\s)(npx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(.+)$/, literal: true },
];

const isCreatePackage = (name: string) => /^(?:@[^/]+\/)?create-/.test(name);

// npm-init name resolution. An unscoped name with a slash is a GitHub-shorthand
// template (`bun create user/repo`), not a registry package → null.
function mapCreateName(name: string): string | null {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash < 0) return `${name}/create`;
    const rest = name.slice(slash + 1);
    return rest.startsWith("create-") ? name : `${name.slice(0, slash)}/create-${rest}`;
  }
  if (name.includes("/")) return null;
  return name.startsWith("create-") ? name : `create-${name}`;
}

// The words a regex group (anchored at `$`) covered, paired stripped/raw: the
// group was matched on the stripped sentence, so its word count selects the
// same trailing words of the segment.
function tailWords(seg: ShellTok[], group: string): ShellTok[] {
  const n = group.trim() ? group.trim().split(/\s+/).length : 0;
  return n ? seg.slice(seg.length - n) : [];
}
const sentence = (seg: ShellTok[]) => seg.map(t => t.stripped).join(" ");
const flagOf = (t: ShellTok) => t.stripped;                                   // flags are never quoted
const nameOf = (t: ShellTok) => t.raw.replace(/^["']+|["']+$/g, "");           // shell quoting is not part of the name

function parseScaffoldSegment(seg: ShellTok[]): InstallPkg | null {
  const text = sentence(seg);
  for (const { re, literal } of SCAFFOLDERS) {
    const m = text.match(re);
    if (!m) continue;
    let skipNext = false;
    for (const w of tailWords(seg, m[2])) {
      if (isBlankTok(w)) continue;          // comment / heredoc content
      const flag = flagOf(w);
      if (flag === "--") break; // forwarded template args, never the package
      if (skipNext) { skipNext = false; continue; }
      if (flag.startsWith("-")) { skipNext = VALUE_FLAGS.has(flag); continue; }
      const tok = nameOf(w);
      if (!tok || isNonRegistryToken(tok)) return null; // path/URL template — not a registry scaffold
      const parsed = parseAtToken(tok, "npm");
      if (!parsed) return null;
      const name = literal
        ? (isCreatePackage(parsed.name) ? parsed.name : null)
        : mapCreateName(parsed.name);
      if (!name) return null;
      const verb = m[1].replace(/\s+/g, " ");
      return { ...parsed, name, scaffoldCmd: `${verb} ${parsed.name}` };
    }
    return null; // scaffold verb with no package token (`npm init -y`)
  }
  return null;
}

// A token that is clearly not a registry package: local paths, URLs, git refs,
// tarballs, workspace/link protocols.
function isNonRegistryToken(tok: string): boolean {
  return /^(?:\.|\/|~|[A-Za-z]:[\\/])/.test(tok)
    || tok.includes("://") || /^(?:git\+|file:|link:|workspace:)/.test(tok)
    || /\.(?:tgz|tar\.gz|whl)$/.test(tok);
}

/** Registry packages a shell command would install, across compound commands
 *  (`cd x && bun add y`). Empty array = not an install command / nothing named
 *  (a bare `bun install` reinstall never gates).
 *
 *  Every named package is returned — no cap. The old `>= 8` cut (#1037 /
 *  F-3.36) silently dropped the ninth package from the gate, the advisor call
 *  and every message; the hook now asks the advisor in batches instead. */
export function parseInstallCommands(cmd: string): InstallPkg[] {
  const out: InstallPkg[] = [];
  const seen = new Set<string>();
  // Segments come from the shell tokenizer: `&&`/`||`/`;`/`|`/newline split
  // (#762 — a `bun add x` line that isn't the LAST line used to escape the `$`
  // anchor), `\`+newline joined into one command (#1036), quoted strings,
  // comments and heredoc bodies blanked (#1172).
  for (const seg of shellSegments(cmd)) {
    const text = sentence(seg);
    for (const { re, eco } of MANAGERS) {
      const m = text.match(re);
      if (!m) continue;
      let skipNext = false;
      for (const w of tailWords(seg, m[1])) {
        if (isBlankTok(w)) continue;        // comment / heredoc content
        if (skipNext) { skipNext = false; continue; }
        const flag = flagOf(w);
        if (flag.startsWith("-")) { skipNext = VALUE_FLAGS.has(flag); continue; }
        const tok = nameOf(w);
        if (!tok || isNonRegistryToken(tok)) continue;
        const pkg = eco === "pypi" ? parsePipToken(tok) : parseAtToken(tok, eco);
        if (pkg && !seen.has(`${pkg.eco}:${pkg.name}`)) {
          seen.add(`${pkg.eco}:${pkg.name}`);
          out.push(pkg);
        }
      }
    }
    const scaffold = parseScaffoldSegment(seg);
    if (scaffold && !seen.has(`${scaffold.eco}:${scaffold.name}`)) {
      seen.add(`${scaffold.eco}:${scaffold.name}`);
      out.push(scaffold);
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
  notices?: number;
  noticeNote?: string;
  deprecated?: boolean;
  /** OSV verdict for the exact pinned version, when the advisor checked it (#630). */
  pin?: { version: string; vulns: number; severity?: string; message?: string; fixVersion?: string };
  /** Registry age of the pinned version, when listed (#631). */
  pinAgeDays?: number | null;
}

// Parity with dep-check's RULE_MIN_AGE_DAYS. Deliberately NOT imported: this
// module must stay import-free so the PreToolUse hook's load stays feather-light
// (dep-check drags the registry fetch machinery in).
const MIN_AGE_DAYS = 7;

// Verdicts where the advisor could not resolve the name at all — fail-open by
// default (private registries / workspace names must stay usable), fail-closed
// under DEVLOG_INSTALL_GATE=strict.
const UNRESOLVED_VERDICTS = new Set(["not-found", "unsupported-eco", "invalid-name", "need-full-path"]);

export interface GateDecision {
  /** Blind installs the gate refuses — each line carries the advisor's pick. */
  blocks: string[];
  /** Pinned installs that disagree with the advisor — advisory, block-once. */
  warns: string[];
  /** Pinned packages whose exact version is KNOWN vulnerable (#630). The hook
   *  stores these in the ack file: if the block is then consciously overridden
   *  (verbatim re-issue), it opens a security tag immediately instead of
   *  waiting for the next scan sweep. `text` is in the scanner's tag format so
   *  the sweep's own claim dedupes against it. */
  vulnPins: Array<{ eco: string; name: string; version: string; text: string }>;
  /** How many of `blocks` are HARD — blind / no-clean / no-mature installs.
   *  A hard block is never passed on re-issue (#1047 / F-3.82): the way
   *  through is a pinned version, which is a different command. The hook
   *  writes an override ack only when this is 0 (pins that disagree, known-
   *  vulnerable pins, strict-mode unresolved names — all deliberate choices). */
  hardBlocks: number;
}

const eq = (a: string, b: string) => a.replace(/^[\^~>=<\s]+/, "") === b.replace(/^[\^~>=<\s]+/, "");

export function decideGate(pkgs: InstallPkg[], advice: GateAdvice[], lang: "ar" | "en" = "en", strict = false): GateDecision {
  const L = (en: string, ar: string) => (lang === "ar" ? ar : en);
  const byName = new Map(advice.map(a => [a.name, a]));
  const blocks: string[] = [];
  const warns: string[] = [];
  const vulnPins: GateDecision["vulnPins"] = [];
  let hardBlocks = 0;
  for (const pkg of pkgs) {
    const a = byName.get(pkg.name);
    if (!a) {
      if (strict) blocks.push(`⛔ ${pkg.name}: ${L(
        "strict mode — the advisor returned no answer for this name, so nothing was verified.",
        "الوضع الصارم — المستشار لم يُرجع جواباً عن هذا الاسم، فلم يُتحقق من شيء.")}`);
      continue;
    }
    // The user switched registry lookups off (DEVLOG_REGISTRY_CHECK_DISABLED):
    // nothing was checked, and that is their explicit choice — the gate has no
    // standing to block or nag, strict or not. Pass silently (the hook log
    // records it); a warn here would interrupt every install they run.
    if (a.verdict === "registry-disabled") continue;
    if (UNRESOLVED_VERDICTS.has(a.verdict)) {
      if (strict) blocks.push(`⛔ ${pkg.name}: ${L(
        `strict mode — could not verify (${a.verdict}); if this is a private/internal package, re-issue the same command verbatim to override.`,
        `الوضع الصارم — تعذّر التحقق (${a.verdict})؛ إن كانت حزمة خاصة/داخلية أعد الأمر نفسه حرفياً للتجاوز.`)}`);
      continue;
    }
    const age = typeof a.suggestAgeDays === "number" ? a.suggestAgeDays : null;
    const before = blocks.length;
    // F-3.43: an `ok` verdict with no `suggest` (or `no-mature` with no `latest`)
    // printed «picks undefined … x@undefined» verbatim. The advisor is expected
    // to fill them; when it does not, say so instead of leaking the hole.
    const suggest = a.suggest || L("(no version given)", "(بلا نسخة محددة)");
    const latest = a.latest || "?";
    const latestAge = typeof a.latestAgeDays === "number" ? a.latestAgeDays : "?";
    if (!pkg.version) {
      // Blind install: block whenever the advisor has something to say. A name
      // it can't resolve (not-found / unsupported-eco / invalid) passes — the
      // gate must never hold private-registry or workspace names hostage.
      if (a.verdict === "ok" || a.verdict === "ok-unverified") {
        const cert = a.verdict !== "ok"
          ? L("⚠ OSV did not answer — maturity only", "⚠ لم يُجب OSV — نضج فقط")
          : a.deprecated
            ? L("⛔ deprecated by its registry — no CVE, but not a clean pick", "⛔ مهجورة في سجلّها — بلا CVE لكنها ليست اختيارًا نظيفًا")
            : a.notices
              ? L(`⚠ no CVE, OSV notice: ${a.noticeNote || "maintenance"}`, `⚠ بلا CVE، إشعار OSV: ${a.noticeNote || "صيانة"}`)
              : L("OSV clean", "نظيفة OSV");
        blocks.push(`⛔ ${pkg.name}: ${L(`blind install (no version) — the advisor picks ${suggest}${age != null ? ` (${age}d old, ` : " ("}${cert}):`, `تركيب أعمى بلا نسخة — المستشار يختار ${suggest}${age != null ? ` (عمرها ${age} يوم، ` : " ("}${cert}):`)} ${pkg.scaffoldCmd ? `${pkg.scaffoldCmd}@${suggest}` : (a.installCmd || `${pkg.name}@${suggest}`)}`);
      } else if (a.verdict === "no-clean") {
        blocks.push(`⛔ ${pkg.name}: ${L(`no OSV-clean version among the matured releases (${a.vulnNote || ""}) — do not install blind; report to the user.`, `لا نسخة نظيفة ضمن الناضجات (${a.vulnNote || ""}) — لا تركيب أعمى؛ أبلغ المستخدم.`)}`);
      } else if (a.verdict === "no-mature") {
        blocks.push(`⛔ ${pkg.name}: ${L(`nothing matured yet (newest ${latest} is ${latestAge}d old) — pin a version explicitly if this is a conscious call.`, `لا نسخة ناضجة بعد (الأحدث ${latest} عمرها ${latestAge} يوم) — ثبّت نسخة صراحةً إن كان قراراً واعياً.`)}`);
      }
      hardBlocks += blocks.length - before;   // blind-install blocks are never overridable by re-issue
    } else if (a.pin && a.pin.vulns > 0) {
      // The pinned version ITSELF is known-vulnerable (#630) — say so
      // explicitly instead of only hinting that the advisor prefers another.
      // Still overridable (the pin may be the user's explicit order), but an
      // override opens a security item on the spot, so the risk is on record.
      const detail = a.pin.message || `${a.pin.vulns} vuln(s)${a.pin.severity && a.pin.severity !== "none" ? ` (${a.pin.severity})` : ""}`;
      blocks.push(`⛔ ${pkg.name}@${pkg.version}: ${L(
        `this exact version is vulnerable — ${detail}${a.suggest ? `; the advisor picks ${a.suggest}` : ""}. Overriding records an open security item immediately.`,
        `هذه النسخة نفسها مثغورة — ${detail}${a.suggest ? `؛ المستشار يختار ${a.suggest}` : ""}. تجاوزُها يفتح بند أمان مفتوحاً فوراً.`)}`);
      vulnPins.push({ eco: pkg.eco, name: pkg.name, version: pkg.version, text: `${pkg.name}@${pkg.version} — ${detail}`.slice(0, 100) });
    } else if (a.verdict === "ok" && a.suggest && !eq(pkg.version, a.suggest)) {
      // A pin younger than the maturity window is the supply-chain risk window
      // itself (#631) — say the age out loud; "differs from the advisor" alone
      // undersells a 2-day-old release with zero advisories filed YET.
      const young = typeof a.pinAgeDays === "number" && a.pinAgeDays < MIN_AGE_DAYS;
      const ageNote = young
        ? L(` Your pin is ${a.pinAgeDays}d old — inside the ${MIN_AGE_DAYS}-day maturity window, the supply-chain risk zone (no advisories filed yet ≠ clean).`,
            ` عمر نسختك ${a.pinAgeDays} يوم — داخل نافذة النضج (${MIN_AGE_DAYS} أيام)، منطقة خطر السبلاي تشين (غياب البلاغات حتى الآن لا يعني النظافة).`)
        : "";
      warns.push(`⚠ ${pkg.name}@${pkg.version}: ${L(`the advisor recommends ${a.suggest} (matured, OSV clean).${ageNote} If this pin is deliberate, re-issue the same command — it will pass.`, `المستشار يوصي بـ${a.suggest} (ناضجة، نظيفة OSV).${ageNote} إن كان تثبيتك مقصوداً أعد الأمر نفسه — سيمرّ.`)}`);
    } else if (strict && a.verdict === "ok-unverified") {
      // Pinned + OSV silent: the default gate lets this through quietly (the
      // pin may even equal the maturity pick) — but "OSV did not answer" IS a
      // verification failure, which is exactly what strict fail-closes on.
      blocks.push(`⛔ ${pkg.name}@${pkg.version}: ${L(
        "strict mode — OSV did not answer, this version carries no security verdict; retry, or re-issue the same command verbatim to override.",
        "الوضع الصارم — لم يُجب OSV، هذه النسخة بلا حكم أمني؛ أعد المحاولة أو أعد الأمر نفسه حرفياً للتجاوز.")}`);
    }
  }
  return { blocks, warns, vulnPins, hardBlocks };
}
