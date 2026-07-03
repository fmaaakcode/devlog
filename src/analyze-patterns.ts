// Content-pattern table for the stack analyzer (plan fable/round2 task 4.4).
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
  { label: "UDP/Networking", re: /\bSOCKET\b|WSAStartup|sendto\s*\(|recvfrom\s*\(|SOCK_DGRAM|\bUDP\b(?!\/)|(?<!web|Web)socket\s*\(/i },
  { label: "STUN/NAT", re: /STUN|stun_|hole_punch|nat_traversal/i },
  { label: "FEC", re: /FEC|fec_encode|fec_decode|forward_error/i },
  { label: "IOCP", re: /IOCP|CreateIoCompletionPort|GetQueuedCompletionStatus/i },
  { label: "CUDA", re: /cuda|__global__|cudaMalloc|cudaMemcpy|cublas|cusparse/i },
  { label: "Qt", re: /Qt\w+|QApplication|QWidget|QMainWindow|Q_OBJECT/i },
  { label: "CMake", re: /CMakeLists|cmake_minimum_required|find_package|target_link/i },
  { label: "OpenGL", re: /OpenGL|glfw|GLEW|glBindBuffer|glDraw/i },
  { label: "Vulkan", re: /Vulkan|vkCreate|VkInstance|VkDevice/i },
];
