export interface MemoryFile {
  file: string;
  name: string;
  description: string;
  type: string;
  body?: string;  // Markdown content after frontmatter, capped at ~3 KB for tooltips
}

export interface ProjectProfile {
  name: string;
  path: string;
  description: string;
  about?: string;
  blueprint: string[];
  language: string;
  framework: string;
  libraries: { name: string; version: string; dev?: boolean }[];
  files: Record<string, number>;
  directories: string[];
  totalFiles: number;
  lastScan: string;
  runtime?: RuntimeInfo;
  vulnResults?: Record<string, VulnResult>;
  vulnScanDate?: string;
  memoryFiles?: MemoryFile[];
  docFiles?: MemoryFile[];
  // Git/GitHub link (L1). Populated when the project root is a git repo
  // with a remote. `gitRemote` is the raw URL from `git config`; the
  // `gitRepoSlug` is normalised to "owner/repo" for the cases we can
  // recognise (github.com / gitlab.com / bitbucket); falsy otherwise.
  gitRemote?: string;
  gitRepoSlug?: string;
  // Per-project monotonic counter for numbered items (todos, bugs, security,
  // plan steps). Never reused — closed items keep their number for history.
  nextItemNum?: number;
  // ISO timestamp of when the project path was first observed missing.
  // Marked instead of deleted (P1.1 / code-quality#1) so disconnected
  // external drives / WSL mounts don't lose all tags + plans on a stat
  // failure. Cleared when the path becomes accessible again.
  disconnectedSince?: string;
}

export interface VulnResult {
  status: string;     // "safe" | "update" | "danger"
  icon: string;       // "check" | "x" | "warning"
  message: string;
  vulns: number;
  severity?: string;  // "none" | "low" | "moderate" | "high" | "critical"
  topVuln?: { id: string; score: number; severity: string } | null;
  fixVersion?: string;
  latestVersion?: string;
  isLatest?: boolean;
  detailsUrl?: string;
  latestReleaseDate?: string;  // ISO publish date of latestVersion (native registry)
  fixReleaseDate?: string;     // ISO publish date of fixVersion (external API)
  daysSinceLatest?: number | null;
  daysSinceFix?: number | null;
  advisories?: Array<{ id: string; severity: string; summary: string; fix: string; url: string }>;
  transitive?: boolean;  // vuln came from an indirect (transitive) dependency, not a direct one
}

export interface RuntimeInfo {
  name: string;       // "Bun", "Node", "rustc", "Go", "GCC", "Python", "PHP"
  version: string;    // "1.3.11", "1.78.0", "1.22", etc.
  edition?: string;   // Rust: "2021", C/C++: "C++20", TS: "ESNext"
}

export interface EventEntry {
  id: string;
  project: string;
  event: string;
  tool?: string;
  type: string;
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
  command?: string;
  description?: string;
  agent_type?: string;
  agent_id?: string;
  session_id?: string;
  note?: string;
  timestamp: string;
  lines_added?: number;
  lines_removed?: number;
  retention?: "hot" | "warm";
}

export interface WorklogEntry {
  id: string;
  project: string;
  text: string;
  timestamp: string;
}

export interface TagEntry {
  id: string;
  project: string;
  tag: string;
  content: string;
  session_id?: string;
  timestamp: string;
  /** Optional `!` modifier on the tag — marks a breaking change. */
  breaking?: boolean;
  /** Per-project numeric ID for openable tags (todo, bug found, security*).
   *  Lets Claude close items by `-(done) #5` instead of verbatim text. */
  num?: number;
  /** Release tags only: the manifest version that was in effect BEFORE this
   *  release bumped it. Lets a rollback restore the previous version even when
   *  no earlier release tag exists (QA #2). */
  prevVersion?: string;
}

export interface PlanStep {
  text: string;
  completed: boolean;
  // Phase code captured from the nearest preceding "### Pn …" heading
  // (e.g. "P0", "P4", "P11"). Enables -(done) Pn to close a whole phase.
  phase?: string;
  /** Per-project numeric ID, assigned when the step is first registered. */
  num?: number;
}

export interface PlanEntry {
  id: string;
  project: string;
  title: string;
  steps: PlanStep[];
  file_path: string;
  timestamp: string;
  updatedAt: string;
}

export interface InjectionEntry {
  id: string;
  project: string;
  type: string; // "SessionStart" | "UserPromptSubmit" | "PreToolUse"
  content: string;
  chars: number;
  session_id?: string;
  timestamp: string;
}

export interface InjectionConfig {
  sessionStart: boolean;
  userPromptSubmit: boolean;
  preToolUseRead: boolean;
  // Surface outdated-library awareness on SessionStart (count + 3 oldest).
  // Independent per-project toggle; default on. Fires even when `sessionStart`
  // is off — in that case it injects a standalone outdated-libs block.
  outdatedLibs: boolean;
  // Nudge Claude to fill a missing `desc` / `about`. Independent per-project
  // toggle; default on. Fires even when `sessionStart` is off (mirrors
  // `outdatedLibs`) so a project with the summary disabled can never stay
  // description-less forever. Self-silencing: each nudge disappears once its
  // field is set; `about` waits for ≥3 builds before nagging.
  describeNudge: boolean;
  claudeMd: boolean;
  contextMd: boolean;
  // Standards enforcement (PreToolUse gate + Stop check). Per-project, ON by
  // default. Setting it false for a project writes a `.devlog/standards-off`
  // marker the hooks read locally; manual -(ask:rules) still works either way.
  standardsEnforce?: boolean;
}

export interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind?: string;
  entrypoint?: string;
  alive: boolean;
}

export interface DescendantProcess {
  pid: number;
  name: string;
  command: string;
  parentPid: number;
  claudePid: number;
  sessionId: string;
  project: string;
  firstSeen: string;
  lastSeen: string;
  orphaned: boolean;
}

export interface DevLogData {
  projects: Record<string, ProjectProfile>;
  events: EventEntry[];
  tags: TagEntry[];
  plans: PlanEntry[];
  worklog: WorklogEntry[];
  injections: InjectionEntry[];
  injectionConfig: InjectionConfig;
  projectInjectionConfigs: Record<string, Partial<InjectionConfig>>;
  descendants: DescendantProcess[];
  // One-time migration flags. Each migration runs once on startup, then
  // sets its key to `true` here so subsequent restarts skip it.
  migrations?: Record<string, boolean>;
  // Ambiguous closures the server rejected (e.g. multiple `Pn` tokens in
  // one `-(done)`). Surfaced in next SessionStart and cleared after, so
  // Claude learns instead of repeating the pattern silently (P1.9).
  rejections?: Array<{ id: string; project: string; reason: string; detail: string; timestamp: string }>;
}
