import { readdir } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import { extractSymbols, type Symbol as CodeSymbol } from "./symbols";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", "target", "vendor", ".venv", "venv", "cache", "tmp", "temp", ".cache", ".tmp", "release", "debug", ".devlog", ".claude", "backup", "old", "doc", "docs", "documentation", "examples", "example", "samples", "fixtures", "test", "tests", "__tests__", "external", "third_party", "thirdparty", "3rdparty", "deps", "lib"]);
const SOURCE_EXT = new Set(["ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "kt", "cs", "cpp", "c", "cc", "cxx", "h", "hpp", "hxx", "rb", "php", "swift", "dart", "vue", "svelte", "css", "html", "htm", "cu", "cuh"]);

export interface FunctionInfo {
  name: string;
  params: string;
  isAsync: boolean;
  isExported: boolean;
  lines: number;         // line count of function body
  calls: string[];       // functions it calls
  reads: string[];       // what it reads (files, data)
  writes: string[];      // what it writes (files, responses)
  description: string;   // auto-generated
}

export interface FileAnalysis {
  path: string;
  lines: number;
  imports: string[];
  exports: string[];
  functions: FunctionInfo[];
  patterns: string[];
  routes: string[];
  context: "server" | "client" | "shared" | "unknown";
  description: string;
}

export interface ThreadInfo {
  name: string;       // descriptive name
  file: string;       // source file
  purpose: string;    // what it does
}

export interface IPCMessage {
  direction: "js→native" | "native→js";
  name: string;
  file: string;
}

export interface DataType {
  name: string;
  kind: "struct" | "enum" | "interface" | "type" | "class";
  fields: string[];   // field names or enum variants
  file: string;
}

export interface SecurityPattern {
  type: string;       // sanitize, escape, CSP, CORS, auth, etc.
  location: string;   // file:function
}

export interface ProjectAnalysis {
  files: FileAnalysis[];
  totalLines: number;
  totalFunctions: number;
  entryPoints: string[];
  graph: Record<string, string[]>;
  callGraph: { caller: string; callee: string; file: string }[];
  apiRoutes: { method: string; path: string; file: string }[];
  patterns: string[];
  fileRanks: Record<string, number>;
  fnRanks: Record<string, number>;
  threads: ThreadInfo[];
  ipcMessages: IPCMessage[];
  dataTypes: DataType[];
  security: SecurityPattern[];
}

async function collectSourceFiles(dir: string, base: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  const files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await collectSourceFiles(full, base, depth + 1));
      } else {
        // Skip minified, bundled, and map files
        if (/\.min\.\w+$|\.bundle\.\w+$|\.map$|\.d\.ts$/i.test(entry.name)) continue;
        const ext = extname(entry.name).toLowerCase().replace(".", "");
        if (SOURCE_EXT.has(ext)) files.push(full);
      }
    }
  } catch {}
  return files;
}

function extractImports(content: string, ext: string): string[] {
  const imports: string[] = [];
  if (["ts", "tsx", "js", "jsx", "vue", "svelte"].includes(ext)) {
    for (const m of content.matchAll(/(?:import|export)\s+.*?\s+from\s+['"](\.[^'"]+)['"]/g)) {
      imports.push(m[1]);
    }
    for (const m of content.matchAll(/require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      imports.push(m[1]);
    }
  } else if (ext === "py") {
    for (const m of content.matchAll(/^(?:from|import)\s+(\S+)/gm)) {
      if (!m[1].startsWith("__")) imports.push(m[1]);
    }
  } else if (ext === "rs") {
    for (const m of content.matchAll(/^(?:mod|use)\s+(?:crate::)?(\w+)/gm)) {
      imports.push(m[1]);
    }
  } else if (ext === "go") {
    for (const m of content.matchAll(/import\s+(?:\w+\s+)?["']([^"']+)["']/g)) {
      imports.push(m[1]);
    }
  } else if (["cpp", "cc", "cxx", "c", "h", "hpp", "hxx", "cu", "cuh"].includes(ext)) {
    // C/C++: #include "local.h" (not <system>)
    for (const m of content.matchAll(/^#include\s+"([^"]+)"/gm)) {
      imports.push(m[1]);
    }
  }
  return imports;
}

function extractExports(content: string, ext: string): string[] {
  const exports: string[] = [];
  if (["ts", "tsx", "js", "jsx"].includes(ext)) {
    for (const m of content.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+(\w+)/g)) {
      exports.push(m[1]);
    }
    for (const m of content.matchAll(/export\s+default\s+(?:function|class)\s+(\w+)/g)) {
      exports.push(`${m[1]} (default)`);
    }
    // Detect non-exported classes (common in client JS)
    for (const m of content.matchAll(/^class\s+(\w+)/gm)) {
      if (!exports.includes(m[1])) exports.push(m[1]);
    }
    // Detect object literals assigned to const (WidgetRegistry = { ... })
    for (const m of content.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*\{/gm)) {
      const name = m[1];
      // Only if it looks like a module/class (PascalCase or has methods)
      if (name[0] === name[0].toUpperCase() && name.length > 3 && !exports.includes(name)) {
        exports.push(name);
      }
    }
  } else if (ext === "py") {
    for (const m of content.matchAll(/^(?:def|class)\s+(\w+)/gm)) {
      if (!m[1].startsWith("_")) exports.push(m[1]);
    }
  } else if (ext === "rs") {
    for (const m of content.matchAll(/^pub\s+(?:fn|struct|enum|trait|type|mod)\s+(\w+)/gm)) {
      exports.push(m[1]);
    }
  } else if (ext === "go") {
    for (const m of content.matchAll(/^func\s+(\w+)/gm)) {
      if (m[1][0] === m[1][0].toUpperCase()) exports.push(m[1]);
    }
  } else if (["cpp", "cc", "cxx", "c", "h", "hpp", "hxx", "cu", "cuh"].includes(ext)) {
    // C++: class declarations
    for (const m of content.matchAll(/^class\s+(\w+)\s*(?::\s*(?:public|private|protected)\s+\w+)?\s*\{/gm)) {
      exports.push(m[1]);
    }
    // C++: top-level functions (return_type name(...))
    const cppTypes = "(?:void|int|bool|float|double|char|auto|size_t|uint\\w+|int\\w+|std::\\w+|HRESULT|LRESULT|BOOL|DWORD|string|wstring|vector|unique_ptr|shared_ptr|\\w+_t)";
    const fnPattern = new RegExp(`^${cppTypes}\\*?\\s+(?:\\w+::)?(\\w+)\\s*\\(`, "gm");
    for (const m of content.matchAll(fnPattern)) {
      if (!["if", "for", "while", "switch", "return", "main"].includes(m[1]) && !exports.includes(m[1])) {
        exports.push(m[1]);
      }
    }
    // C++: struct/enum
    for (const m of content.matchAll(/^(?:struct|enum(?:\s+class)?)\s+(\w+)/gm)) {
      if (!exports.includes(m[1])) exports.push(m[1]);
    }
  }
  return exports;
}

// Detect if file is client-side (browser), server-side, or shared
function detectContext(content: string, filePath: string): "server" | "client" | "shared" | "unknown" {
  const clientSignals = (content.match(/document\.|window\.|localStorage|sessionStorage|navigator\.|getElementById|querySelector|addEventListener|innerHTML|classList|\.style\.|DOM|onclick|onload/g) || []).length;
  const serverSignals = (content.match(/Bun\.|process\.|require\(|createServer|\.listen\(|readFile|writeFile|readdir|spawn|exec\(|\.env\b/g) || []).length;

  // Path hints
  const pathLower = filePath.toLowerCase();
  if (/public\/|static\/|client\/|frontend\/|www\/|assets\//.test(pathLower)) return "client";
  if (/server\/|api\/|backend\/|routes\/|middleware\//.test(pathLower)) return "server";

  // C/C++ files are never "client" (browser)
  const isCpp = ["cpp", "cc", "cxx", "c", "h", "hpp", "hxx", "cu", "cuh"].includes(filePath.split(".").pop()?.toLowerCase() || "");
  if (isCpp) return serverSignals > 0 ? "server" : "unknown";

  if (clientSignals > 3 && serverSignals === 0) return "client";
  if (serverSignals > 3 && clientSignals === 0) return "server";
  if (clientSignals > 0 && serverSignals > 0) return "shared";
  return "unknown";
}

// Detect if file is a third-party library (minified or very long single lines)
function isLibraryFile(content: string, filePath: string): boolean {
  if (/vendor\/|lib\/|third.?party/i.test(filePath)) return true;
  const lines = content.split("\n");
  // Very long average line = probably minified/bundled
  if (lines.length < 10 && content.length > 5000) return true;
  // Has source map reference
  if (/\/\/[#@]\s*sourceMappingURL/.test(content)) return true;
  return false;
}


// Extract function calls from a body
function extractCalls(body: string, knownFunctions: Set<string>): string[] {
  const calls = new Set<string>();
  // Skip common method names that aren't real function calls
  const skipNames = new Set([
    "if", "for", "while", "switch", "catch", "return", "new", "typeof", "import", "require",
    "Set", "Map", "Array", "Object", "String", "Number", "Date", "Math", "JSON", "console",
    "setTimeout", "setInterval", "clearTimeout", "clearInterval", "parseInt", "parseFloat",
    "Promise", "Response", "Error", "RegExp", "Boolean", "Symbol", "Proxy", "Reflect",
    // Common method names that appear as .method() — not standalone calls
    "file", "text", "write", "read", "json", "exists", "push", "pop", "shift", "unshift",
    "map", "filter", "reduce", "find", "findIndex", "findLast", "findLastIndex", "some", "every",
    "forEach", "includes", "indexOf", "slice", "splice", "sort", "reverse", "join", "split",
    "replace", "replaceAll", "match", "matchAll", "test", "exec", "trim", "toLowerCase", "toUpperCase",
    "startsWith", "endsWith", "keys", "values", "entries", "assign", "freeze", "create",
    "now", "parse", "stringify", "toString", "valueOf", "hasOwnProperty", "isArray",
    "from", "of", "all", "race", "resolve", "reject", "then", "catch", "finally",
    "log", "warn", "error", "info", "debug", "dir", "table",
    "send", "close", "add", "delete", "has", "get", "set", "clear",
    "encode", "decode", "abort", "emit", "on", "off", "once", "removeListener",
  ]);
  for (const m of body.matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)) {
    const name = m[1];
    if (skipNames.has(name)) continue;
    // Skip if preceded by . (it's a method call, not a function call)
    const idx = m.index || 0;
    if (idx > 0 && body[idx - 1] === ".") continue;
    if (knownFunctions.has(name)) calls.add(name);
  }
  return [...calls];
}

// What does the function read?
function extractReads(body: string): string[] {
  const reads: string[] = [];
  if (/loadData|readFile|Bun\.file.*text|\.json\(\)/.test(body)) reads.push("data");
  if (/req\.json|req\.body|body\./.test(body)) reads.push("request");
  if (/readdir/.test(body)) reads.push("filesystem");
  if (/\.exists\(\)/.test(body)) reads.push("file check");
  if (/process\.env|Bun\.env/.test(body)) reads.push("env");
  return reads;
}

// What does the function write?
function extractWrites(body: string): string[] {
  const writes: string[] = [];
  if (/saveData|Bun\.write|writeFile/.test(body)) writes.push("data");
  if (/Response\.json|return.*Response|res\.json|res\.send/.test(body)) writes.push("response");
  if (/broadcast\(/.test(body)) writes.push("websocket");
  if (/console\.log/.test(body)) writes.push("console");
  if (/\.push\(|\.splice\(|\.filter\(.*=/.test(body)) writes.push("array mutation");
  return writes;
}

// Summarize function params

// Auto-describe a function based on what it does
function describeFn(name: string, body: string, _params: string, reads: string[], writes: string[], _calls: string[]): string {
  // Route handler?
  if (/req\.json|req\.params|req\.query/.test(body) && /Response\.json/.test(body)) {
    if (/saveData/.test(body) && /broadcast/.test(body)) return "يستقبل بيانات، يحفظها، ويبث التحديث";
    if (/saveData/.test(body)) return "يستقبل بيانات ويحفظها";
    if (/loadData/.test(body)) return "يقرأ البيانات ويرجعها";
    return "يعالج طلب API";
  }

  // Scanner/walker?
  if (/readdir/.test(body) && /walk|recursive|depth/.test(body)) return "يمسح المجلدات بشكل متكرر";
  if (/readdir/.test(body)) return "يقرأ محتويات مجلد";

  // Parser?
  if (/match|matchAll|RegExp|\.exec/.test(body) && /push/.test(body)) return "يحلل ويستخرج بيانات";

  // Generator/builder?
  if (/lines\.push|\.join.*\\n|\.write/.test(body) && /mkdir/.test(body)) return "يولّد ملف";
  if (/lines\.push|\.join.*\\n/.test(body)) return "يبني محتوى نصي";

  // Writer?
  if (writes.includes("data") && writes.includes("websocket")) return "يحفظ ويبث التحديث";
  if (writes.includes("data")) return "يكتب بيانات";

  // Reader?
  if (reads.includes("data") && !writes.includes("data")) return "يقرأ بيانات";
  if (reads.includes("filesystem")) return "يقرأ نظام الملفات";

  // Matcher/comparator?
  if (/===|!==|includes|startsWith|\.test\(/.test(body) && body.split("\n").length < 10) return "يقارن/يطابق";

  // Name-based hints
  const nameLower = name.toLowerCase();
  if (nameLower.includes("detect")) return "يكشف ويحدد";
  if (nameLower.includes("parse")) return "يحلل ويستخرج بيانات";
  if (nameLower.includes("format") || nameLower.includes("render")) return "يُنسّق للعرض";
  if (nameLower.includes("validate") || nameLower.includes("check")) return "يتحقق من الصحة";
  if (nameLower.includes("convert") || nameLower.includes("transform")) return "يحوّل البيانات";
  if (nameLower.includes("init") || nameLower.includes("setup")) return "يهيّئ ويجهّز";
  if (nameLower.includes("handle") || nameLower.includes("process")) return "يعالج الطلب";
  if (nameLower.includes("export") || nameLower.includes("generate")) return "يولّد مخرجات";
  if (nameLower.includes("scan") || nameLower.includes("collect")) return "يجمع ويمسح";
  if (nameLower.includes("build") || nameLower.includes("create")) return "يبني ويُنشئ";
  if (nameLower.includes("update") || nameLower.includes("patch")) return "يحدّث";
  if (nameLower.includes("delete") || nameLower.includes("remove")) return "يحذف";
  if (nameLower.includes("find") || nameLower.includes("search") || nameLower.includes("get")) return "يبحث ويسترجع";
  if (nameLower.includes("sort") || nameLower.includes("filter")) return "يرتّب/يفلتر";

  // Short utility?
  if (body.split("\n").length <= 3) return "دالة مساعدة";

  return "";
}

function detectPatterns(content: string, _ext: string, ctx: "server" | "client" | "shared" | "unknown"): string[] {
  const patterns: string[] = [];

  // Server-only patterns (don't detect in client code)
  if (ctx !== "client") {
    if (/Bun\.serve\b|createServer\b|app\.listen\b|http\.listen\b/i.test(content)) patterns.push("HTTP Server");
    if (/readFile\b|writeFile\b|readdir\b|Bun\.file\b|Bun\.write\b/i.test(content)) patterns.push("File I/O");
    if (/(?:import|require|from)\s+['"](?:.*(?:sqlite|postgres|mysql|mongodb|redis|prisma|drizzle))/i.test(content) || /new\s+(?:Database|Pool|Client)\s*\(/i.test(content)) patterns.push("Database");
    if (/(?:import|require|from)\s+['"](?:.*(?:jwt|bcrypt|passport|auth))/i.test(content) || /verify(?:Token|JWT|Session)\b/i.test(content)) patterns.push("Auth");
    if (/(?:createHash|encrypt|decrypt)\s*\(/i.test(content)) patterns.push("Crypto");
    if (/(?:process\.argv|Bun\.argv)\b/.test(content) || /(?:import|require).*(?:commander|yargs|argparse)/.test(content)) patterns.push("CLI");
  }

  // Client-only patterns
  if (ctx !== "server") {
    if (/document\.|querySelector|getElementById|innerHTML/.test(content)) patterns.push("DOM");
    if (/canvas|getContext\s*\(\s*['"]2d|WebGL/i.test(content)) patterns.push("Canvas");
  }

  // Context-independent patterns
  if (/new\s+WebSocket\b|Bun\.serve.*websocket|\.upgrade\s*\(/i.test(content)) patterns.push("WebSocket");
  if (/JSON\.parse|JSON\.stringify/i.test(content)) patterns.push("JSON");

  // IPC / Process communication (exclude WebSocket postMessage)
  if (/child_process|(?<!\.)\bspawn\s*\(|(?<!\.)\bexec\s*\(|(?<!\.)\bfork\s*\(|ipcRenderer|ipcMain|Command::new|std::process/i.test(content)) patterns.push("IPC");
  // Threading / Workers
  if (/Worker\b|worker_threads|thread::spawn|std::thread|rayon|tokio::spawn|pthread|Thread\.new|async_std/i.test(content)) patterns.push("Threading");
  // Windows API
  if (/winapi|windows-sys|CreateProcess|HWND|WinUser|kernel32|user32|advapi32|RegOpenKey|HKEY_/i.test(content)) patterns.push("Windows API");
  // OS / System
  if (/std::fs|std::path|std::env|os\.path|pathlib|sys\.platform/i.test(content)) patterns.push("System");
  // Event loop / Async runtime
  if (/tokio|async-std|#\[tokio::main\]|EventLoop|event_loop|select!\s*\{/i.test(content)) patterns.push("Event Loop");
  // Watcher / File monitoring
  if (/notify|FSWatcher|watchFile|inotify|chokidar|file.*watch|watch.*file/i.test(content)) patterns.push("File Watcher");

  // C++ specific patterns
  if (/NVENC|nvEncodeAPI|NvEncoder|nvcuvid|NVDEC/i.test(content)) patterns.push("NVENC/NVDEC");
  if (/DXGI|IDXGIOutputDuplication|D3D11|ID3D11Device|DirectX/i.test(content)) patterns.push("DXGI/DirectX");
  if (/WASAPI|IAudioClient|IAudioCaptureClient|IAudioRenderClient/i.test(content)) patterns.push("WASAPI");
  if (/opus_encode|opus_decode|OpusEncoder|OpusDecoder/i.test(content)) patterns.push("Opus");
  if (/libsodium|crypto_box|crypto_secretbox|sodium_init|crypto_aead/i.test(content)) patterns.push("E2E Encryption");
  if (/\bSOCKET\b|WSAStartup|sendto\s*\(|recvfrom\s*\(|SOCK_DGRAM|\bUDP\b(?!\/)|(?<!web|Web)socket\s*\(/i.test(content)) patterns.push("UDP/Networking");
  if (/STUN|stun_|hole_punch|nat_traversal/i.test(content)) patterns.push("STUN/NAT");
  if (/FEC|fec_encode|fec_decode|forward_error/i.test(content)) patterns.push("FEC");
  if (/IOCP|CreateIoCompletionPort|GetQueuedCompletionStatus/i.test(content)) patterns.push("IOCP");
  if (/cuda|__global__|cudaMalloc|cudaMemcpy|cublas|cusparse/i.test(content)) patterns.push("CUDA");
  if (/Qt\w+|QApplication|QWidget|QMainWindow|Q_OBJECT/i.test(content)) patterns.push("Qt");
  if (/CMakeLists|cmake_minimum_required|find_package|target_link/i.test(content)) patterns.push("CMake");
  if (/OpenGL|glfw|GLEW|glBindBuffer|glDraw/i.test(content)) patterns.push("OpenGL");
  if (/Vulkan|vkCreate|VkInstance|VkDevice/i.test(content)) patterns.push("Vulkan");

  return [...new Set(patterns)];
}

function extractRoutes(content: string): { method: string; path: string }[] {
  const routes: { method: string; path: string }[] = [];
  for (const m of content.matchAll(/"(\/(?:api|ws)[a-zA-Z0-9_/:.-]*)":\s*\{\s*(?:async\s+)?(GET|POST|PUT|DELETE|PATCH)/g)) {
    if (!routes.some(r => r.path === m[1] && r.method === m[2])) {
      routes.push({ method: m[2], path: m[1] });
    }
  }
  for (const m of content.matchAll(/\.(get|post|put|delete|patch)\s*\(\s*['"](\/[^'"]+)['"]/gi)) {
    routes.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  for (const m of content.matchAll(/@(?:app|router)\.(get|post|put|delete|route)\s*\(\s*['"](\/[^'"]+)['"]/gi)) {
    routes.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return routes;
}

// Smart file description
function describeFile(fa: FileAnalysis): string {
  const fullName = fa.path.split("/").pop() || "";
  const ext = fullName.split(".").pop()?.toLowerCase() || "";
  const name = fullName.replace(/\.\w+$/, "");

  // Non-code files
  if (ext === "css") return `أنماط CSS${fa.lines > 500 ? ` (${fa.lines} سطر)` : ""}`;
  if (ext === "html" || ext === "htm") return `صفحة HTML${fa.lines > 100 ? " (تطبيق)" : ""}`;
  const nameHints: Record<string, string> = {
    server: "الراوتر الرئيسي", router: "الراوتر", data: "إدارة البيانات (تحميل/حفظ)",
    broadcast: "بث WebSocket للعملاء", scanner: "مسح المشروع وكشف اللغة والمكتبات",
    hooks: "تحليل أحداث Claude Code hooks", export: "تصدير التقارير (status, changelog, stack)",
    tree: "بناء شجرة الملفات مع .devignore", plans: "تحليل خطط Markdown",
    types: "تعريف الأنواع (interfaces)", analyze: "تحليل عميق للكود (imports, exports, routes)",
    index: "نقطة الدخول", main: "نقطة الدخول", app: "التطبيق الرئيسي",
    config: "الإعدادات", utils: "دوال مساعدة", helpers: "دوال مساعدة",
    middleware: "middleware", auth: "المصادقة والصلاحيات",
    db: "اتصال قاعدة البيانات", database: "اتصال قاعدة البيانات",
    model: "نماذج البيانات", models: "نماذج البيانات", schema: "مخطط البيانات",
    test: "اختبارات", spec: "اختبارات",
    widgets: "نظام الودجتات", widget: "ودجت",
    style: "الأنماط (CSS)", styles: "الأنماط (CSS)",
    theme: "نظام الثيمات", themes: "نظام الثيمات",
    layout: "التخطيط والتوزيع",
    state: "إدارة الحالة", store: "إدارة الحالة",
    api: "طبقة الاتصال بالـ API", service: "طبقة الخدمات",
    worker: "عملية خلفية (Worker)", logger: "نظام التسجيل",
    cache: "نظام التخزين المؤقت", queue: "نظام الطوابير",
    usage: "معلومات الاستخدام", cli: "واجهة سطر الأوامر",
  };
  const hint = nameHints[name.toLowerCase()];
  if (hint) {
    const extras: string[] = [];
    if (fa.routes.length > 0) extras.push(`${fa.routes.length} endpoint`);
    if (fa.functions.length > 0) extras.push(`${fa.functions.length} دالة`);
    return extras.length > 0 ? `${hint} (${extras.join(", ")})` : hint;
  }
  // Context-aware fallback
  const parts: string[] = [];
  if (fa.context === "client") parts.push("واجهة مستخدم");
  if (fa.routes.length > 0) parts.push(`${fa.routes.length} endpoint`);
  if (fa.context !== "client" && fa.patterns.includes("HTTP Server")) parts.push("سيرفر");
  if (fa.patterns.includes("WebSocket")) parts.push("WebSocket");
  if (fa.patterns.includes("Database")) parts.push("قاعدة بيانات");
  if (fa.patterns.includes("Auth")) parts.push("مصادقة");
  if (fa.patterns.includes("DOM") && !parts.includes("واجهة مستخدم")) parts.push("واجهة مستخدم");
  if (parts.length > 0) return parts.join(" + ");
  if (fa.exports.length > 0) return fa.exports.slice(0, 3).join(", ");
  return "—";
}

// Detect threads/workers from code
function extractThreads(content: string, filePath: string): ThreadInfo[] {
  const threads: ThreadInfo[] = [];
  const file = filePath.split("/").pop() || filePath;
  const seen = new Set<string>();

  // Rust: thread::spawn / tokio::spawn
  for (const m of content.matchAll(/(?:thread::spawn|tokio::spawn|std::thread::spawn)\s*\(\s*(?:move\s*)?\|?\|?\s*\{?\s*(?:\/\/\s*(.+))?/g)) {
    const comment = m[1]?.trim() || "";
    const ctx = content.slice(m.index!, Math.min(m.index! + 500, content.length));

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
    const kind = isPersistent ? "دائم" : "مؤقت";

    // Deduplicate by purpose
    const key = `${purpose}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);

    threads.push({ name: `${purpose} (${kind})`, file, purpose });
  }

  // JS: new Worker
  for (const m of content.matchAll(/new\s+Worker\s*\(\s*['"]([^'"]+)['"]/g)) {
    threads.push({ name: m[1], file, purpose: "Web Worker (دائم)" });
  }

  // Python: threading.Thread
  for (const m of content.matchAll(/threading\.Thread\s*\(.*target\s*=\s*(\w+)/g)) {
    threads.push({ name: m[1], file, purpose: "thread" });
  }

  return threads;
}

// Detect IPC messages between JS and native code
function extractIPC(content: string, filePath: string): IPCMessage[] {
  const messages: IPCMessage[] = [];
  const file = filePath.split("/").pop() || filePath;
  const seen = new Set<string>();

  function add(dir: "js→native" | "native→js", name: string) {
    const key = `${dir}:${name}`;
    if (seen.has(key)) return;
    // Skip camelCase names for JS→Native — IPC commands are snake_case/lowercase
    if (dir === "js→native" && /^[a-z]/.test(name) && /[A-Z]/.test(name)) return;
    // Skip very short names (likely variables not commands)
    if (name.length < 3) return;
    // Skip if it's a bare word that already exists as set_xxx/get_xxx (it's a duplicate value, not a command)
    if (dir === "js→native" && !name.includes("_") && (seen.has(`${dir}:set_${name}`) || seen.has(`${dir}:get_${name}`))) return;
    seen.add(key);
    messages.push({ direction: dir, name, file });
  }

  // === Native → JS ===
  // Rust: evaluate_script with format! — evaluate_script(&format!("onXxx({})", data))
  for (const m of content.matchAll(/evaluate_script\s*\(\s*&?\s*format!\s*\(\s*["']\s*(\w+)\s*\(/g)) {
    add("native→js", m[1]);
  }
  // Rust: evaluate_script("functionName(...)") — direct string
  for (const m of content.matchAll(/evaluate_script\s*\(\s*["'&]\s*(\w+)\s*\(/g)) {
    add("native→js", m[1]);
  }
  // Rust: evaluate_script with variable containing function name — look for nearby string assignments
  for (const m of content.matchAll(/let\s+\w+\s*=\s*format!\s*\(\s*["']\s*(\w+)\s*\(/g)) {
    add("native→js", m[1]);
  }
  // Catch: format!("window.xxx(") or format!("xxx(")
  for (const m of content.matchAll(/format!\s*\(\s*["'](?:window\.)?(\w+)\s*\(/g)) {
    if (m[1] !== "format" && m[1] !== "println" && m[1] !== "eprintln" && m[1].length > 2) {
      add("native→js", m[1]);
    }
  }
  // Electron: webContents.send
  for (const m of content.matchAll(/webContents\.send\s*\(\s*['"](\w+)['"]/g)) {
    add("native→js", m[1]);
  }

  // === JS → Native ===
  // Pattern 1: postMessage(JSON.stringify({type/cmd/action: "xxx", ...}))
  for (const m of content.matchAll(/postMessage\s*\(\s*JSON\.stringify\s*\(\s*\{\s*(?:type|cmd|action)\s*:\s*['"](\w+)['"]/g)) {
    add("js→native", m[1]);
  }
  // Pattern 2: helper function call — sendToRust("xxx") / ipcSend("xxx") / send("xxx", ...) where send is IPC
  for (const m of content.matchAll(/(?:sendToRust|ipcSend|sendIPC|sendNative|ipc\.send|invoke|__TAURI_INVOKE__)\s*\(\s*['"](\w+)['"]/g)) {
    add("js→native", m[1]);
  }
  // Pattern 3: postMessage with template literal or variable — postMessage(`{"cmd":"${cmd}"}`)
  for (const m of content.matchAll(/postMessage\s*\(\s*`[^`]*(?:cmd|type|action)["']?\s*:\s*["']?(\w+)/g)) {
    add("js→native", m[1]);
  }
  // Pattern 4: JSON.stringify({cmd: "command_name"}) — only snake_case near ipc.postMessage
  for (const m of content.matchAll(/(?:type|cmd|action)\s*:\s*['"](\w+)['"]\s*[,}]/g)) {
    const name = m[1];
    // Only snake_case or lowercase commands (not camelCase property names)
    if (/[A-Z]/.test(name[0]) || (/[a-z]/.test(name[0]) && /[A-Z]/.test(name))) continue;
    const before = content.slice(Math.max(0, m.index! - 150), m.index!);
    const after = content.slice(m.index!, Math.min(m.index! + 150, content.length));
    if (/ipc\.postMessage|ipc\.send|invoke\(/i.test(before + after)) {
      add("js→native", name);
    }
  }
  // Pattern 5: Wry/Tauri handler match — "xxx" => { ... } (within ipc context)
  for (const m of content.matchAll(/["'](\w+)["']\s*=>\s*\{/g)) {
    const before = content.slice(Math.max(0, m.index! - 300), m.index!);
    if (/ipc|handler|command|invoke|match\s+\w*cmd|match\s+\w*action|match\s+\w*type/i.test(before)) {
      add("js→native", m[1]);
    }
  }
  // Pattern 6: Electron IPC
  for (const m of content.matchAll(/ipc(?:Renderer|Main)\.(?:send|on|handle)\s*\(\s*['"](\w+)['"]/g)) {
    add("js→native", m[1]);
  }
  // Pattern 7: window.chrome.webview.postMessage
  for (const m of content.matchAll(/window\.chrome\.webview\.postMessage\s*\(\s*(?:JSON\.stringify\s*\(\s*)?['"]?(\w+)/g)) {
    add("js→native", m[1]);
  }

  // Pattern 8: Direct ipc.postMessage("command") or ipc.postMessage("command:data")
  for (const m of content.matchAll(/ipc\.postMessage\s*\(\s*['"`](\w+)/g)) {
    add("js→native", m[1]);
  }
  // Pattern 9: ipc.postMessage with concatenation — ipc.postMessage("command:" + data)
  for (const m of content.matchAll(/ipc\.postMessage\s*\(\s*['"](\w+)['":\s]*\+/g)) {
    add("js→native", m[1]);
  }
  // Pattern 9b: ipc.postMessage(`command:${data}`) — template literal
  for (const m of content.matchAll(/ipc\.postMessage\s*\(\s*`(\w+)/g)) {
    add("js→native", m[1]);
  }
  // Pattern 9c: variable then postMessage — const msg = "command:..." ; ipc.postMessage(msg)
  // or: ipc.postMessage(varName) where varName is assigned "command..."
  for (const m of content.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*['"`](\w+)[:'"]/g)) {
    // Check if this variable is used with ipc.postMessage nearby
    const after = content.slice(m.index!, Math.min(m.index! + 500, content.length));
    if (new RegExp(`ipc\\.postMessage\\s*\\(\\s*${m[1]}\\b`).test(after)) {
      add("js→native", m[2]);
    }
  }
  // Pattern 10: Dynamic wrapper — find functions that call ipc.postMessage, then trace calls
  const wrapperNames = new Set<string>();
  for (const m of content.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*\{[^}]*ipc\.postMessage/gs)) {
    wrapperNames.add(m[1]);
  }
  for (const m of content.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?[^)]*\)?\s*=>\s*\{[^}]*ipc\.postMessage/gs)) {
    wrapperNames.add(m[1]);
  }
  for (const wrapperName of wrapperNames) {
    const callPattern = new RegExp(`${wrapperName}\\s*\\(\\s*['"\`]([\\w_]+)`, "g");
    for (const m of content.matchAll(callPattern)) {
      add("js→native", m[1]);
    }
  }

  return messages;
}

// Extract data types (structs, enums, interfaces)
function extractDataTypes(content: string, ext: string, filePath: string): DataType[] {
  const types: DataType[] = [];
  const file = filePath.split("/").pop() || filePath;

  if (ext === "rs") {
    // Rust structs
    for (const m of content.matchAll(/(?:pub\s+)?struct\s+(\w+)\s*\{([^}]*)\}/gs)) {
      const fields = [...m[2].matchAll(/(?:pub\s+)?(\w+)\s*:/g)].map(f => f[1]);
      if (fields.length > 0) types.push({ name: m[1], kind: "struct", fields, file });
    }
    // Rust enums
    for (const m of content.matchAll(/(?:pub\s+)?enum\s+(\w+)\s*\{([^}]*)\}/gs)) {
      const variants = [...m[2].matchAll(/(\w+)/g)].map(v => v[1]).filter(v => v[0] === v[0].toUpperCase());
      if (variants.length > 0) types.push({ name: m[1], kind: "enum", fields: variants, file });
    }
  }

  if (["ts", "tsx"].includes(ext)) {
    // TypeScript interfaces
    for (const m of content.matchAll(/(?:export\s+)?interface\s+(\w+)\s*\{([^}]*)\}/gs)) {
      const fields = [...m[2].matchAll(/(\w+)\s*[?:]?\s*:/g)].map(f => f[1]);
      if (fields.length > 0) types.push({ name: m[1], kind: "interface", fields, file });
    }
    // TypeScript type with object shape
    for (const m of content.matchAll(/(?:export\s+)?type\s+(\w+)\s*=\s*\{([^}]*)\}/gs)) {
      const fields = [...m[2].matchAll(/(\w+)\s*[?:]?\s*:/g)].map(f => f[1]);
      if (fields.length > 0) types.push({ name: m[1], kind: "type", fields, file });
    }
  }

  if (ext === "py") {
    for (const m of content.matchAll(/class\s+(\w+).*?:\s*\n((?:\s+.+\n)*)/g)) {
      const fields = [...m[2].matchAll(/self\.(\w+)\s*=/g)].map(f => f[1]).filter(f => !f.startsWith("_"));
      if (fields.length > 0) types.push({ name: m[1], kind: "class", fields, file });
    }
  }

  if (["cpp", "cc", "cxx", "c", "h", "hpp", "hxx", "cu", "cuh"].includes(ext)) {
    // C++ classes with members
    for (const m of content.matchAll(/^class\s+(\w+)\s*(?::\s*(?:public|private|protected)\s+\w+)?\s*\{([\s\S]*?)\n\};/gm)) {
      const fields: string[] = [];
      // Member variables
      for (const f of m[2].matchAll(/(?:std::\w+|int|bool|float|double|char|string|wstring|vector|unique_ptr|shared_ptr|HWND|HANDLE|\w+_t|\w+Ptr|ComPtr)\s*[<*&]?\s*[>]?\s+(\w+)\s*[;=]/g)) {
        if (!fields.includes(f[1])) fields.push(f[1]);
      }
      // Methods (declarations)
      for (const f of m[2].matchAll(/(?:virtual\s+)?(?:\w+[*&\s]+)(\w+)\s*\(/g)) {
        if (!["if", "for", "while", "return", "class"].includes(f[1]) && !fields.includes(f[1])) {
          fields.push(`${f[1]}()`);
        }
      }
      if (fields.length > 0) types.push({ name: m[1], kind: "class", fields, file });
    }
    // C++ structs
    for (const m of content.matchAll(/^struct\s+(\w+)\s*\{([^}]*)\}/gm)) {
      const fields = [...m[2].matchAll(/(?:\w+[*&\s]+)(\w+)\s*[;=]/g)].map(f => f[1]);
      if (fields.length > 0) types.push({ name: m[1], kind: "struct", fields, file });
    }
    // C++ enums
    for (const m of content.matchAll(/^enum\s+(?:class\s+)?(\w+)\s*(?::\s*\w+)?\s*\{([^}]*)\}/gm)) {
      const variants = [...m[2].matchAll(/(\w+)/g)].map(v => v[1]).filter(v => v[0] === v[0].toUpperCase() || /^[A-Z_]+$/.test(v));
      if (variants.length > 0) types.push({ name: m[1], kind: "enum", fields: variants, file });
    }
  }

  return types;
}

// Detect security patterns (actual usage, not string mentions)
function extractSecurity(content: string, filePath: string): SecurityPattern[] {
  const patterns: SecurityPattern[] = [];
  const file = filePath.split("/").pop() || filePath;
  const ext = file.split(".").pop()?.toLowerCase() || "";

  // XSS: only in web code (JS/TS/HTML), not desktop C++
  if (["js", "jsx", "ts", "tsx", "html", "htm", "py", "rb", "php"].includes(ext)) {
    if (/(?:function|fn|def)\s+(?:sanitize|sanitize_?html|escape_?html|esc)\b/i.test(content) || /(?:sanitize|sanitizeHtml|escapeHtml|esc)\s*\(/i.test(content)) {
      patterns.push({ type: "XSS Protection", location: file });
    }
  }
  // Input validation via sanitize functions
  if (/(?:function|fn|def)\s+(?:sanitize|validate|sanitize_?html)\b/i.test(content)) {
    patterns.push({ type: "Input Validation", location: file });
  }
  // SSRF: URL validation functions
  if (/(?:function|fn|def)\s+is_?safe_?url\b|allowed_?(?:hosts|origins|urls)/i.test(content)) {
    patterns.push({ type: "SSRF Protection", location: file });
  }
  // CSP: only in HTML files (meta tag) or server headers
  if (ext === "html" && /content-security-policy/i.test(content)) {
    patterns.push({ type: "CSP", location: file });
  }
  if (ext !== "html" && /["']Content-Security-Policy["']/i.test(content)) {
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
  // Input validation: actual schema/validate usage
  if (/(?:import|require).*(?:zod|joi|yup|ajv)/i.test(content) || /\.safeParse|\.validate\s*\(/i.test(content)) {
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
  // AEAD Authentication
  if (/AEAD|aead|crypto_aead_|authenticated.*encrypt|GCM|Poly1305/i.test(content)) {
    patterns.push({ type: "AEAD Authentication", location: file });
  }
  // TLS/SSL
  if (/SSL_CTX|SSL_new|openssl|rustls|TlsStream|tls::/i.test(content)) {
    patterns.push({ type: "TLS/SSL", location: file });
  }

  return patterns;
}

export async function analyzeProject(projectPath: string): Promise<ProjectAnalysis> {
  const sourceFiles = await collectSourceFiles(projectPath, projectPath);
  const files: FileAnalysis[] = [];
  const allRoutes: { method: string; path: string; file: string }[] = [];
  const graph: Record<string, string[]> = {};
  const projectPatterns = new Set<string>();
  const callGraphEntries: { caller: string; callee: string; file: string }[] = [];
  const allThreads: ThreadInfo[] = [];
  const allIPC: IPCMessage[] = [];
  const allDataTypes: DataType[] = [];
  const allSecurity: SecurityPattern[] = [];
  let totalLines = 0;
  let totalFunctions = 0;

  // First pass: collect all files, extract symbols via tokenizer, collect function names
  const allFunctionNames = new Set<string>();
  const fileContents: { fullPath: string; rel: string; ext: string; content: string; symbols: CodeSymbol[]; includes: string[] }[] = [];
  for (const fullPath of sourceFiles) {
    const rel = relative(projectPath, fullPath).replace(/\\/g, "/");
    const ext = extname(fullPath).toLowerCase().replace(".", "");
    try {
      const content = await Bun.file(fullPath).text();
      const { symbols, includes } = extractSymbols(content, ext);
      fileContents.push({ fullPath, rel, ext, content, symbols, includes });
      // Collect function names from tokenizer symbols
      for (const s of symbols) {
        const baseName = s.name.includes("::") ? s.name.split("::").pop()! : s.name.includes(".") ? s.name.split(".").pop()! : s.name;
        allFunctionNames.add(baseName);
        allFunctionNames.add(s.name);
      }
    } catch (e) {
      // Best-effort: a binary/locked/unreadable file must not abort the whole
      // scan — but stay diagnosable so a silently-missing file is explainable
      // (R4 devops F4).
      console.warn(`[analyze] skip unreadable ${rel}: ${(e as Error).message}`);
    }
  }

  // Second pass: deep analysis using tokenizer symbols
  const sourceLines: Record<string, string[]> = {};
  for (const { rel, ext, content, symbols, includes } of fileContents) {
    // Skip library/vendor files
    if (isLibraryFile(content, rel)) continue;

    const lines = content.split("\n");
    sourceLines[rel] = lines;
    const lineCount = lines.length;
    totalLines += lineCount;

    const ctx = detectContext(content, rel);
    // Drop only the literal self-import "./file". The old substring filter
    // (`!i.includes("./file")`) wrongly dropped legitimate imports like
    // "./file-utils" / "./file-watcher" with no comment (R3 P5).
    const imports = extractImports(content, ext).filter(i => i !== "./file");
    // Merge C++ includes from tokenizer
    if (includes.length > 0) {
      for (const inc of includes) { if (!imports.includes(inc)) imports.push(inc); }
    }
    const exports = extractExports(content, ext);
    // Merge exports from tokenizer symbols
    for (const s of symbols) {
      if (s.isExported) {
        const baseName = s.name.includes("::") ? s.name.split("::").pop()! : s.name.includes(".") ? s.name.split(".").pop()! : s.name;
        if (!exports.includes(baseName) && !exports.includes(s.name)) exports.push(baseName);
      }
    }

    // Skip pattern detection for files that contain detection code (false positives)
    const isDetector = rel.includes("analyze") || rel.includes("tokenizer") || rel.includes("symbols") || rel.includes("export");
    const patterns = isDetector ? [] : detectPatterns(content, ext, ctx);
    const routes = isDetector ? [] : extractRoutes(content);

    // Convert tokenizer symbols → FunctionInfo (skip type-only symbols)
    const functions: FunctionInfo[] = [];
      for (const s of symbols) {
        // Skip interfaces/types/enums/structs — they're not functions
        if (["interface", "type", "enum", "struct", "trait"].includes(s.kind)) continue;

        // Extract body text from source lines for deep analysis
        const bodyStart = Math.max(0, s.line - 1);
        const bodyEnd = Math.min(lineCount, s.endLine);
        const body = lines.slice(bodyStart, bodyEnd).join("\n");
        const bodyLines = bodyEnd - bodyStart;

        const calls = extractCalls(body, allFunctionNames);
        // Remove self-references from calls
        const baseName = s.name.includes(".") ? s.name.split(".").pop()! : s.name.includes("::") ? s.name.split("::").pop()! : s.name;
        const filteredCalls = calls.filter(c => c !== baseName && c !== s.name);
        const reads = extractReads(body);
        const writes = extractWrites(body);
        const description = describeFn(baseName, body, s.params, reads, writes, filteredCalls);

        functions.push({
          name: s.name,
          params: s.params,
          isAsync: s.isAsync,
          isExported: s.isExported,
          lines: bodyLines,
          calls: filteredCalls,
          reads,
          writes,
          description,
        });
      }

    totalFunctions += functions.length;
    patterns.filter(p => p !== "DOM" && p !== "Canvas").forEach(p => { projectPatterns.add(p); });

    // Extract threads, IPC, data types, security (skip detector files)
    if (!isDetector) {
      allThreads.push(...extractThreads(content, rel));
      allIPC.push(...extractIPC(content, rel));
      allSecurity.push(...extractSecurity(content, rel));
    }
    allDataTypes.push(...extractDataTypes(content, ext, rel));

    // Build call graph
    for (const fn of functions) {
      for (const callee of fn.calls) {
        callGraphEntries.push({ caller: `${rel}:${fn.name}`, callee, file: rel });
      }
    }

    const fa: FileAnalysis = {
      path: rel,
      lines: lineCount,
      imports,
      exports,
      functions,
      patterns,
      routes: routes.map(r => `${r.method} ${r.path}`),
      context: ctx,
      description: "",
    };
    fa.description = describeFile(fa);
    files.push(fa);
    graph[rel] = imports;
    for (const r of routes) allRoutes.push({ ...r, file: rel });
  }

  const importedBy = computeImportedBy(files.map(f => f.path), graph);

  // Entry points detection
  const entryPoints = files
    .filter(f => {
      const fname = f.path.split("/").pop() || "";
      // main.rs / main.py / main.go / main.c with main function
      if (/^main\.\w+$/.test(fname)) return true;
      // JS/TS: imports others but no one imports it (true entry)
      if (["ts", "tsx", "js", "jsx"].includes(fname.split(".").pop() || "")) {
        if (f.imports.length > 2 && (importedBy[f.path] || 0) === 0) return true;
      }
      // Has Bun.serve / app.listen (server entry)
      if (f.patterns.includes("HTTP Server") && f.context !== "client") return true;
      // index.html is an entry
      if (fname === "index.html") return true;
      return false;
    })
    .map(f => f.path)
    .filter((v, i, a) => a.indexOf(v) === i);

  // PageRank: rank files by importance
  const fileRanks = pageRankFiles(files, graph);
  // PageRank: rank functions by importance
  const fnRanks = pageRankFunctions(files, callGraphEntries);

  // Attach ranks onto the scan structs for serialization to the frontend.
  // `rank` isn't on the scan types (computed post-scan via PageRank), so these
  // two augmentations are deliberately untyped.
  for (const f of files) {
    (f as any).rank = fileRanks[f.path] || 0;
    for (const fn of f.functions) {
      (fn as any).rank = fnRanks[`${f.path}:${fn.name}`] || 0;
    }
  }

  // Sort files by rank (most important first)
  files.sort((a, b) => (fileRanks[b.path] || 0) - (fileRanks[a.path] || 0));

  return {
    files,
    totalLines,
    totalFunctions,
    entryPoints,
    graph,
    callGraph: callGraphEntries,
    apiRoutes: allRoutes,
    patterns: [...projectPatterns],
    fileRanks,
    fnRanks,
    threads: allThreads,
    ipcMessages: allIPC,
    dataTypes: allDataTypes,
    security: allSecurity,
  };
}

// PageRank for files — based on import graph
function pageRankFiles(files: FileAnalysis[], graph: Record<string, string[]>): Record<string, number> {
  const nodes = files.map(f => f.path);
  const N = nodes.length;
  if (N === 0) return {};

  const d = 0.85; // damping factor
  const iterations = 20;

  // Build adjacency: file → files it imports (resolved)
  const outLinks: Record<string, string[]> = {};
  const inLinks: Record<string, string[]> = {};
  for (const node of nodes) { outLinks[node] = []; inLinks[node] = []; }

  // Resolve imports to targets by BASENAME (no extension), not substring. The
  // old `target.includes(normalized)` let a short import like `./data` link to
  // `metadata.ts` and `path` match `path-utils.ts`, corrupting the rank graph —
  // the same collision computeImportedBy was fixed for (R4 code-quality F2).
  const baseName = (p: string) => p.split("/").pop()!.replace(/\.\w+$/, "");
  const byBase = new Map<string, string[]>();
  for (const node of nodes) {
    const b = baseName(node);
    const arr = byBase.get(b);
    if (arr) arr.push(node); else byBase.set(b, [node]);
  }

  for (const [file, imports] of Object.entries(graph)) {
    if (!outLinks[file]) continue;
    for (const imp of imports) {
      const impBase = baseName(imp.replace(/^\.+\//, ""));
      for (const target of byBase.get(impBase) ?? []) {
        if (target === file) continue;   // ignore self-import
        outLinks[file].push(target);
        inLinks[target].push(file);
      }
    }
  }

  // Initialize ranks
  let ranks: Record<string, number> = {};
  for (const node of nodes) ranks[node] = 1 / N;

  // Iterate
  for (let i = 0; i < iterations; i++) {
    const newRanks: Record<string, number> = {};
    for (const node of nodes) {
      let sum = 0;
      for (const src of inLinks[node]) {
        const outCount = outLinks[src].length || 1;
        sum += ranks[src] / outCount;
      }
      newRanks[node] = (1 - d) / N + d * sum;
    }
    ranks = newRanks;
  }

  // Boost: entry points, main files, files with routes
  for (const f of files) {
    const fname = f.path.split("/").pop()?.replace(/\.\w+$/, "").toLowerCase() || "";
    // Main/index/app files are always important
    if (["main", "index", "app", "server", "mod"].includes(fname)) ranks[f.path] = (ranks[f.path] || 0) * 2.0;
    if (f.patterns.includes("HTTP Server") || f.imports.length > 3) ranks[f.path] = (ranks[f.path] || 0) * 1.3;
    if (f.routes.length > 0) ranks[f.path] = (ranks[f.path] || 0) * 1.2;
    if (f.exports.length > 3) ranks[f.path] = (ranks[f.path] || 0) * 1.1;
  }

  return ranks;
}

// PageRank for functions — based on call graph
function pageRankFunctions(files: FileAnalysis[], callGraph: { caller: string; callee: string; file: string }[]): Record<string, number> {
  // Collect all function nodes as "file:name"
  const fnNodes = new Set<string>();
  for (const f of files) {
    for (const fn of f.functions) {
      fnNodes.add(`${f.path}:${fn.name}`);
    }
  }
  const nodes = [...fnNodes];
  const N = nodes.length;
  if (N === 0) return {};

  const d = 0.85;
  const iterations = 20;

  // Build links from call graph
  const inLinks: Record<string, string[]> = {};
  const outLinks: Record<string, string[]> = {};
  for (const node of nodes) { inLinks[node] = []; outLinks[node] = []; }

  for (const edge of callGraph) {
    // caller is already "file:name"
    // callee is just a name — find it in any file
    const callerKey = edge.caller;
    if (!outLinks[callerKey]) continue;

    for (const f of files) {
      const targetKey = `${f.path}:${edge.callee}`;
      if (fnNodes.has(targetKey)) {
        outLinks[callerKey].push(targetKey);
        inLinks[targetKey].push(callerKey);
      }
    }
  }

  // Initialize
  let ranks: Record<string, number> = {};
  for (const node of nodes) ranks[node] = 1 / N;

  // Iterate
  for (let i = 0; i < iterations; i++) {
    const newRanks: Record<string, number> = {};
    for (const node of nodes) {
      let sum = 0;
      for (const src of inLinks[node]) {
        const outCount = outLinks[src].length || 1;
        sum += ranks[src] / outCount;
      }
      newRanks[node] = (1 - d) / N + d * sum;
    }
    ranks = newRanks;
  }

  // Boost based on actual importance, not size
  for (const f of files) {
    for (const fn of f.functions) {
      const key = `${f.path}:${fn.name}`;
      if (fn.isExported) ranks[key] = (ranks[key] || 0) * 1.5;
      // Penalize small utility functions (< 8 lines)
      if (fn.lines <= 8 && !fn.isAsync) ranks[key] = (ranks[key] || 0) * 0.3;
      // Don't boost just for being big — boost for being called by many
      // (PageRank already handles this via inLinks)
    }
  }

  return ranks;
}

// Count how many files import each file, used by entry-point detection. Matches
// on the import's BASENAME (no extension) against file basenames, and only for
// RELATIVE imports — the old `f.path.includes(normalized)` substring match let
// the builtin `path` mark `path-utils.ts` as imported, and `./data` collide with
// `metadata.ts`/`update-data.ts`, corrupting the count (R4 code-quality F2).
export function computeImportedBy(
  filePaths: string[],
  graph: Record<string, string[]>,
): Record<string, number> {
  const baseName = (p: string) => p.split("/").pop()!.replace(/\.\w+$/, "");
  const byBase = new Map<string, string[]>();
  for (const p of filePaths) {
    const b = baseName(p);
    const arr = byBase.get(b);
    if (arr) arr.push(p);
    else byBase.set(b, [p]);
  }
  const importedBy: Record<string, number> = {};
  for (const imports of Object.values(graph)) {
    for (const imp of imports) {
      if (!imp.startsWith(".")) continue; // skip npm packages / builtins
      const b = baseName(imp.replace(/^\.+\//, ""));
      for (const p of byBase.get(b) ?? []) importedBy[p] = (importedBy[p] || 0) + 1;
    }
  }
  return importedBy;
}
