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
  // `eco` is the internal registry-ecosystem key (ecoMap values: "npm",
  // "crates.io", "pypi", …) stamped by the manifest parser that found the
  // library. Absent on profiles stored before the multi-ecosystem fix —
  // consumers fall back to ecoMap[language] then.
  libraries: { name: string; version: string; dev?: boolean; eco?: string }[];
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
  notices?: number;   // informational advisories (unmaintained/unsound) — warnings, not CVEs
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
  advisories?: Array<{ id: string; severity: string; summary: string; fix: string; url: string; kind?: string }>;
  transitive?: boolean;  // vuln came from an indirect (transitive) dependency, not a direct one
  // Official one-liner from the registry (npm description / crates description /
  // pypi summary) — captured from the SAME response the freshness lookup already
  // fetches, so it costs no extra request. Feeds the deps explainer page (#663).
  description?: string;
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
  /** Command events only: numeric exit code when the harness's tool_response
   *  carried one. Absent = unknown (older hooks, tools without a code). */
  exit_code?: number;
  /** Command events only: outcome verdict — from the exit code, an interruption,
   *  or a test-runner summary line. Absent = unknown; consumers fail OPEN on it
   *  (unknown must never be treated as failure). */
  ok?: boolean;
  description?: string;
  agent_type?: string;
  agent_id?: string;
  session_id?: string;
  /** SessionStart only: the project's absolute path at event time. The registry
   *  (projects.json) is otherwise the sole name→path record — this makes the
   *  event log a recovery source if the registry is ever lost. */
  cwd?: string;
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
  /** Problem reports only (#556): the CLOSED report this one likely reopens —
   *  a fix that didn't hold, detected at ingest (reopen.ts) and stored so
   *  recurrence is queryable data (retro ⟲, dashboard badge). Advisory. */
  relatedTo?: number;
  /** «قادمة» (upcoming): a deferred open item. Still numbered, still closable
   *  by `#N`, but excluded from the release guard, the built-without-closure
   *  warnings and the "Open now" counts — recorded ambition, not tracked debt.
   *  Set by `-(upcoming)` (create or convert), cleared by `-(todo) #N`. */
  upcoming?: boolean;
  /** Position memory (#486): files the capturing session touched since its
   *  previous tag batch (normalized absolute paths, capped). Feeds the
   *  dashboard file story and the PreToolUse "file history" injection. */
  files?: string[];
}

export interface PlanStep {
  text: string;
  completed: boolean;
  // Phase code captured from the nearest preceding "### Pn …" heading
  // (e.g. "P0", "P4", "P11"). Enables -(done) Pn to close a whole phase.
  phase?: string;
  /** Per-project numeric ID, assigned when the step is first registered. */
  num?: number;
  /** Closed by `-(dropped)` — ARCHIVED in place (not spliced out) so
   *  already-closed detection and `-(ask:closed)` can still find it (#410).
   *  A dropped step is closed-but-not-completed: excluded from the open set and
   *  from status/release rendering, distinct from `completed` (a `[x]`). */
  dropped?: boolean;
}

/**
 * A tag (or plan step) removed by `-(undo)`, as written to the `undone` archive
 * stream (#584). `-(undo)` used to splice the row out and lose it forever — the
 * last hard delete in a codebase whose retention explicitly archives instead. The
 * row keeps its full original shape under `entry`, so restoring it is a re-POST,
 * not a reconstruction.
 */
export interface UndoneRecord {
  undoneAt: string;
  project: string;
  kind: "tag" | "plan-step";
  /** plan-step only: which plan it was cut from, and the .md it round-trips to. */
  planTitle?: string;
  planFile?: string;
  entry: TagEntry | PlanStep;
}

export interface PlanEntry {
  id: string;
  project: string;
  title: string;
  steps: PlanStep[];
  file_path: string;
  timestamp: string;
  updatedAt: string;
  /** Upcoming plan: its open steps don't block a release or trigger closure
   *  nags. Toggled from the dashboard or by `-(upcoming) #N` on any of its
   *  steps (`-(todo) #N` promotes the plan back). */
  upcoming?: boolean;
}

export interface InjectionEntry {
  id: string;
  project: string;
  type: string; // "SessionStart" | "UserPromptSubmit" | "PreToolUse"
  content: string;
  chars: number;
  session_id?: string;
  timestamp: string;
  /** PreToolUse file-story injections only: the opened file (normalized), so
   *  the same file injects at most once per session. */
  file_path?: string;
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
  // Show the «قادمة» (upcoming) awareness line in the SessionStart /
  // UserPromptSubmit summaries. Off = upcoming items stay dashboard-only.
  upcomingItems: boolean;
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
  // Idempotency fingerprints of processed /api/tags batches (#591). The Stop
  // hook computes each from the RAW entries BEFORE any release-version
  // derivation, so a disk-queue replay of a batch the server already applied
  // is recognized and dropped — the whole-history content dedup can't catch
  // it, because a bare -(release) is stored WITH its computed version while
  // the replay arrives without one, minting a fresh number each time. Capped
  // (newest last).
  processedBatches?: string[];
}
