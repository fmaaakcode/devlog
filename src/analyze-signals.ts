// Text-signature detectors split out of analyze.ts (size ratchet, wave 3):
// threads/workers and security-relevant spots. Both run over the
// COMMENT-STRIPPED source analyze.ts hands them (code-comments.ts) — the
// false positives of this family lived in comments and prose (#1076).
// Consumers label the output as inference (export.ts INFERENCE_NOTE).

import type { SecurityPattern, ThreadInfo } from "./analyze";
import { currentLang } from "./i18n";

const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);
// Detect threads/workers from code
export function extractThreads(content: string, filePath: string): ThreadInfo[] {
  const threads: ThreadInfo[] = [];
  const file = filePath.split("/").pop() || filePath;
  const seen = new Set<string>();

  // Rust: thread::spawn / tokio::spawn
  for (const m of content.matchAll(/(?:thread::spawn|tokio::spawn|std::thread::spawn)\s*\(\s*(?:move\s*)?\|?\|?\s*\{?\s*(?:\/\/\s*(.+))?/g)) {
    const comment = m[1]?.trim() || "";
    const ctx = content.slice((m.index ?? 0), Math.min((m.index ?? 0) + 500, content.length));

    // Detect purpose
    let purpose = comment;
    if (!purpose) {
      if (/watch|notify|file.*change|debounce/i.test(ctx)) purpose = "file watcher";
      else if (/server|listen|bind|accept|TcpListener/i.test(ctx)) purpose = "server listener";
      else if (/refresh|interval|sleep.*loop|loop\s*\{.*sleep/is.test(ctx)) purpose = "periodic task";
      else if (/tray|menu|system_tray/i.test(ctx)) purpose = "system tray";
      else if (/hook|event/i.test(ctx)) purpose = "event handler";
      else purpose = "per-request task";
    }

    // Detect if persistent (has loop/listen) or temporary
    const isPersistent = /\bloop\s*\{|\.for_each|\.listen|\.recv|while\s|\.accept/s.test(ctx);
    const kind = isPersistent ? L("persistent", "دائم") : L("temporary", "مؤقت");

    // Deduplicate by purpose
    const key = `${purpose}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);

    threads.push({ name: `${purpose} (${kind})`, file, purpose });
  }

  // JS: new Worker
  for (const m of content.matchAll(/new\s+Worker\s*\(\s*['"]([^'"]+)['"]/g)) {
    threads.push({ name: m[1], file, purpose: `Web Worker (${L("persistent", "دائم")})` });
  }

  // Python: threading.Thread
  for (const m of content.matchAll(/threading\.Thread\s*\(.*target\s*=\s*(\w+)/g)) {
    threads.push({ name: m[1], file, purpose: "thread" });
  }

  return threads;
}

// Detect security patterns. `content` is the COMMENT-STRIPPED source (see
// stripCodeComments): the signatures below are text evidence, and comments
// and prose produced most of the false positives — `joi` inside `join`,
// `esc(` inside `desc(`, "TLS/SSL" for a comment naming openssl, "AEAD" for
// an HTML page that mentions GCM (#1076). Consumers must still present the
// result as inference, not fact (export.ts labels the section accordingly).
export function extractSecurity(content: string, filePath: string): SecurityPattern[] {
  const patterns: SecurityPattern[] = [];
  const file = filePath.split("/").pop() || filePath;
  const ext = file.split(".").pop()?.toLowerCase() || "";

  // Markup carries prose, not code: the only signature HTML can honestly
  // evidence is a CSP meta tag.
  if (ext === "html" || ext === "htm") {
    if (/content-security-policy/i.test(content)) patterns.push({ type: "CSP", location: file });
    return patterns;
  }

  // XSS: only in web code (JS/TS), not desktop C++
  if (["js", "jsx", "ts", "tsx", "py", "rb", "php"].includes(ext)) {
    if (/(?:function|fn|def)\s+(?:sanitize|sanitize_?html|escape_?html|esc)\b/i.test(content) || /(?<![\w$])(?:sanitize|sanitizeHtml|escapeHtml|esc)\s*\(/i.test(content)) {
      patterns.push({ type: "XSS Protection", location: file });
    }
  }
  // Input validation via sanitize functions
  if (/(?:function|fn|def)\s+(?:sanitize|validate|sanitize_?html)\b/i.test(content)) {
    patterns.push({ type: "Input Validation", location: file });
  }
  // SSRF: URL validation functions / allow-list identifiers
  if (/(?:function|fn|def)\s+is_?safe_?url\b|(?<![\w$])allowed_?(?:hosts|origins|urls)(?![\w$])/i.test(content)) {
    patterns.push({ type: "SSRF Protection", location: file });
  }
  // CSP: server headers
  if (/["']Content-Security-Policy["']/i.test(content)) {
    patterns.push({ type: "CSP", location: file });
  }
  // CORS: actual header setting
  if (/Access-Control-Allow-Origin/i.test(content) && /header|set|response/i.test(content)) {
    patterns.push({ type: "CORS", location: file });
  }
  // Rate limiting: actual implementation
  if (/(?:function|fn|class)\s+\w*(?:rate_?limit|throttle)/i.test(content) || /new\s+(?:RateLimit|Throttle)/i.test(content)) {
    patterns.push({ type: "Rate Limiting", location: file });
  }
  // Input validation: an actual schema library import (the package name as a
  // whole quoted specifier — `joi` used to match inside `join`) or validate calls
  if (/(?:import|require)[^\n]*['"](?:zod|joi|yup|ajv)(?:\/[^'"]*)?['"]/i.test(content) || /\.safeParse\s*\(|\.validate\s*\(/i.test(content)) {
    patterns.push({ type: "Input Validation", location: file });
  }
  // Confirmation headers
  if (/X-Confirm|x-confirm/i.test(content) && /header|get|req/i.test(content)) {
    patterns.push({ type: "Confirmation Header", location: file });
  }

  // === Cryptography & Encryption ===
  // E2E Encryption (AES-GCM, ChaCha20)
  if (/AES.?256.?GCM|aes_gcm|AES_GCM|chacha20|ChaCha20Poly1305|crypto_aead/i.test(content)) {
    patterns.push({ type: "E2E Encryption (AES-256-GCM / ChaCha20)", location: file });
  }
  // Key Exchange (X25519, DH, ECDH)
  if (/X25519|x25519|crypto_box_keypair|crypto_scalarmult|ECDH|DiffieHellman/i.test(content)) {
    patterns.push({ type: "Key Exchange (X25519)", location: file });
  }
  // CSPRNG
  if (/randombytes_buf|crypto_secretbox_keygen|CSPRNG|SecureRandom|crypto_randomBytes|getrandom/i.test(content)) {
    patterns.push({ type: "CSPRNG", location: file });
  }
  // Key protection (overwrite/zeroize)
  if (/sodium_memzero|SecureZeroMemory|explicit_bzero|zeroize|key.*overwrite|overwrite.*key/i.test(content)) {
    patterns.push({ type: "Key Overwrite Protection", location: file });
  }
  // AEAD Authentication — identifier-shaped tokens only (`GCM` as a bare word
  // is prose; `Aes256Gcm`/`AES_GCM`/`crypto_aead_*` are code)
  if (/\bAEAD\b|\baead\b|crypto_aead_|authenticated_?encrypt|[A-Za-z0-9_]*(?:Gcm|GCM|_gcm)\b|Poly1305/.test(content)) {
    patterns.push({ type: "AEAD Authentication", location: file });
  }
  // TLS/SSL — API identifiers, not the word openssl in a sentence
  if (/SSL_CTX|SSL_new|\bopenssl::|\bopenssl\s*\(|require\s*\(\s*['"]openssl|from\s+['"]openssl|\brustls\b|TlsStream|\btls::/.test(content)) {
    patterns.push({ type: "TLS/SSL", location: file });
  }

  return patterns;
}
