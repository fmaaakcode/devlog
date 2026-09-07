// Value-level secret redaction for the COMMAND channel (F-3.5).
//
// sensitive-paths.ts keeps a `.env` edit's content out of the store by PATH,
// and says so: no regex secret detection on file content, because a false
// positive hides the user's own code from them. Commands are a different
// channel: `echo "TOKEN=sk-…" > .env` or `curl -H "Authorization: Bearer …"`
// carries the secret inline, the path guard never sees it, and the string was
// stored verbatim and served by /api/changes/by-id and every recall surface.
//
// This is deliberately narrow — it blanks the VALUE next to a secret-shaped
// key or a well-known token prefix and leaves the rest of the command intact,
// so recall still shows what was run. Only stored text is touched: the live
// command still reaches isTestCommand / shell-write untouched (they classify
// the shape of the command, not its secrets).

const MARK = "[redacted]";

// `KEY=value`, `key: value`, `--password value`, `-p value` for secret-shaped
// key names. The value stops at whitespace, a quote, or a shell operator so
// the rest of the command line survives.
const KEY_RE = /\b((?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|passwd|password|pwd|passphrase)[a-z0-9_.-]*)(\s*[=:]\s*)(["']?)([^\s"'&|;<>]+)/gi;
const FLAG_RE = /(--?(?:password|passwd|pwd|token|api-key|apikey|secret|auth|bearer)(?:[= ]))(["']?)([^\s"'&|;<>]+)/gi;
const BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/g;
const BASIC_RE = /\b(Basic\s+)([A-Za-z0-9+/=]{8,})/g;
// Provider token shapes that are unambiguous on their own.
const TOKEN_SHAPE_RE = /\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,})\b/g;
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
// `user:password@host` inside a URL (postgres://, mysql://, https://…).
const URL_CRED_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:)([^\s/@"']+)(@)/gi;

/** Blank secret VALUES in a shell command; the command shape is preserved. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(PEM_RE, "[redacted private key]");
  out = out.replace(URL_CRED_RE, `$1${MARK}$3`);
  out = out.replace(BEARER_RE, `$1${MARK}`);
  out = out.replace(BASIC_RE, `$1${MARK}`);
  out = out.replace(KEY_RE, (_m, key: string, sep: string, q: string, value: string) =>
    value === MARK ? `${key}${sep}${q}${value}` : `${key}${sep}${q}${MARK}`);
  out = out.replace(FLAG_RE, `$1$2${MARK}`);
  out = out.replace(TOKEN_SHAPE_RE, MARK);
  return out;
}
