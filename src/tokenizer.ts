// Stage 1: Tokenizer — converts raw source code to typed tokens
// Stage 2: Bracket Condensation — groups matched brackets into single tokens
// Inspired by Universal Ctags' approach (tokenize → condense → match)

export enum TokenType {
  Keyword,       // function, class, const, fn, pub, def, void, int, etc.
  Identifier,    // variable/function/class names
  String,        // "..." '...' `...`
  Comment,       // // ... or /* ... */ or # ...
  Number,        // 123, 0xFF, 3.14
  Operator,      // + - * / = < > ! & | ^ ~ ? : . :: -> =>
  OpenParen,     // (
  CloseParen,    // )
  OpenBracket,   // [
  CloseBracket,  // ]
  OpenBrace,     // {
  CloseBrace,    // }
  OpenAngle,     // < (when used as generic/template)
  CloseAngle,    // > (when used as generic/template)
  Comma,         // ,
  Semicolon,     // ;
  Newline,       // \n
  Preprocessor,  // #include, #define, etc.
  Group,         // condensed bracket group containing children
  Other,
}

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  children?: Token[]; // for Group tokens (condensed brackets)
  groupType?: "paren" | "bracket" | "brace" | "angle"; // what kind of group
}

// Keywords per language family
const JS_KEYWORDS = new Set(["function", "class", "const", "let", "var", "async", "await", "export", "import", "default", "return", "if", "else", "for", "while", "switch", "case", "break", "continue", "new", "this", "typeof", "instanceof", "interface", "type", "enum", "extends", "implements", "static", "private", "public", "protected", "abstract", "readonly"]);
const RUST_KEYWORDS = new Set(["fn", "pub", "struct", "enum", "impl", "trait", "mod", "use", "crate", "self", "super", "let", "mut", "const", "static", "async", "await", "match", "if", "else", "for", "while", "loop", "return", "where", "type", "move", "unsafe", "extern", "ref", "dyn", "Box"]);
const PY_KEYWORDS = new Set(["def", "class", "async", "await", "import", "from", "return", "if", "elif", "else", "for", "while", "with", "try", "except", "finally", "raise", "yield", "lambda", "pass", "self", "None", "True", "False"]);
const CPP_KEYWORDS = new Set(["void", "int", "bool", "char", "float", "double", "long", "short", "unsigned", "signed", "auto", "const", "static", "extern", "virtual", "override", "inline", "explicit", "noexcept", "constexpr", "template", "typename", "class", "struct", "enum", "union", "namespace", "using", "public", "private", "protected", "return", "if", "else", "for", "while", "switch", "case", "break", "continue", "new", "delete", "throw", "try", "catch", "operator", "typedef", "sizeof", "nullptr", "true", "false", "HRESULT", "LRESULT", "BOOL", "DWORD", "HWND", "HANDLE", "LPARAM", "WPARAM", "UINT", "LPVOID", "SOCKET", "ComPtr"]);
const GO_KEYWORDS = new Set(["func", "type", "struct", "interface", "package", "import", "return", "if", "else", "for", "switch", "case", "default", "break", "continue", "go", "chan", "select", "defer", "map", "range", "var", "const"]);

function getKeywords(ext: string): Set<string> {
  if (["ts", "tsx", "js", "jsx"].includes(ext)) return JS_KEYWORDS;
  if (ext === "rs") return RUST_KEYWORDS;
  if (ext === "py") return PY_KEYWORDS;
  if (["cpp", "cc", "cxx", "c", "h", "hpp", "hxx", "cu", "cuh"].includes(ext)) return CPP_KEYWORDS;
  if (ext === "go") return GO_KEYWORDS;
  return JS_KEYWORDS; // fallback
}

// Stage 1: Tokenize source code
export function tokenize(source: string, ext: string): Token[] {
  const tokens: Token[] = [];
  const keywords = getKeywords(ext);
  const len = source.length;
  let i = 0;
  let line = 1;
  // Count of currently UNMATCHED open angles. Using `tokens.some(OpenAngle)`
  // (the old check) stayed true forever after the first generic, so every
  // later `a > b` comparison was miscounted as a closing angle (R3 P5).
  let openAngleDepth = 0;

  while (i < len) {
    const ch = source[i];

    // Newlines
    if (ch === "\n") {
      tokens.push({ type: TokenType.Newline, value: "\n", line });
      line++;
      i++;
      continue;
    }

    // Whitespace (skip)
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }

    // Preprocessor (#include, #define, etc.)
    if (ch === "#" && ["cpp", "cc", "cxx", "c", "h", "hpp", "hxx", "cu", "cuh"].includes(ext)) {
      const start = i;
      while (i < len && source[i] !== "\n") i++;
      tokens.push({ type: TokenType.Preprocessor, value: source.slice(start, i), line });
      continue;
    }

    // Single-line comments: // or #
    if (ch === "/" && i + 1 < len && source[i + 1] === "/") {
      const start = i;
      while (i < len && source[i] !== "\n") i++;
      tokens.push({ type: TokenType.Comment, value: source.slice(start, i), line });
      continue;
    }
    if (ch === "#" && ["py", "rb", "sh"].includes(ext)) {
      const start = i;
      while (i < len && source[i] !== "\n") i++;
      tokens.push({ type: TokenType.Comment, value: source.slice(start, i), line });
      continue;
    }

    // Multi-line comments: /* ... */
    if (ch === "/" && i + 1 < len && source[i + 1] === "*") {
      const start = i;
      const startLine = line;
      i += 2;
      while (i < len && !(source[i] === "*" && i + 1 < len && source[i + 1] === "/")) {
        if (source[i] === "\n") line++;
        i++;
      }
      if (i < len) i += 2; // skip */
      tokens.push({ type: TokenType.Comment, value: source.slice(start, i), line: startLine });
      continue;
    }

    // Regex literals: /.../ (JS/TS only — must follow operator/keyword/open bracket)
    if (ch === "/" && ["ts", "tsx", "js", "jsx"].includes(ext)) {
      // Regex if preceded by: operator, keyword, ( [ { , ; = ! or start of line
      const prev = findPrevSignificant(tokens);
      const canBeRegex = !prev || prev.type === TokenType.Operator || prev.type === TokenType.Keyword ||
        prev.type === TokenType.OpenParen || prev.type === TokenType.OpenBracket || prev.type === TokenType.OpenBrace ||
        prev.type === TokenType.Comma || prev.type === TokenType.Semicolon || prev.type === TokenType.Newline;
      if (canBeRegex) {
        const start = i;
        i++; // skip opening /
        let escaped = false;
        let inCharClass = false;
        while (i < len && source[i] !== "\n") {
          if (escaped) { escaped = false; i++; continue; }
          if (source[i] === "\\") { escaped = true; i++; continue; }
          if (source[i] === "[") { inCharClass = true; i++; continue; }
          if (source[i] === "]") { inCharClass = false; i++; continue; }
          if (source[i] === "/" && !inCharClass) { i++; break; }
          i++;
        }
        // Skip flags (g, i, m, s, u, v, y, d)
        while (i < len && /[gimsuvyd]/.test(source[i])) i++;
        tokens.push({ type: TokenType.String, value: source.slice(start, i), line });
        continue;
      }
    }

    // Strings: "..." '...' `...` (with escape handling)
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const start = i;
      const startLine = line;
      i++;
      while (i < len) {
        if (source[i] === "\\") { i += 2; continue; } // skip escaped
        if (source[i] === "\n") line++;
        if (source[i] === quote) { i++; break; }
        i++;
      }
      tokens.push({ type: TokenType.String, value: source.slice(start, i), line: startLine });
      continue;
    }

    // Rust raw strings: r"..." r#"..."#
    if (ch === "r" && ext === "rs" && i + 1 < len && (source[i + 1] === '"' || source[i + 1] === "#")) {
      const start = i;
      i++; // skip r
      let hashes = 0;
      while (i < len && source[i] === "#") { hashes++; i++; }
      if (i < len && source[i] === '"') {
        i++; // skip opening "
        const closing = `"${"#".repeat(hashes)}`;
        while (i < len) {
          if (source[i] === "\n") line++;
          if (source.slice(i, i + closing.length) === closing) { i += closing.length; break; }
          i++;
        }
      }
      tokens.push({ type: TokenType.String, value: source.slice(start, i), line });
      continue;
    }

    // Python triple quotes: """ or '''
    if (ext === "py" && (ch === '"' || ch === "'") && i + 2 < len && source[i + 1] === ch && source[i + 2] === ch) {
      const triple = ch + ch + ch;
      const start = i;
      const startLine = line;
      i += 3;
      while (i < len) {
        if (source[i] === "\n") line++;
        if (i + 2 < len && source.slice(i, i + 3) === triple) { i += 3; break; }
        i++;
      }
      tokens.push({ type: TokenType.String, value: source.slice(start, i), line: startLine });
      continue;
    }

    // Numbers
    if ((ch >= "0" && ch <= "9") || (ch === "." && i + 1 < len && source[i + 1] >= "0" && source[i + 1] <= "9")) {
      const start = i;
      if (ch === "0" && i + 1 < len && (source[i + 1] === "x" || source[i + 1] === "X" || source[i + 1] === "b" || source[i + 1] === "o")) {
        i += 2; // 0x, 0b, 0o prefix
      }
      while (i < len && /[0-9a-fA-F_.eEpP+\-xu]/.test(source[i])) i++;
      tokens.push({ type: TokenType.Number, value: source.slice(start, i), line });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(ch)) {
      const start = i;
      while (i < len && /[a-zA-Z0-9_$]/.test(source[i])) i++;
      const value = source.slice(start, i);
      // Check for type qualifiers that are effectively keywords (std::string, etc.)
      const type = keywords.has(value) ? TokenType.Keyword : TokenType.Identifier;
      tokens.push({ type, value, line });
      continue;
    }

    // Brackets
    if (ch === "(") { tokens.push({ type: TokenType.OpenParen, value: ch, line }); i++; continue; }
    if (ch === ")") { tokens.push({ type: TokenType.CloseParen, value: ch, line }); i++; continue; }
    if (ch === "[") { tokens.push({ type: TokenType.OpenBracket, value: ch, line }); i++; continue; }
    if (ch === "]") { tokens.push({ type: TokenType.CloseBracket, value: ch, line }); i++; continue; }
    if (ch === "{") { tokens.push({ type: TokenType.OpenBrace, value: ch, line }); i++; continue; }
    if (ch === "}") { tokens.push({ type: TokenType.CloseBrace, value: ch, line }); i++; continue; }

    // Angle brackets — context-sensitive (< > could be comparison or generic)
    if (ch === "<") {
      // Heuristic: it's a generic/template if preceded by type-like identifier or keyword
      const prev = findPrevSignificant(tokens);
      let isGeneric = false;
      if (prev) {
        if (prev.type === TokenType.Keyword && ["class", "struct", "enum", "fn", "function", "type", "interface", "template", "typename", "impl", "trait"].includes(prev.value)) {
          isGeneric = true;
        } else if (prev.type === TokenType.Identifier) {
          // JS/TS: only PascalCase = type names (Set<T>, Map<K,V>, Promise<T>, etc.)
          if (["ts", "tsx", "js", "jsx"].includes(ext)) {
            isGeneric = /^[A-Z]/.test(prev.value);
          } else {
            // C++/Rust/Go: allow lowercase type names too (vector<int>, unique_ptr<T>)
            isGeneric = true;
          }
        }
      }
      tokens.push({ type: isGeneric ? TokenType.OpenAngle : TokenType.Operator, value: ch, line });
      if (isGeneric) openAngleDepth++;
      i++;
      continue;
    }
    if (ch === ">") {
      // Only treat `>` as a closing angle when an open one is still unmatched.
      if (openAngleDepth > 0) {
        // Handle >> as two closing angles (only as many as are actually open)
        if (i + 1 < len && source[i + 1] === ">" && openAngleDepth >= 2) {
          tokens.push({ type: TokenType.CloseAngle, value: ">", line });
          tokens.push({ type: TokenType.CloseAngle, value: ">", line });
          openAngleDepth -= 2;
          i += 2;
          continue;
        }
        tokens.push({ type: TokenType.CloseAngle, value: ch, line });
        openAngleDepth--;
      } else {
        tokens.push({ type: TokenType.Operator, value: ch, line });
      }
      i++;
      continue;
    }

    // Comma, semicolon
    if (ch === ",") { tokens.push({ type: TokenType.Comma, value: ch, line }); i++; continue; }
    if (ch === ";") { tokens.push({ type: TokenType.Semicolon, value: ch, line }); i++; continue; }

    // Multi-char operators
    if (ch === ":" && i + 1 < len && source[i + 1] === ":") {
      tokens.push({ type: TokenType.Operator, value: "::", line }); i += 2; continue;
    }
    if (ch === "-" && i + 1 < len && source[i + 1] === ">") {
      tokens.push({ type: TokenType.Operator, value: "->", line }); i += 2; continue;
    }
    if (ch === "=" && i + 1 < len && source[i + 1] === ">") {
      tokens.push({ type: TokenType.Operator, value: "=>", line }); i += 2; continue;
    }

    // Other operators
    if ("+-*/%=!&|^~?:.@".includes(ch)) {
      tokens.push({ type: TokenType.Operator, value: ch, line }); i++; continue;
    }

    // Anything else
    i++;
  }

  return tokens;
}

function findPrevSignificant(tokens: Token[]): Token | null {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].type !== TokenType.Newline && tokens[i].type !== TokenType.Comment) {
      return tokens[i];
    }
  }
  return null;
}

// Stage 2: Bracket Condensation — replace matched bracket pairs with Group tokens
export function condenseBrackets(tokens: Token[]): Token[] {
  return condenseType(
    condenseType(
      condenseType(
        condenseType(tokens, TokenType.OpenAngle, TokenType.CloseAngle, "angle"),
        TokenType.OpenParen, TokenType.CloseParen, "paren"
      ),
      TokenType.OpenBracket, TokenType.CloseBracket, "bracket"
    ),
    TokenType.OpenBrace, TokenType.CloseBrace, "brace"
  );
}

function condenseType(tokens: Token[], open: TokenType, close: TokenType, groupType: "paren" | "bracket" | "brace" | "angle"): Token[] {
  const result: Token[] = [];
  const stack: { startIdx: number; line: number }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.type === open) {
      stack.push({ startIdx: result.length, line: t.line });
      result.push(t); // placeholder
    } else if (t.type === close && stack.length > 0) {
      const { startIdx, line } = stack.pop()!;
      // Collect everything between open and close as children
      const children = result.splice(startIdx + 1);
      result[startIdx] = {
        type: TokenType.Group,
        value: groupType,
        line,
        children,
        groupType,
      };
    } else {
      result.push(t);
    }
  }

  return result;
}

// Utility: filter out comments, strings, and newlines — get "significant" tokens only
export function significantTokens(tokens: Token[]): Token[] {
  return tokens.filter(t =>
    t.type !== TokenType.Comment &&
    t.type !== TokenType.String &&
    t.type !== TokenType.Newline &&
    t.type !== TokenType.Preprocessor
  );
}

// Extract all #include "file.h" from preprocessor tokens
export function extractIncludes(tokens: Token[]): string[] {
  const includes: string[] = [];
  for (const t of tokens) {
    if (t.type === TokenType.Preprocessor) {
      const m = t.value.match(/#include\s+"([^"]+)"/);
      if (m) includes.push(m[1]);
    }
  }
  return includes;
}
