// Stage 3: Symbol extraction from condensed tokens
// Extracts functions, classes, methods, structs, enums with high accuracy

import { type Token, TokenType, tokenize, condenseBrackets, significantTokens, extractIncludes } from "./tokenizer";
import { bodyEnd, groupText, simplifyParams } from "./symbols-shared";
import { extractCpp } from "./symbols-cpp";

export interface Symbol {
  name: string;
  kind: "function" | "method" | "class" | "struct" | "enum" | "interface" | "type" | "trait" | "impl";
  params: string;
  isExported: boolean;
  isAsync: boolean;
  line: number;
  endLine: number;
  parent?: string;        // class/struct name for methods
  children?: string[];    // method names for classes
  bodyTokens?: Token[];   // for deeper analysis
}

// Main extraction function — works for all languages
export function extractSymbols(source: string, ext: string): { symbols: Symbol[]; includes: string[] } {
  const rawTokens = tokenize(source, ext);
  const includes = extractIncludes(rawTokens);
  const condensed = condenseBrackets(rawTokens);
  const tokens = significantTokens(condensed);

  let symbols: Symbol[] = [];

  if (["ts", "tsx", "js", "jsx"].includes(ext)) {
    symbols = extractJS(tokens);
  } else if (["cpp", "cc", "cxx", "c", "h", "hpp", "hxx", "cu", "cuh"].includes(ext)) {
    symbols = extractCpp(tokens);
  } else if (ext === "rs") {
    symbols = extractRust(tokens);
  } else if (ext === "py") {
    symbols = extractPython(tokens, source);
  } else if (ext === "go") {
    symbols = extractGo(tokens);
  }

  // Deduplicate by name (keep the one with more info / larger body)
  const seen = new Map<string, Symbol>();
  for (const s of symbols) {
    const existing = seen.get(s.name);
    if (!existing || (s.endLine - s.line) > (existing.endLine - existing.line)) {
      seen.set(s.name, s);
    }
  }
  symbols = [...seen.values()];

  return { symbols, includes };
}

const TS_STATEMENT_KEYWORDS = new Set(["const", "let", "var", "export", "function", "class", "import", "return", "if", "for", "while", "switch", "async", "interface", "enum"]);

// Starting AT a `:` that introduces a TS return type, walk over the type and
// return the index of the body brace group (or -1 when the declaration has no
// body). A brace group belongs to the type when what follows it continues a
// type (`| null`, `[]`, `=>`, `.`); otherwise it is the body. The old scan took
// the FIRST brace group as the body, so `(): { a: T } {` reported the type's
// fields as the function and ended it one line later (#1086).
function skipReturnType(tokens: Token[], from: number): number {
  let j = from + 1;
  while (j < tokens.length) {
    const tok = tokens[j];
    if (tok.type === TokenType.Group && tok.groupType === "brace") {
      const nx = tokens[j + 1];
      const continues = nx && (
        (nx.type === TokenType.Operator && ["|", "&", "=>", ".", "?"].includes(nx.value)) ||
        (nx.type === TokenType.Group && (nx.groupType === "bracket" || nx.groupType === "brace"))
      );
      if (!continues) return j;
    } else if (tok.type === TokenType.Semicolon || (tok.type === TokenType.Keyword && TS_STATEMENT_KEYWORDS.has(tok.value))) {
      return -1;
    }
    j++;
  }
  return -1;
}

// Body of a class/object method whose `(params)` group sits at idx-1: either
// the brace group right there, or the one after a `:` return type (#1086).
function methodBody(inner: Token[], idx: number): Token | null {
  if (idx >= inner.length) return null;
  const tok = inner[idx];
  if (tok.type === TokenType.Group && tok.groupType === "brace") return tok;
  if (tok.type === TokenType.Operator && tok.value === ":") {
    const b = skipReturnType(inner, idx);
    return b === -1 ? null : inner[b];
  }
  return null;
}

// For `(params): ReturnType => body`, find the arrow's own `=>`: a `=>` that
// directly follows a paren group is a function TYPE inside the annotation
// (`(x: T) => void`), never the arrow itself. Returns -1 when no arrow follows
// before the statement ends. The old scan stopped at the first Operator, which
// was the `:` itself, so every typed arrow was dropped (#1085).
function findArrowAfterType(tokens: Token[], from: number): number {
  for (let j = from; j < tokens.length; j++) {
    const tok = tokens[j];
    if (tok.type === TokenType.Operator && tok.value === "=>") {
      const prev = tokens[j - 1];
      if (!(prev && prev.type === TokenType.Group && prev.groupType === "paren") || j === from) return j;
      continue;
    }
    if (tok.type === TokenType.Semicolon || (tok.type === TokenType.Keyword && TS_STATEMENT_KEYWORDS.has(tok.value))) return -1;
  }
  return -1;
}

// ============ JavaScript / TypeScript ============

function extractJS(tokens: Token[]): Symbol[] {
  const symbols: Symbol[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // export? async? function name(params) {body}
    if (t.type === TokenType.Keyword && (t.value === "function" || t.value === "async")) {
      let isExported = false;
      let isAsync = false;
      let j = i;

      // Look back for export
      if (i > 0 && tokens[i - 1].type === TokenType.Keyword && tokens[i - 1].value === "export") isExported = true;

      if (t.value === "async") {
        isAsync = true;
        j++;
        if (j < tokens.length && tokens[j].type === TokenType.Keyword && tokens[j].value === "function") j++;
        else continue; // async without function — skip for now
      } else {
        j++;
      }

      // Name
      if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        const name = tokens[j].value;
        j++;
        // Params (group)
        let params = "";
        if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "paren") {
          params = groupText(tokens[j]);
          j++;
        }
        // Body (brace group) — a `:` return type is walked with type awareness
        // so an object-typed return is not mistaken for the body (#1086).
        if (j < tokens.length && tokens[j].type === TokenType.Operator && tokens[j].value === ":") {
          const b = skipReturnType(tokens, j);
          j = b === -1 ? tokens.length : b;
        } else {
          while (j < tokens.length && !(tokens[j].type === TokenType.Group && tokens[j].groupType === "brace")) j++;
        }
        const body = (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") ? tokens[j] : null;

        symbols.push({
          name, kind: "function", params: simplifyParams(params, "ts"),
          isExported, isAsync, line: t.line, endLine: body ? bodyEnd(body) : t.line,
          bodyTokens: body?.children,
        });
      }
    }

    // export? const/let Name = (async)? (params) => {body}
    if (t.type === TokenType.Keyword && (t.value === "const" || t.value === "let" || t.value === "var")) {
      const isExported = i > 0 && tokens[i - 1].type === TokenType.Keyword && tokens[i - 1].value === "export";
      let j = i + 1;
      if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        const name = tokens[j].value;
        j++;
        // Skip = and possible async
        if (j < tokens.length && tokens[j].type === TokenType.Operator && tokens[j].value === "=") {
          j++;
          let isAsync = false;
          if (j < tokens.length && tokens[j].type === TokenType.Keyword && tokens[j].value === "async") { isAsync = true; j++; }
          // Arrow function: (params) =>
          if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "paren") {
            const paramsGroup = tokens[j];
            j++;
            // `(params) =>` or `(params): ReturnType =>` (#1085)
            const arrow = findArrowAfterType(tokens, j);
            if (arrow !== -1) {
              j = arrow + 1;
              const body = (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") ? tokens[j] : null;
              symbols.push({
                name, kind: "function", params: simplifyParams(groupText(paramsGroup), "ts"),
                isExported, isAsync, line: t.line, endLine: body ? bodyEnd(body) : t.line + 1,
              });
            }
          }
          // Object with methods: const Name = { method() {}, ... }
          else if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace" && name[0] === name[0].toUpperCase() && name.length > 2) {
            const body = tokens[j];
            const methods = extractObjectMethods(body, name);
            if (methods.length > 0) {
              symbols.push({
                name, kind: "class", params: `{${methods.length} methods}`,
                isExported, isAsync: false, line: t.line, endLine: bodyEnd(body),
                children: methods.map(m => m.name.split(".").pop() ?? m.name),
              });
              symbols.push(...methods);
            }
          }
        }
      }
    }

    // class Name { ... }
    if (t.type === TokenType.Keyword && t.value === "class") {
      const isExported = i > 0 && tokens[i - 1].type === TokenType.Keyword && tokens[i - 1].value === "export";
      let j = i + 1;
      if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        const name = tokens[j].value;
        j++;
        // Skip extends/implements until we find brace body
        while (j < tokens.length && !(tokens[j].type === TokenType.Group && tokens[j].groupType === "brace")) j++;
        if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") {
          const body = tokens[j];
          symbols.push({
            name, kind: "class", params: "",
            isExported, isAsync: false, line: t.line, endLine: bodyEnd(body),
          });
          // Extract class methods from body
          if (body.children) {
            const inner = significantTokens(body.children);
            for (let k = 0; k < inner.length; k++) {
              if (inner[k].type === TokenType.Identifier && k + 1 < inner.length && inner[k + 1].type === TokenType.Group && inner[k + 1].groupType === "paren") {
                const mName = inner[k].value;
                if (["if", "for", "while", "switch", "catch", "return"].includes(mName)) continue;
                const mParams = groupText(inner[k + 1]);
                const mBody = methodBody(inner, k + 2);
                symbols.push({
                  name: `${name}.${mName}`, kind: "method", params: simplifyParams(mParams, "ts"),
                  isExported: false, isAsync: false, line: inner[k].line, endLine: mBody ? bodyEnd(mBody) : inner[k].line,
                  parent: name,
                });
              }
            }
          }
        }
      }
    }

    // interface/type Name { ... }
    if (t.type === TokenType.Keyword && (t.value === "interface" || t.value === "type")) {
      const j = i + 1;
      if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        const name = tokens[j].value;
        const isExported = i > 0 && tokens[i - 1].type === TokenType.Keyword && tokens[i - 1].value === "export";
        symbols.push({
          name, kind: t.value as "interface" | "type", params: "",
          isExported, isAsync: false, line: t.line, endLine: t.line,
        });
      }
    }
  }

  return symbols;
}

// Extract methods from JS object literal (const Foo = { method() {}, ... })
function extractObjectMethods(body: Token, parentName: string): Symbol[] {
  const methods: Symbol[] = [];
  if (!body.children) return methods;
  const inner = significantTokens(body.children);

  for (let k = 0; k < inner.length; k++) {
    const isAsync = inner[k].type === TokenType.Keyword && inner[k].value === "async";
    if (isAsync) k++;
    if (k >= inner.length) break;

    if (inner[k].type === TokenType.Identifier && k + 1 < inner.length && inner[k + 1].type === TokenType.Group && inner[k + 1].groupType === "paren") {
      const mName = inner[k].value;
      if (["if", "for", "while", "switch", "catch", "return", "handler", "callback", "listener"].includes(mName)) continue;
      const mParams = groupText(inner[k + 1]);
      const mBody = methodBody(inner, k + 2);
      methods.push({
        name: `${parentName}.${mName}`, kind: "method", params: simplifyParams(mParams, "ts"),
        isExported: false, isAsync, line: inner[k].line, endLine: mBody ? bodyEnd(mBody) : inner[k].line,
        parent: parentName,
      });
    }
  }
  return methods;
}

// ============ Rust ============

function extractRust(tokens: Token[]): Symbol[] {
  const symbols: Symbol[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // pub? fn name(params) { body }
    if (t.type === TokenType.Keyword && (t.value === "fn" || t.value === "pub" || t.value === "async")) {
      let isExported = false;
      let isAsync = false;
      let j = i;
      if (t.value === "pub") { isExported = true; j++; }
      if (j < tokens.length && tokens[j].type === TokenType.Keyword && tokens[j].value === "async") { isAsync = true; j++; }
      if (j < tokens.length && tokens[j].type === TokenType.Keyword && tokens[j].value === "fn") {
        j++;
        if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
          const name = tokens[j].value;
          j++;
          // Skip generics
          if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "angle") j++;
          // Params
          let params = "";
          if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "paren") {
            params = groupText(tokens[j]);
            j++;
          }
          // Skip return type and where clause — find brace body
          while (j < tokens.length && !(tokens[j].type === TokenType.Group && tokens[j].groupType === "brace")) j++;
          const body = j < tokens.length ? tokens[j] : null;
          symbols.push({
            name, kind: "function", params: simplifyParams(params, "rs"),
            isExported, isAsync, line: t.line, endLine: body ? bodyEnd(body) : t.line,
          });
        }
      }
    }

    // pub? struct/enum Name { ... }
    if (t.type === TokenType.Keyword && (t.value === "struct" || t.value === "enum")) {
      const isExported = i > 0 && tokens[i - 1].type === TokenType.Keyword && tokens[i - 1].value === "pub";
      const j = i + 1;
      if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        symbols.push({
          name: tokens[j].value, kind: t.value as "struct" | "enum", params: "",
          isExported, isAsync: false, line: t.line, endLine: t.line,
        });
      }
    }

    // impl Name { ... }
    if (t.type === TokenType.Keyword && t.value === "impl") {
      let j = i + 1;
      // Skip generics
      if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "angle") j++;
      if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        // `impl [<…>] Path::Name[<…>] [for Path::Type[<…>]] [where …] { … }` —
        // methods belong to the TYPE after `for`, not to the trait: naming
        // them by the trait collapsed `impl Display for A` and `impl Display
        // for B` into one `Display::fmt` (#1088).
        const readPath = (): string => {
          let last = "";
          while (j < tokens.length) {
            const tok = tokens[j];
            if (tok.type === TokenType.Identifier) { last = tok.value; j++; continue; }
            if (tok.type === TokenType.Operator && (tok.value === "::" || tok.value === "&" || tok.value === "*")) { j++; continue; }
            if (tok.type === TokenType.Group && tok.groupType === "angle") { j++; continue; }
            if (tok.type === TokenType.Keyword && (tok.value === "mut" || tok.value === "dyn")) { j++; continue; }
            break;
          }
          return last;
        };
        let structName = readPath();
        if (j < tokens.length && tokens[j].type === TokenType.Keyword && tokens[j].value === "for") {
          j++;
          structName = readPath() || structName;
        }
        // Skip where clause — find brace body
        while (j < tokens.length && !(tokens[j].type === TokenType.Group && tokens[j].groupType === "brace")) j++;
        if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") {
          // Extract methods inside impl block
          if (tokens[j].children) {
            const implSymbols = extractRust(significantTokens(tokens[j].children ?? []));
            for (const s of implSymbols) {
              if (s.kind === "function") {
                s.kind = "method";
                s.name = `${structName}::${s.name}`;
                s.parent = structName;
              }
              symbols.push(s);
            }
          }
        }
      }
    }

    // trait Name { ... }
    if (t.type === TokenType.Keyword && t.value === "trait") {
      const j = i + 1;
      if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        symbols.push({
          name: tokens[j].value, kind: "trait", params: "",
          isExported: i > 0 && tokens[i - 1].value === "pub",
          isAsync: false, line: t.line, endLine: t.line,
        });
      }
    }
  }

  return symbols;
}

// ============ Python ============

// Python block end by indentation: the block a `def`/`class` header owns runs
// through the last non-blank line indented DEEPER than the header. Blank lines
// never terminate a block (they carry no indent of their own). Without this,
// every Python symbol stored endLine=line, so fn.lines was always 1 — wrecking
// the analysis body window and the stack map's size-based ranking.
function pythonBlockEnd(lines: string[], startLine: number): number {
  const headerIndent = lines[startLine - 1]?.match(/^\s*/)?.[0].length ?? 0;
  let end = startLine;
  for (let ln = startLine + 1; ln <= lines.length; ln++) {
    const text = lines[ln - 1];
    if (text.trim() === "") continue;
    const indent = text.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= headerIndent) break;
    end = ln;
  }
  return end;
}

function extractPython(tokens: Token[], source: string): Symbol[] {
  const symbols: Symbol[] = [];
  const lines = source.split("\n");
  // Python uses indentation, so we track scope from newlines
  let currentClass = "";

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // class Name:
    if (t.type === TokenType.Keyword && t.value === "class") {
      const j = i + 1;
      if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        currentClass = tokens[j].value;
        symbols.push({
          name: currentClass, kind: "class", params: "",
          isExported: !currentClass.startsWith("_"),
          isAsync: false, line: t.line, endLine: pythonBlockEnd(lines, t.line),
        });
      }
    }

    // async? def name(params):
    if (t.type === TokenType.Keyword && (t.value === "def" || t.value === "async")) {
      let isAsync = false;
      let j = i;
      if (t.value === "async") { isAsync = true; j++; }
      if (j < tokens.length && tokens[j].type === TokenType.Keyword && tokens[j].value === "def") {
        j++;
        if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
          const name = tokens[j].value;
          j++;
          let params = "";
          if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "paren") {
            params = groupText(tokens[j]);
          }
          // Check if this is a method (indented under class)
          const lineText = lines[t.line - 1] || "";
          const indent = lineText.match(/^\s*/)?.[0].length || 0;
          const isMethod = indent >= 4 && currentClass;

          symbols.push({
            name: isMethod ? `${currentClass}.${name}` : name,
            kind: isMethod ? "method" : "function",
            params: simplifyParams(params, "py"),
            isExported: !name.startsWith("_"),
            isAsync, line: t.line, endLine: pythonBlockEnd(lines, t.line),
            parent: isMethod ? currentClass : undefined,
          });
        }
      }
    }
  }

  return symbols;
}

// ============ Go ============

function extractGo(tokens: Token[]): Symbol[] {
  const symbols: Symbol[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // func (receiver) Name(params) returns { body }
    // func Name(params) returns { body }
    if (t.type === TokenType.Keyword && t.value === "func") {
      let j = i + 1;
      let receiver = "";

      // Method receiver: (r *Type)
      if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "paren") {
        receiver = groupText(tokens[j]).replace(/^\*/, "").split(/\s+/).pop() || "";
        j++;
      }

      if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        const name = tokens[j].value;
        j++;
        let params = "";
        if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "paren") {
          params = groupText(tokens[j]);
          j++;
        }
        // Skip return type — find brace body
        while (j < tokens.length && !(tokens[j].type === TokenType.Group && tokens[j].groupType === "brace")) j++;
        const body = j < tokens.length ? tokens[j] : null;
        symbols.push({
          name: receiver ? `${receiver}.${name}` : name,
          kind: receiver ? "method" : "function",
          params: simplifyParams(params, "go"),
          isExported: name[0] === name[0].toUpperCase(),
          isAsync: false, line: t.line, endLine: body ? bodyEnd(body) : t.line,
          parent: receiver || undefined,
        });
      }
    }

    // type Name struct/interface { ... }
    if (t.type === TokenType.Keyword && t.value === "type") {
      let j = i + 1;
      if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        const name = tokens[j].value;
        j++;
        if (j < tokens.length && tokens[j].type === TokenType.Keyword && (tokens[j].value === "struct" || tokens[j].value === "interface")) {
          symbols.push({
            name, kind: tokens[j].value as "struct" | "interface", params: "",
            isExported: name[0] === name[0].toUpperCase(),
            isAsync: false, line: t.line, endLine: t.line,
          });
        }
      }
    }
  }

  return symbols;
}
