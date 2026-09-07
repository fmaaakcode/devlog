// C/C++ symbol extraction (split out of symbols.ts, size ratchet, wave 3).
// Opens namespace / extern blocks (#1083) and recognizes definitions at
// statement boundaries whatever their return type spells (#1084).

import { type Token, TokenType, significantTokens } from "./tokenizer";
import type { Symbol as CodeSymbol } from "./symbols";
import { bodyEnd, groupText, simplifyParams } from "./symbols-shared";
// ============ C/C++ ============

export function extractCpp(tokens: Token[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const typeKeywords = new Set(["void", "int", "bool", "char", "float", "double", "long", "short", "unsigned", "signed", "auto", "const", "static", "extern", "virtual", "inline", "explicit", "constexpr", "HRESULT", "LRESULT", "BOOL", "DWORD", "HWND", "HANDLE", "LPVOID", "SOCKET", "ComPtr", "size_t"]);
  // A definition can only begin where a statement begins: file start, after
  // `;`, after a closing `}` group, or after a `template<…>` header. Scanning
  // for "a type token anywhere" (the old rule) both missed `std::string
  // Foo::bar()` / `uint32_t g()` / `Foo::~Foo()` (no leading keyword or
  // capital) and fired inside expressions (#1084).
  let stmtStart = true;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const atStart = stmtStart;
    stmtStart = t.type === TokenType.Semicolon || (t.type === TokenType.Group && t.groupType === "brace");

    // namespace x { … } / namespace { … } / extern "C" { … } — the body is a
    // brace group like any other; the old scanner never opened it, so every
    // definition of a namespaced C++ file was invisible (#1083).
    if (t.type === TokenType.Keyword && (t.value === "namespace" || t.value === "extern")) {
      let j = i + 1;
      while (j < tokens.length && (tokens[j].type === TokenType.Identifier || (tokens[j].type === TokenType.Operator && tokens[j].value === "::"))) j++;
      if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") {
        symbols.push(...extractCpp(significantTokens(tokens[j].children ?? [])));
        i = j;
        stmtStart = true;
        continue;
      }
      if (t.value === "namespace") continue;
    }

    // class/struct Name { ... };
    if (t.type === TokenType.Keyword && (t.value === "class" || t.value === "struct")) {
      let j = i + 1;
      if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        const name = tokens[j].value;
        j++;
        // Skip : public Base — look for brace body or semicolon (forward declaration)
        while (j < tokens.length && !(tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") && tokens[j].type !== TokenType.Semicolon) j++;
        if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") {
          const body = tokens[j];
          const sym: CodeSymbol = {
            name, kind: t.value as "class" | "struct", params: "",
            isExported: true, isAsync: false, line: t.line, endLine: bodyEnd(body),
            children: [],
          };
          // Extract method declarations from class body
          if (body.children) {
            const inner = significantTokens(body.children);
            for (let k = 0; k < inner.length; k++) {
              // Look for: identifier(params)
              if (inner[k].type === TokenType.Identifier && k + 1 < inner.length && inner[k + 1].type === TokenType.Group && inner[k + 1].groupType === "paren") {
                const mName = inner[k].value;
                if (["if", "for", "while", "switch", "catch", "return", "sizeof", "decltype"].includes(mName)) continue;
                sym.children ??= [];
                sym.children.push(mName);
                // Check if has body (definition) or just declaration
                const mBody = k + 2 < inner.length && inner[k + 2].type === TokenType.Group && inner[k + 2].groupType === "brace" ? inner[k + 2] : null;
                symbols.push({
                  name: `${name}::${mName}`, kind: "method",
                  params: simplifyParams(groupText(inner[k + 1]), "cpp"),
                  isExported: true, isAsync: false, line: inner[k].line, endLine: mBody ? bodyEnd(mBody) : inner[k].line,
                  parent: name,
                });
              }
            }
          }
          symbols.push(sym);
          i = j;
          stmtStart = true;
        }
      }
      continue;
    }

    // enum (class)? Name { ... };
    if (t.type === TokenType.Keyword && t.value === "enum") {
      let j = i + 1;
      if (j < tokens.length && tokens[j].type === TokenType.Keyword && tokens[j].value === "class") j++;
      if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        symbols.push({
          name: tokens[j].value, kind: "enum", params: "",
          isExported: true, isAsync: false, line: t.line, endLine: t.line,
        });
      }
      continue;
    }

    // template<...> — skip, the next symbol will be captured
    if (t.type === TokenType.Keyword && t.value === "template") {
      if (i + 1 < tokens.length && tokens[i + 1].type === TokenType.Group && tokens[i + 1].groupType === "angle") {
        i++; // skip the angle group, let next iteration capture the class/function
      }
      stmtStart = true;
      continue;
    }

    if (!atStart) continue;
    const def = parseCppDefinition(tokens, i, typeKeywords);
    if (!def) continue;
    const { className, name, params, body, headerLine, next } = def;
    const fullName = className ? `${className}::${name}` : name;
    const endLine = body ? bodyEnd(body) : headerLine;
    if (className) {
      // Skip if already found (with a body) from the class body
      const existing = symbols.find(s => s.name === fullName);
      if (!existing) {
        symbols.push({
          name: fullName, kind: "method", params: simplifyParams(params, "cpp"),
          isExported: true, isAsync: false, line: headerLine, endLine, parent: className,
        });
      } else if (body && existing.endLine <= existing.line) {
        // Update line span for the in-class declaration
        existing.line = headerLine;
        existing.endLine = endLine;
      }
    } else if (body && !symbols.some(s => s.name.endsWith(`::${name}`))) {
      symbols.push({
        name, kind: "function", params: simplifyParams(params, "cpp"),
        isExported: true, isAsync: false, line: headerLine, endLine,
      });
    }
    i = next;
    stmtStart = true;
  }

  return symbols;
}

const CPP_NOT_A_NAME = new Set(["if", "for", "while", "switch", "catch", "return", "else", "sizeof", "typeof", "decltype", "alignof", "static_assert"]);

// Parse `[type…] [Ns::]*[Cls::]name|~name(params) [qualifiers|: init-list] {body}|;`
// starting at a statement boundary. Returns null when the run is not a
// function-shaped declarator. The type may be empty ONLY for constructors and
// destructors (`Foo::Foo()`, `Foo::~Foo()`), so a call statement `foo(x);`
// never qualifies; a statement-level prototype `int f();` is returned with
// body=null and the caller decides whether to keep it.
function parseCppDefinition(tokens: Token[], start: number, typeKeywords: Set<string>): { className: string; name: string; params: string; body: Token | null; headerLine: number; next: number } | null {
  let j = start;
  // Attributes `[[nodiscard]]` and template headers were skipped by the caller;
  // tolerate a leading bracket group here as well.
  while (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "bracket") j++;
  const run: Token[] = [];
  while (j < tokens.length) {
    const tok = tokens[j];
    const ok =
      tok.type === TokenType.Identifier ||
      (tok.type === TokenType.Keyword && typeKeywords.has(tok.value)) ||
      (tok.type === TokenType.Operator && (tok.value === "::" || tok.value === "*" || tok.value === "&" || tok.value === "~")) ||
      (tok.type === TokenType.Group && tok.groupType === "angle");
    if (!ok) break;
    run.push(tok);
    j++;
  }
  if (run.length === 0 || j >= tokens.length) return null;
  if (!(tokens[j].type === TokenType.Group && tokens[j].groupType === "paren")) return null;
  const paramsGroup = tokens[j];
  // Name = last identifier of the run (with an optional `~` before it).
  let n = run.length - 1;
  if (run[n].type !== TokenType.Identifier) return null;
  const name = run[n].value;
  if (CPP_NOT_A_NAME.has(name)) return null;
  let isDtor = false;
  n--;
  if (n >= 0 && run[n].type === TokenType.Operator && run[n].value === "~") { isDtor = true; n--; }
  // Qualifying path: (Identifier [angle] ::)* directly before the name.
  const path: string[] = [];
  while (n >= 1 && run[n].type === TokenType.Operator && run[n].value === "::") {
    let m = n - 1;
    if (run[m].type === TokenType.Group && run[m].groupType === "angle") m--;
    if (m < 0 || run[m].type !== TokenType.Identifier) break;
    path.unshift(run[m].value);
    n = m - 1;
  }
  const className = path.length ? path[path.length - 1] : "";
  const hasType = n >= 0 && run.slice(0, n + 1).some(tok => tok.type === TokenType.Identifier || tok.type === TokenType.Keyword);
  const isCtorOrDtor = className !== "" && className === name;
  if (!hasType && !isCtorOrDtor) return null;
  if (hasType && isDtor) return null;
  // After the params: qualifiers, trailing return type, initializer list —
  // anything up to the body `{…}` or the terminating `;`.
  let k = j + 1;
  let body: Token | null = null;
  while (k < tokens.length) {
    const tok = tokens[k];
    if (tok.type === TokenType.Group && tok.groupType === "brace") { body = tok; break; }
    if (tok.type === TokenType.Semicolon) break;
    // A new declaration keyword means the header never closed (macro soup).
    if (tok.type === TokenType.Keyword && ["class", "struct", "namespace", "template", "enum", "using", "typedef"].includes(tok.value)) return null;
    k++;
  }
  if (k >= tokens.length) return null;
  return { className, name: isDtor ? `~${name}` : name, params: groupText(paramsGroup), body, headerLine: run[0].line, next: k };
}
