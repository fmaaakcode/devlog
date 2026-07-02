// Stage 3: Symbol extraction from condensed tokens
// Extracts functions, classes, methods, structs, enums with high accuracy

import { type Token, TokenType, tokenize, condenseBrackets, significantTokens, extractIncludes } from "./tokenizer";

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

// Count lines in a group token (brace body)
function groupLines(group: Token): number {
  if (!group.children) return 1;
  let maxLine = group.line;
  for (const c of group.children) {
    if (c.line > maxLine) maxLine = c.line;
    if (c.children) {
      const inner = groupLines(c);
      if (inner > maxLine) maxLine = inner;
    }
  }
  return maxLine - group.line + 1;
}

// Get text content of a group (for params)
function groupText(group: Token): string {
  if (!group.children) return "";
  return group.children.map(c => {
    if (c.type === TokenType.Group) return `(${groupText(c)})`;
    return c.value;
  }).join(" ").replace(/\s+/g, " ").trim();
}

// Simplify params: strip types, keep names
function simplifyParams(raw: string, ext: string): string {
  if (!raw) return "()";
  if (["ts", "tsx", "js", "jsx"].includes(ext)) {
    // Remove type annotations, keep names
    const parts = raw.split(",").map(p => {
      let clean = p.trim();
      // Remove generics first
      let prev = "";
      while (prev !== clean) { prev = clean; clean = clean.replace(/<[^<>]*>/g, ""); }
      clean = clean.replace(/:\s*.+$/, "").replace(/\s*=\s*.+$/, "").trim();
      return clean;
    }).filter(Boolean);
    return `(${parts.join(", ")})`;
  }
  if (["cpp", "cc", "cxx", "c", "h", "hpp", "hxx", "cu", "cuh"].includes(ext)) {
    const parts = raw.split(",").map(p => {
      const trimmed = p.trim();
      // Last word is usually the param name
      const words = trimmed.split(/\s+/);
      const last = words[words.length - 1]?.replace(/[*&]/, "") || "";
      return last;
    }).filter(p => p && p !== "void" && p !== "const");
    return `(${parts.join(", ")})`;
  }
  if (ext === "rs") {
    const parts = raw.split(",").map(p => {
      const trimmed = p.trim();
      const name = trimmed.split(":")[0]?.trim().replace(/^&?\s*(?:mut\s+)?/, "");
      return name;
    }).filter(p => p && p !== "self" && p !== "&self" && p !== "&mut self");
    return `(${parts.join(", ")})`;
  }
  if (ext === "py") {
    const parts = raw.split(",").map(p => {
      return p.trim().split(":")[0]?.split("=")[0]?.trim();
    }).filter(p => p && p !== "self" && p !== "cls");
    return `(${parts.join(", ")})`;
  }
  return `(${raw})`;
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
        // Body (brace group) — skip return type annotations until we find brace
        while (j < tokens.length && !(tokens[j].type === TokenType.Group && tokens[j].groupType === "brace")) j++;
        const bodyLines = (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") ? groupLines(tokens[j]) : 0;
        const endLine = t.line + bodyLines;

        symbols.push({
          name, kind: "function", params: simplifyParams(params, "ts"),
          isExported, isAsync, line: t.line, endLine,
          bodyTokens: j < tokens.length ? tokens[j].children : undefined,
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
            // Skip type annotation
            while (j < tokens.length && tokens[j].type !== TokenType.Operator) j++;
            if (j < tokens.length && tokens[j].type === TokenType.Operator && tokens[j].value === "=>") {
              j++;
              let bodyLines = 1;
              if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") {
                bodyLines = groupLines(tokens[j]);
              }
              symbols.push({
                name, kind: "function", params: simplifyParams(groupText(paramsGroup), "ts"),
                isExported, isAsync, line: t.line, endLine: t.line + bodyLines,
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
                isExported, isAsync: false, line: t.line, endLine: t.line + groupLines(body),
                children: methods.map(m => m.name.split(".").pop()!),
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
            isExported, isAsync: false, line: t.line, endLine: t.line + groupLines(body),
          });
          // Extract class methods from body
          if (body.children) {
            const inner = significantTokens(body.children);
            for (let k = 0; k < inner.length; k++) {
              if (inner[k].type === TokenType.Identifier && k + 1 < inner.length && inner[k + 1].type === TokenType.Group && inner[k + 1].groupType === "paren") {
                const mName = inner[k].value;
                if (["if", "for", "while", "switch", "catch", "return"].includes(mName)) continue;
                const mParams = groupText(inner[k + 1]);
                let mLines = 0;
                if (k + 2 < inner.length && inner[k + 2].type === TokenType.Group && inner[k + 2].groupType === "brace") {
                  mLines = groupLines(inner[k + 2]);
                }
                symbols.push({
                  name: `${name}.${mName}`, kind: "method", params: simplifyParams(mParams, "ts"),
                  isExported: false, isAsync: false, line: inner[k].line, endLine: inner[k].line + mLines,
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
      let mLines = 0;
      if (k + 2 < inner.length && inner[k + 2].type === TokenType.Group && inner[k + 2].groupType === "brace") {
        mLines = groupLines(inner[k + 2]);
      }
      methods.push({
        name: `${parentName}.${mName}`, kind: "method", params: simplifyParams(mParams, "ts"),
        isExported: false, isAsync, line: inner[k].line, endLine: inner[k].line + mLines,
        parent: parentName,
      });
    }
  }
  return methods;
}

// ============ C/C++ ============

function extractCpp(tokens: Token[]): Symbol[] {
  const symbols: Symbol[] = [];
  const typeKeywords = new Set(["void", "int", "bool", "char", "float", "double", "long", "short", "unsigned", "signed", "auto", "const", "static", "extern", "virtual", "inline", "explicit", "constexpr", "HRESULT", "LRESULT", "BOOL", "DWORD", "HWND", "HANDLE", "LPVOID", "SOCKET", "ComPtr", "size_t"]);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

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
          const sym: Symbol = {
            name, kind: t.value as "class" | "struct", params: "",
            isExported: true, isAsync: false, line: t.line, endLine: t.line + groupLines(body),
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
                sym.children!.push(mName);
                // Check if has body (definition) or just declaration
                let mLines = 0;
                if (k + 2 < inner.length && inner[k + 2].type === TokenType.Group && inner[k + 2].groupType === "brace") {
                  mLines = groupLines(inner[k + 2]);
                }
                symbols.push({
                  name: `${name}::${mName}`, kind: "method",
                  params: simplifyParams(groupText(inner[k + 1]), "cpp"),
                  isExported: true, isAsync: false, line: inner[k].line, endLine: inner[k].line + mLines,
                  parent: name,
                });
              }
            }
          }
          symbols.push(sym);
        }
      }
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
    }

    // Type ClassName::MethodName(params) { body } — out-of-class definition
    if ((t.type === TokenType.Identifier || t.type === TokenType.Keyword) && isTypeToken(t, typeKeywords)) {
      let j = i + 1;
      // Skip pointer/ref qualifiers and type keywords (but NOT PascalCase identifiers followed by ::)
      while (j < tokens.length && (
        (tokens[j].type === TokenType.Operator && ["*", "&"].includes(tokens[j].value)) ||
        (tokens[j].type === TokenType.Keyword && typeKeywords.has(tokens[j].value)) ||
        (tokens[j].type === TokenType.Group && tokens[j].groupType === "angle")
      )) j++;

      // ClassName::MethodName
      if (j + 2 < tokens.length && tokens[j].type === TokenType.Identifier && tokens[j + 1].type === TokenType.Operator && tokens[j + 1].value === "::" && tokens[j + 2].type === TokenType.Identifier) {
        const className = tokens[j].value;
        const methodName = tokens[j + 2].value;
        j += 3;
        // Skip template params
        if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "angle") j++;
        // (params)
        if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "paren") {
          const params = groupText(tokens[j]);
          j++;
          // Skip const/override/noexcept
          while (j < tokens.length && tokens[j].type === TokenType.Keyword && ["const", "override", "noexcept"].includes(tokens[j].value)) j++;
          // {body}
          let bodyLines = 0;
          if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") {
            bodyLines = groupLines(tokens[j]);
          }
          // Skip if already found from class body
          if (!symbols.some(s => s.name === `${className}::${methodName}` && s.endLine > s.line)) {
            symbols.push({
              name: `${className}::${methodName}`, kind: "method",
              params: simplifyParams(params, "cpp"),
              isExported: true, isAsync: false, line: t.line, endLine: t.line + bodyLines,
              parent: className,
            });
          } else {
            // Update line count for existing declaration
            const existing = symbols.find(s => s.name === `${className}::${methodName}`);
            if (existing && bodyLines > 0) { existing.endLine = t.line + bodyLines; }
          }
        }
      }
      // Top-level function: Type FuncName(params) { body }
      else if (j < tokens.length && tokens[j].type === TokenType.Identifier) {
        const funcName = tokens[j].value;
        if (["if", "for", "while", "switch", "catch", "return", "else", "sizeof", "typeof"].includes(funcName)) continue;
        j++;
        if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "paren") {
          const params = groupText(tokens[j]);
          j++;
          while (j < tokens.length && tokens[j].type === TokenType.Keyword) j++;
          let bodyLines = 0;
          if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") {
            bodyLines = groupLines(tokens[j]);
          }
          if (bodyLines > 0 && !symbols.some(s => s.name.endsWith(`::${funcName}`))) {
            symbols.push({
              name: funcName, kind: "function",
              params: simplifyParams(params, "cpp"),
              isExported: true, isAsync: false, line: t.line, endLine: t.line + bodyLines,
            });
          }
        }
      }
    }

    // template<...> — skip, the next symbol will be captured
    if (t.type === TokenType.Keyword && t.value === "template") {
      if (i + 1 < tokens.length && tokens[i + 1].type === TokenType.Group && tokens[i + 1].groupType === "angle") {
        i++; // skip the angle group, let next iteration capture the class/function
      }
    }
  }

  return symbols;
}

function isTypeToken(t: Token, typeKeywords: Set<string>): boolean {
  return (t.type === TokenType.Keyword && typeKeywords.has(t.value)) || (t.type === TokenType.Identifier && /^[A-Z]/.test(t.value));
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
          let bodyLines = 0;
          if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") {
            bodyLines = groupLines(tokens[j]);
          }
          symbols.push({
            name, kind: "function", params: simplifyParams(params, "rs"),
            isExported, isAsync, line: t.line, endLine: t.line + bodyLines,
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
        const structName = tokens[j].value;
        j++;
        // Skip for Trait — find brace body
        while (j < tokens.length && !(tokens[j].type === TokenType.Group && tokens[j].groupType === "brace")) j++;
        if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") {
          // Extract methods inside impl block
          if (tokens[j].children) {
            const implSymbols = extractRust(significantTokens(tokens[j].children!));
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

function extractPython(tokens: Token[], source: string): Symbol[] {
  const symbols: Symbol[] = [];
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
          isAsync: false, line: t.line, endLine: t.line,
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
          const lineText = source.split("\n")[t.line - 1] || "";
          const indent = lineText.match(/^\s*/)?.[0].length || 0;
          const isMethod = indent >= 4 && currentClass;

          symbols.push({
            name: isMethod ? `${currentClass}.${name}` : name,
            kind: isMethod ? "method" : "function",
            params: simplifyParams(params, "py"),
            isExported: !name.startsWith("_"),
            isAsync, line: t.line, endLine: t.line,
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
        let bodyLines = 0;
        if (j < tokens.length && tokens[j].type === TokenType.Group && tokens[j].groupType === "brace") {
          bodyLines = groupLines(tokens[j]);
        }
        symbols.push({
          name: receiver ? `${receiver}.${name}` : name,
          kind: receiver ? "method" : "function",
          params: simplifyParams(params, "go"),
          isExported: name[0] === name[0].toUpperCase(),
          isAsync: false, line: t.line, endLine: t.line + bodyLines,
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
