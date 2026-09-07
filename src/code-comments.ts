// Blank the comments out of a source file while keeping every other character
// (and every newline) in place, so regex-based detectors run over CODE only.
//
// Why: the analyzer's text signatures ("HTTP Server" from `Bun.serve`, the
// security section's `openssl`/`GCM`, the project-level "File Watcher" label)
// fired on comments and prose as readily as on calls — data.ts became an entry
// point for MENTIONING Bun.serve in a comment, and three files earned "TLS/SSL"
// for a comment naming openssl (#1076, #1077, #1079). Matching on the stripped
// text is the shared fix for that whole class (audit round 10, root cause R2).
//
// Reuses the tokenizer, which already knows each language's string and regex
// syntax, so a `//` inside a regex literal or a `#` inside a string is not a
// comment here either. HTML/XML comments are handled separately because the
// tokenizer is not markup-aware.

import { tokenize, TokenType } from "./tokenizer";

const MARKUP_EXT = new Set(["html", "htm", "vue", "svelte", "xml", "svg"]);

function blankRange(chars: string[], start: number, end: number): void {
  for (let k = start; k < end && k < chars.length; k++) {
    if (chars[k] !== "\n" && chars[k] !== "\r") chars[k] = " ";
  }
}

export function stripCodeComments(content: string, ext: string): string {
  if (!content) return content;
  const chars = content.split("");
  if (MARKUP_EXT.has(ext)) {
    for (const m of content.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
      blankRange(chars, m.index ?? 0, (m.index ?? 0) + m[0].length);
    }
    // Vue/Svelte single-file components and inline <script> blocks still carry
    // JS comments; only the markup ones are handled here — the JS ones are
    // rarely where prose lives, and misreading `</script>` is the bigger risk.
    return chars.join("");
  }
  for (const t of tokenize(content, ext)) {
    if (t.type === TokenType.Comment && t.start !== undefined && t.end !== undefined) {
      blankRange(chars, t.start, t.end);
    }
  }
  return chars.join("");
}
