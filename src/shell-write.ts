// Unified shell-write detector (audit round 10, wave 2 — root cause R2).
//
// Five consumers used to guess what a shell command wrote, each with its own
// regex over the RAW command text: the demolition gate and the untagged guard
// saw no Bash writes at all (only Write/Edit events carry a file_path), the
// verify hint counted `s/a/b/`, `/dev/null` and URLs as code paths because
// they contain a slash, missed root files because they don't, and the
// test-command classifier matched `"npm test"` inside a commit message or a
// heredoc body and then judged the command's output as a test run.
//
// Two primitives replace all of that:
//   · stripShellLiterals(cmd) — a LENGTH-PRESERVING copy where the interiors of
//     quoted strings, comments, heredoc bodies and PowerShell here-strings are
//     blanked. Any guard regex runs on this copy; offsets still map to the
//     original, so a token found here can be read back verbatim from `cmd`.
//   · shellWriteTargets(cmd) — the paths the command ACTUALLY writes: redirect
//     targets, in-place sed/perl operands, tee/cp/mv/rm/touch operands, git
//     verbs that touch the tree, formatters run in write mode, package-manager
//     manifest edits, and the write APIs of inline scripts (bun -e / python /
//     PowerShell). A target is a path because it is the OPERAND of a write
//     verb — not because it contains a slash.
//
// Direction of doubt: `opaque` is set when something wrote and the target
// cannot be named (`> $OUT`, `git merge`, `open(p,'w')` with p unresolved).
// Freshness consumers treat opaque as "code may have changed"; gate consumers
// (which need a file) fail open on it. A read stays a read: `sed -n`, `grep`,
// `cat`, `git diff` never yield a target.

export interface ShellWrites {
  /** Written paths, as typed (quotes removed, `\ ` unescaped; not normalized). */
  targets: string[];
  /** Something wrote to the tree but the destination could not be named. */
  opaque: boolean;
}

const BLANK = "·"; // non-word, non-space: keeps quoted tokens whole and \b-safe

/**
 * Blank the interiors of '…' / "…" strings, `# comments`, heredoc bodies
 * (<<EOF, <<-EOF, <<'EOF', <<"EOF") and PowerShell here-strings (@'…'@ /
 * @"…"@). Length-preserving; newlines kept; `\`+newline continuations become
 * spaces so a wrapped command reads as one logical line.
 */
export function stripShellLiterals(cmd: string): string {
  const s = cmd || "";
  const n = s.length;
  const out: string[] = new Array(n);
  const pending: { delim: string; stripTabs: boolean }[] = [];
  let i = 0;
  const blankTo = (from: number, to: number) => {
    for (let k = from; k < to; k++) out[k] = s[k] === "\n" ? "\n" : BLANK;
  };
  const consumeHeredocBodies = (from: number): number => {
    let p = from;
    for (let h = pending.shift(); h; h = pending.shift()) {
      const { delim, stripTabs } = h;
      while (p < n) {
        const eol = s.indexOf("\n", p);
        const lineEnd = eol === -1 ? n : eol;
        const line = s.slice(p, lineEnd);
        const probe = stripTabs ? line.replace(/^\t+/, "") : line;
        blankTo(p, lineEnd);
        if (eol !== -1) out[eol] = "\n";
        p = eol === -1 ? n : eol + 1;
        if (probe.trimEnd() === delim) break;
      }
    }
    return p;
  };
  while (i < n) {
    const c = s[i];
    if (c === "\n") {
      out[i] = "\n"; i++;
      if (pending.length) i = consumeHeredocBodies(i);
      continue;
    }
    if (c === "\\") {
      if (s[i + 1] === "\n") { out[i] = " "; out[i + 1] = " "; i += 2; continue; }
      if (s[i + 1] === "\r" && s[i + 2] === "\n") { out[i] = " "; out[i + 1] = " "; out[i + 2] = " "; i += 3; continue; }
      out[i] = c; if (i + 1 < n) out[i + 1] = s[i + 1]; i += 2; continue;
    }
    // PowerShell here-string: @' or @" ending the line, closed by a line starting with '@ / "@.
    if (c === "@" && (s[i + 1] === "'" || s[i + 1] === '"') && /^[ \t]*\r?\n/.test(s.slice(i + 2, i + 8))) {
      const q = s[i + 1];
      out[i] = c; out[i + 1] = q;
      const closeRe = new RegExp(`\\n${q}@`, "g");
      closeRe.lastIndex = i + 2;
      const m = closeRe.exec(s);
      const end = m ? m.index + 1 : n;
      blankTo(i + 2, end);
      if (m) { out[end] = q; out[end + 1] = "@"; i = end + 2; } else i = n;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && s[j] !== c) { if (c === '"' && s[j] === "\\") j++; j++; }
      out[i] = c;
      blankTo(i + 1, Math.min(j, n));
      if (j < n) out[j] = c;
      i = Math.min(j + 1, n);
      continue;
    }
    if (c === "#" && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
      const eol = s.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      blankTo(i, end); i = end; continue;
    }
    if (c === "<" && s[i + 1] === "<" && s[i + 2] !== "<" && s[i - 1] !== "<") {
      const m = /^<<(-?)\s*(['"]?)(\w+)\2/.exec(s.slice(i, i + 64));
      if (m) {
        pending.push({ delim: m[3], stripTabs: m[1] === "-" });
        for (let k = 0; k < m[0].length; k++) out[i + k] = s[i + k];
        i += m[0].length; continue;
      }
    }
    out[i] = c; i++;
  }
  return out.join("");
}

// ── Tokenizer ────────────────────────────────────────────────────────────────
/** One shell word: as typed (`raw`) and with literals blanked (`stripped`). */
export interface ShellTok { raw: string; stripped: string; start: number }
type Tok = ShellTok;
type Segment = Tok[];

/**
 * The command split into simple commands (at `&&`, `||`, `|`, `;`, newlines,
 * parentheses) and each into words. Judge structure on `stripped` — verbs,
 * flags, operators — and read operands from `raw`: a quoted name keeps its
 * text there while its interior is blanked here, so `bun add "react"` still
 * names react but `echo "bun add react"` names nothing (the words of the echo
 * argument are all blanks). Heredoc bodies and comments yield blank words too.
 */
export function shellSegments(cmd: string): ShellTok[][] {
  const src = cmd || "";
  return segments(src, stripShellLiterals(src));
}

/** True when a word is blanked content with no quote of its own — it came from
 *  a heredoc body or a comment, never a verb, a flag or a name. (A quoted word
 *  keeps its quotes in `stripped`, so `"react"` is NOT blank: read it from raw.) */
export const isBlankTok = (t: ShellTok): boolean => /^·+$/.test(t.stripped);

// A bare `&` ends a command (background) unless it opens `&>file`; `>&1` /
// `2>&1` keep their `&` inside the word (the scanner below never breaks there).
const SEP_RE = /^(?:&&|\|\||\|&|\||;|\n|\(|\)|&(?!>))/;
const REDIRECT_RE = /^(\d*|&)(>>|>\||>|<<<|<<|<)(&\d+|&-)?/;

function unquote(raw: string): string {
  let t = raw.trim();
  if (t.length >= 2 && ((t[0] === "'" && t.at(-1) === "'") || (t[0] === '"' && t.at(-1) === '"'))) t = t.slice(1, -1);
  else t = t.replace(/^\$'/, "").replace(/'$/, "");
  // Only escaped quotes/spaces are unescaped: a Windows path (`src\a.ts`) must
  // survive, so a lone backslash is never a shell escape here.
  return t.replace(/\\([ "'])/g, "$1").replace(/^["']|["']$/g, "");
}

function segments(cmd: string, stripped: string): Segment[] {
  const segs: Segment[] = [[]];
  let i = 0;
  const n = stripped.length;
  while (i < n) {
    const ch = stripped[i];
    if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }
    const sep = SEP_RE.exec(stripped.slice(i, i + 2));
    const cur = segs[segs.length - 1];
    if (sep) { if (cur.length) segs.push([]); i += sep[0].length; continue; }
    let j = i;
    while (j < n) {
      const c = stripped[j];
      if (/[\s;|()\n]/.test(c)) break;
      if (c === "&" && j > i && !/[<>]/.test(stripped[j - 1]) && stripped[j + 1] !== ">") break;
      j++;
    }
    if (j === i) { i++; continue; } // a lone `&`
    cur.push({ raw: cmd.slice(i, j), stripped: stripped.slice(i, j), start: i });
    i = j;
  }
  return segs.filter(s => s.length);
}

// ── Verb tables ──────────────────────────────────────────────────────────────
const WRAPPERS = new Set(["sudo", "command", "env", "time", "nohup", "exec", "xargs", "doas", "busybox", "-", "--"]);
const RUNNERS = new Set(["npx", "bunx", "pnpx", "yarn", "pnpm", "npm", "bun", "deno", "cargo", "dotnet", "python", "python3", "py", "uv", "uvx", "poetry", "pipx", "mix"]);
const RUNNER_SUBS = new Set(["exec", "dlx", "run", "x", "fmt", "format", "tool"]);
const FORMATTERS = new Set(["prettier", "biome", "eslint", "rustfmt", "gofmt", "goimports", "black", "isort", "ruff", "autopep8", "shfmt", "clang-format", "dprint", "stylua", "php-cs-fixer", "swiftformat", "terraform", "zig", "fmt", "format"]);
const DEFAULT_WRITERS = new Set(["black", "isort", "rustfmt", "dprint", "stylua", "swiftformat", "fmt", "format"]);
const WRITE_FLAG_RE = /^(?:--write|-w|--fix|--fix-only|--unsafe-fixes|--in-place|-i)$/;
const DRY_FLAG_RE = /^(?:--check|--dry-run|--diff|-l|--list-different|--verify)$/;
const GIT_OPAQUE = new Set(["reset", "apply", "stash", "revert", "cherry-pick", "merge", "rebase", "pull", "clean", "am", "switch"]);
const PM_MANIFEST: Record<string, string> = { bun: "package.json", npm: "package.json", pnpm: "package.json", yarn: "package.json", cargo: "Cargo.toml", poetry: "pyproject.toml", uv: "pyproject.toml", go: "go.mod", composer: "composer.json" };
const PM_VERBS = new Set(["add", "install", "i", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "get", "require"]);
const PS_WRITERS: Record<string, "path" | "dest"> = {
  "set-content": "path", "out-file": "path", "add-content": "path", "remove-item": "path", "new-item": "path", "clear-content": "path",
  "copy-item": "dest", "move-item": "dest", "rename-item": "dest",
  sc: "path", ac: "path", ri: "path", ni: "path", del: "path", erase: "path", copy: "dest", move: "dest", ren: "dest", cpi: "dest", mi: "dest",
};
const PS_VALUE_PARAMS = /^-(?:Value|Encoding|Filter|Include|Exclude|ItemType|Width|Stream|NewName|InputObject|Delimiter|Credential|Depth)$/i;

const isOpt = (t: Tok) => t.stripped.startsWith("-") && t.stripped !== "-";
const verbOf = (t: Tok) => t.stripped.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
const skipTarget = (v: string) => !v || v.startsWith("&") || /^\/dev\//i.test(v) || /^nul$/i.test(v) || v === "-";
const dynamic = (v: string) => /^[$%]|\$\(|\$\{|`/.test(v);

/** Paths the command writes. See the header for the contract. */
export function shellWriteTargets(cmd: string): ShellWrites {
  const src = cmd || "";
  const targets = new Set<string>();
  let opaque = false;
  const add = (raw: string) => {
    const v = unquote(raw);
    if (skipTarget(v)) return;
    if (dynamic(v)) { opaque = true; return; }
    targets.add(v);
  };
  if (!src.trim()) return { targets: [], opaque };
  const stripped = stripShellLiterals(src);

  for (const seg of segments(src, stripped)) {
    // Redirects anywhere in the segment; input redirects skip their operand.
    const words: Tok[] = [];
    for (let k = 0; k < seg.length; k++) {
      const t = seg[k];
      const m = REDIRECT_RE.exec(t.stripped);
      if (!m) { words.push(t); continue; }
      const op = m[2];
      const attached = t.stripped.slice(m[0].length);
      if (op.startsWith("<")) { if (!attached && op !== "<<") k++; continue; } // input: skip target word
      if (m[3]) continue; // fd duplication (2>&1)
      if (attached) add(t.raw.slice(m[0].length));
      else if (seg[k + 1]) { add(seg[k + 1].raw); k++; }
    }
    if (!words.length) continue;
    // Skip env assignments and wrappers to reach the verb.
    let w = 0;
    while (w < words.length && (/^[A-Za-z_][\w]*=/.test(words[w].stripped) || WRAPPERS.has(verbOf(words[w])))) w++;
    if (w >= words.length) continue;
    let verb = verbOf(words[w]);
    let args = words.slice(w + 1);
    // Runner prefixes (npx prettier …, bunx biome …, pnpm exec eslint …, cargo fmt).
    if (RUNNERS.has(verb) && args.length) {
      let a = 0;
      while (a < args.length && RUNNER_SUBS.has(verbOf(args[a])) && !FORMATTERS.has(verbOf(args[a]))) a++;
      while (a < args.length && isOpt(args[a])) a++;
      const inner = args[a] ? verbOf(args[a]) : "";
      if (FORMATTERS.has(inner) || (RUNNER_SUBS.has(inner) && inner !== "run")) {
        const pmVerb = inner;
        // `cargo fmt` / `deno fmt` / `dotnet format` / `mix format` → formatter named by the sub.
        if (pmVerb === "fmt" || pmVerb === "format") { verb = pmVerb; args = args.slice(a + 1); }
        else { verb = inner; args = args.slice(a + 1); }
      } else if (PM_MANIFEST[verb] && PM_VERBS.has(inner)) {
        const operands = args.slice(a + 1).filter(t => !isOpt(t));
        if (operands.length || /^(add|remove|rm|uninstall|un|require)$/.test(inner)) targets.add(PM_MANIFEST[verb]);
        continue;
      }
    }
    const operands = args.filter(t => !isOpt(t));
    switch (verb) {
      case "sed": case "perl": {
        const inplace = args.some(t => /^-[a-zA-Z]*i|^--in-place/.test(t.stripped) && isOpt(t));
        if (!inplace) break;
        const files: Tok[] = [];
        let sawScript = false;
        for (let k = 0; k < args.length; k++) {
          const t = args[k];
          if (/^(-e|-f|--expression|--file)$/.test(t.stripped)) { k++; sawScript = true; continue; }
          if (/^(-e|-f)[^-]|^--(expression|file)=/.test(t.stripped)) { sawScript = true; continue; }
          if (isOpt(t)) continue;
          files.push(t);
        }
        if (!sawScript) files.shift(); // first operand is the script
        for (const f of files) add(f.raw);
        if (!files.length) opaque = true;
        break;
      }
      case "tee": for (const o of operands) add(o.raw); break;
      case "cp": case "install": case "ln": case "scp": case "rsync":
        if (operands.length >= 2) add(operands[operands.length - 1].raw); break;
      case "mv": case "rename":
        for (const o of operands) add(o.raw); break;
      case "rm": case "touch": case "truncate": case "unlink": case "shred": case "del": case "erase":
        if (PS_WRITERS[verb] && verb !== "rm") { psWriter(verb, args, add); break; }
        if (!operands.length) opaque = true;
        for (const o of operands) add(o.raw); break;
      case "dd": for (const a of args) if (/^of=/.test(a.stripped)) add(a.raw.slice(3)); break;
      case "curl": for (let k = 0; k < args.length; k++) if (/^(-o|--output)$/.test(args[k].stripped) && args[k + 1]) add(args[++k].raw); break;
      case "wget": for (let k = 0; k < args.length; k++) if (/^(-O|--output-document)$/.test(args[k].stripped) && args[k + 1]) add(args[++k].raw); break;
      case "tar": if (args.some(t => /^-?[a-zA-Z]*x/.test(t.stripped) && (isOpt(t) || t === args[0]))) opaque = true; break;
      case "unzip": case "patch": opaque = true; break;
      case "git": {
        const sub = operands[0] ? verbOf(operands[0]) : "";
        const rest = operands.slice(1);
        const dd = args.findIndex(t => t.stripped === "--");
        if (sub === "checkout" || sub === "restore") {
          const paths = dd >= 0 ? args.slice(dd + 1) : (sub === "restore" ? rest : []);
          if (paths.length) for (const p of paths) add(p.raw); else if (sub === "restore" || dd >= 0) opaque = true;
        } else if (sub === "rm" || sub === "mv") { for (const p of rest) add(p.raw); }
        else if (GIT_OPAQUE.has(sub)) opaque = true;
        else if (sub === "stash" && rest[0] && /^(pop|apply|drop)$/.test(verbOf(rest[0]))) opaque = true;
        break;
      }
      default:
        if (PS_WRITERS[verb]) { psWriter(verb, args, add); break; }
        if (FORMATTERS.has(verb)) {
          if (args.some(t => DRY_FLAG_RE.test(t.stripped))) break;
          const writes = DEFAULT_WRITERS.has(verb) || args.some(t => WRITE_FLAG_RE.test(t.stripped))
            || (verb === "ruff" && operands[0]?.stripped === "format") || (verb === "gofmt" && args.some(t => t.stripped === "-w"));
          if (!writes) break;
          const files = operands.filter(t => !/^(check|format|lint|fmt|ci|--)$/.test(t.stripped));
          if (!files.length) opaque = true;
          for (const f of files) add(f.raw);
        }
    }
  }

  // Inline-script write APIs — scanned on the ORIGINAL text (they sit inside
  // the very quotes the stripper blanks).
  const named = inlineApiTargets(src);
  for (const t of named.targets) add(t);
  if (named.sawApi && !named.targets.length) {
    const cands = candidatePathLiterals(src);
    if (cands.length) for (const c of cands) targets.add(c); else opaque = true;
  }
  return { targets: [...targets], opaque };
}

function psWriter(verb: string, args: Tok[], add: (raw: string) => void): void {
  const kind = PS_WRITERS[verb];
  const positional: Tok[] = [];
  for (let k = 0; k < args.length; k++) {
    const t = args[k];
    if (isOpt(t)) {
      if (/^-(?:Path|LiteralPath|FilePath)$/i.test(t.stripped) && args[k + 1]) { if (kind === "path") add(args[k + 1].raw); k++; continue; }
      if (/^-Destination$/i.test(t.stripped) && args[k + 1]) { add(args[k + 1].raw); k++; continue; }
      if (PS_VALUE_PARAMS.test(t.stripped) && args[k + 1] && !isOpt(args[k + 1])) k++;
      continue;
    }
    positional.push(t);
  }
  if (kind === "path" && positional[0]) add(positional[0].raw);
  if (kind === "dest" && positional[1]) add(positional[1].raw);
}

const API_NAMED: RegExp[] = [
  /(?:writeFileSync|writeFile|appendFileSync|appendFile|Bun\.write|copyFileSync|copyFile|renameSync|unlinkSync|rmSync|outputFile|outputFileSync)\s*\(\s*(['"`])([^'"`\n]+)\1/g,
  /Path\(\s*(['"])([^'"\n]+)\1\s*\)\s*\.write_(?:text|bytes)\s*\(/g,
  /\bopen\(\s*(['"])([^'"\n]+)\1\s*,\s*(?:mode\s*=\s*)?['"][wax]/g,
  /shutil\.(?:copy|copyfile|copy2|move)\(\s*['"][^'"\n]+['"]\s*,\s*(['"])([^'"\n]+)\1/g,
  /os\.(?:remove|unlink|rename|replace)\(\s*(['"])([^'"\n]+)\1/g,
];
const API_ANY = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|Bun\.write|copyFileSync|renameSync|unlinkSync|rmSync|write_text|write_bytes|shutil\.(?:copy|move)|os\.(?:remove|unlink|rename|replace))\b|\bopen\([^)\n]*,\s*(?:mode\s*=\s*)?['"][wax]/;

function inlineApiTargets(src: string): { targets: string[]; sawApi: boolean } {
  const targets: string[] = [];
  for (const re of API_NAMED) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) targets.push(m[2]);
  }
  return { targets, sawApi: targets.length > 0 || API_ANY.test(src) };
}

// Quoted literals that read as file paths (a segment + extension; not a URL,
// not a device, the stem has a letter). Only consulted when a write API is
// present but its target is a variable — "may have written one of these".
const PATH_LITERAL_RE = /(['"])((?:[\w.~-]+[\\/])*[\w-][\w.-]*\.[A-Za-z0-9]{1,5})\1/g;
function candidatePathLiterals(src: string): string[] {
  const out = new Set<string>();
  PATH_LITERAL_RE.lastIndex = 0;
  for (let m = PATH_LITERAL_RE.exec(src); m; m = PATH_LITERAL_RE.exec(src)) {
    const v = m[2];
    if (/:\/\//.test(v) || /^\/dev\//.test(v) || !/[A-Za-z]/.test(v.replace(/\.[A-Za-z0-9]+$/, ""))) continue;
    out.add(v);
  }
  return [...out];
}
