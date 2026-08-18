// Content-pattern table for the stack analyzer (plan review-round-2 task 4.4).
// Separated from analyze.ts's engine so detecting a new capability/language is a
// DATA edit here — add a row — not a code change to the scorer. Each rule maps a
// regex over file content to a display label; `ctx` restricts a rule to server-
// or client-context files (most rules are context-independent). Order is
// preserved in the output (deduped), so keep related rows grouped.

export interface PatternRule {
  label: string;
  re: RegExp;
  /** Skip this rule in the opposite context. Omit → applies everywhere. */
  ctx?: "server-only" | "client-only";
}

export const CONTENT_PATTERNS: PatternRule[] = [
  // Server-only (not meaningful in client code)
  { label: "HTTP Server", ctx: "server-only", re: /Bun\.serve\b|createServer\b|app\.listen\b|http\.listen\b/i },
  { label: "File I/O", ctx: "server-only", re: /readFile\b|writeFile\b|readdir\b|Bun\.file\b|Bun\.write\b/i },
  { label: "Database", ctx: "server-only", re: /(?:import|require|from)\s+['"](?:.*(?:sqlite|postgres|mysql|mongodb|redis|prisma|drizzle))/i },
  { label: "Database", ctx: "server-only", re: /new\s+(?:Database|Pool|Client)\s*\(/i },
  { label: "Auth", ctx: "server-only", re: /(?:import|require|from)\s+['"](?:.*(?:jwt|bcrypt|passport|auth))/i },
  { label: "Auth", ctx: "server-only", re: /verify(?:Token|JWT|Session)\b/i },
  { label: "Crypto", ctx: "server-only", re: /(?:createHash|encrypt|decrypt)\s*\(/i },
  { label: "CLI", ctx: "server-only", re: /(?:process\.argv|Bun\.argv)\b/ },
  { label: "CLI", ctx: "server-only", re: /(?:import|require).*(?:commander|yargs|argparse)/ },

  // Client-only
  { label: "DOM", ctx: "client-only", re: /document\.|querySelector|getElementById|innerHTML/ },
  { label: "Canvas", ctx: "client-only", re: /canvas|getContext\s*\(\s*['"]2d|WebGL/i },

  // Context-independent
  { label: "WebSocket", re: /new\s+WebSocket\b|Bun\.serve.*websocket|\.upgrade\s*\(/i },
  { label: "JSON", re: /JSON\.parse|JSON\.stringify/i },
  { label: "IPC", re: /child_process|(?<!\.)\bspawn\s*\(|(?<!\.)\bexec\s*\(|(?<!\.)\bfork\s*\(|ipcRenderer|ipcMain|Command::new|std::process/i },
  { label: "Threading", re: /Worker\b|worker_threads|thread::spawn|std::thread|rayon|tokio::spawn|pthread|Thread\.new|async_std/i },
  { label: "Windows API", re: /winapi|windows-sys|CreateProcess|HWND|WinUser|kernel32|user32|advapi32|RegOpenKey|HKEY_/i },
  { label: "System", re: /std::fs|std::path|std::env|os\.path|pathlib|sys\.platform/i },
  { label: "Event Loop", re: /tokio|async-std|#\[tokio::main\]|EventLoop|event_loop|select!\s*\{/i },
  { label: "File Watcher", re: /notify|FSWatcher|watchFile|inotify|chokidar|file.*watch|watch.*file/i },

  // C++ / native / GPU
  { label: "NVENC/NVDEC", re: /NVENC|nvEncodeAPI|NvEncoder|nvcuvid|NVDEC/i },
  { label: "DXGI/DirectX", re: /DXGI|IDXGIOutputDuplication|D3D11|ID3D11Device|DirectX/i },
  { label: "WASAPI", re: /WASAPI|IAudioClient|IAudioCaptureClient|IAudioRenderClient/i },
  { label: "Opus", re: /opus_encode|opus_decode|OpusEncoder|OpusDecoder/i },
  { label: "E2E Encryption", re: /libsodium|crypto_box|crypto_secretbox|sodium_init|crypto_aead/i },
  // Case-SENSITIVE on purpose (#794): `SOCKET`/`UDP` are C macros, while the
  // lowercase words are ordinary English that shows up in any comment about
  // WebSockets — `/i` here labelled a Bun/TS project as UDP networking.
  { label: "UDP/Networking", re: /\bSOCKET\b|WSAStartup|sendto\s*\(|recvfrom\s*\(|SOCK_DGRAM|\bUDP\b(?!\/)|(?<!web|Web)socket\s*\(/ },
  { label: "STUN/NAT", re: /\bSTUN\b|stun_|hole_punch|nat_traversal/i },
  // `\bFEC\b`, case-sensitive: the old `/FEC/i` matched the middle of "affect",
  // "effect", "perfect" — 35 files in this repo alone (#794).
  { label: "FEC", re: /\bFEC\b|fec_encode|fec_decode|forward_error/ },
  { label: "IOCP", re: /IOCP|CreateIoCompletionPort|GetQueuedCompletionStatus/i },
  { label: "CUDA", re: /cuda|__global__|cudaMalloc|cudaMemcpy|cublas|cusparse/i },
  // Qt class names are CamelCase and case-sensitive; `/Qt\w+/i` matched any
  // identifier containing "qt" (`qTokens` → "Qt" project, #794).
  { label: "Qt", re: /\bQt[A-Z]\w*|\bQApplication\b|\bQWidget\b|\bQMainWindow\b|\bQ_OBJECT\b/ },
  // Call forms, not bare tokens: `find_package` / `target_link` as plain words
  // appear in any code that merely KNOWS about CMake.
  { label: "CMake", re: /cmake_minimum_required\s*\(|find_package\s*\(|target_link_libraries\s*\(|CMakeLists\.txt["'`\s)]/i },
  { label: "OpenGL", re: /OpenGL|glfw|GLEW|glBindBuffer|glDraw/i },
  { label: "Vulkan", re: /Vulkan|vkCreate|VkInstance|VkDevice/i },
];

/**
 * Which per-file patterns may be claimed for the PROJECT as a whole (#794).
 *
 * A single match is a coincidence as often as a fact — one identifier, one
 * comment, one string literal naming a technology the project doesn't use. So
 * a project-level claim needs corroboration from a second file. The evidence
 * still exists at file level (the stack map's file rows keep it); this only
 * governs the headline list, where a wrong label reads as an identity.
 *
 * Small projects are exempt: at three files or fewer there IS no second file
 * to corroborate with, and demanding one would hide every real pattern.
 *
 * @param perFile  each analyzed file's detected labels
 * @param fileCount total analyzed files
 */
export function corroboratedPatterns(perFile: string[][], fileCount: number): string[] {
  const seen = new Map<string, number>();
  for (const labels of perFile) {
    for (const label of new Set(labels)) seen.set(label, (seen.get(label) ?? 0) + 1);
  }
  const min = fileCount <= 3 ? 1 : 2;
  return [...seen.entries()].filter(([, n]) => n >= min).map(([label]) => label);
}
