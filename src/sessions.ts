// Who is running RIGHT NOW: the live-process side of DevLog, as opposed to the
// recorded history everything else deals with. It reads Claude Code's own
// session files (~/.claude/sessions/*.json), checks which pids are actually
// alive, and maps each session to the process subtree it spawned — that is what
// the dashboard's process panel renders and what killProcess() acts on.
//
// The process TREE is Windows-only by necessity: the snapshot comes from a
// PowerShell/WMI query, so results are ttlCached (a snapshot per request would
// be far too expensive), the shell's own helper processes are filtered out
// (SELF_NAMES) so DevLog never lists — or kills — the machinery it used to
// look, and on macOS/Linux it returns empty instead of spawning a `powershell`
// that isn't there on every poll. Session LIVENESS is portable: on POSIX it is
// a signal-0 probe per pid, so /api/sessions works on every OS.
//
// The tree math (buildDescendantTree, pruneDescendantsAgainst) is pure and
// exported for tests, separate from the I/O around it. Note the deliberate
// asymmetry in pruning: a descendant whose SESSION disappeared but whose pid is
// still alive is KEPT and marked `orphaned` rather than forgotten — a leaked
// process is exactly what the user needs to see.

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeSession, DevLogData } from "./types";
import { projectName } from "./data";
import { claudeConfigDir, normalizeSlashes } from "./path-utils";
import { bunSpawn } from "./spawn";
import { ttlCached } from "./ttl-cache";

const SESSIONS_DIR = join(claudeConfigDir(), "sessions");

export async function readActiveSessions(): Promise<ClaudeSession[]> {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files = await readdir(SESSIONS_DIR).catch(() => []);
  const sessions: ClaudeSession[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await Bun.file(join(SESSIONS_DIR, f)).json();
      const pid = Number(raw.pid);
      if (!pid) continue;
      sessions.push({
        pid,
        sessionId: raw.sessionId || "",
        cwd: normalizeSlashes(raw.cwd),
        startedAt: Number(raw.startedAt) || 0,
        kind: raw.kind,
        entrypoint: raw.entrypoint,
        alive: false,
      });
    } catch { /* malformed session record → skip this one, keep the rest */ }
  }
  const aliveSet = await batchCheckAlive(sessions.map(s => s.pid));
  for (const s of sessions) s.alive = aliveSet.has(s.pid);
  return sessions;
}

export interface WinProc {
  pid: number;
  ppid: number;
  name: string;
  command: string;
  /** Process start, epoch ms; 0 when WMI withheld it. The parent link of a
   *  process is only trusted when the parent started BEFORE it (#1061): a
   *  ParentProcessId names a pid, and Windows reuses pids, so a dead parent's
   *  number can now belong to an unrelated process — a short-lived hook shell
   *  once "inherited" csrss/wininit/lsass this way. */
  created: number;
}

// One snapshot serves every caller in a 2s window (and every caller while one
// is in flight): /api/sessions and /api/processes each took their own ~370ms
// PowerShell spawn, and the dashboard header fires BOTH on every project
// switch. "Which PIDs are alive right now" tolerates 2s of staleness — it
// only feeds liveness indicators and the 10–60s adaptive poll. An empty
// result (hung WMI / parse failure) is never cached, so a transient failure
// isn't served as "everything is dead" for the rest of the window.
const SNAPSHOT_TTL_MS = 2000;
const snapshotAllProcesses = ttlCached(SNAPSHOT_TTL_MS, snapshotAllProcessesUncached, procs => procs.length > 0);

async function snapshotAllProcessesUncached(): Promise<WinProc[]> {
  // Process/session tracking is Windows-only (powershell + WMI). On macOS/Linux,
  // return empty instead of spawning a missing `powershell` every poll cycle
  // (code-quality R2 #3). The dashboard still works; only process panels stay empty.
  if (process.platform !== "win32") return [];
  // CreationDate → epoch ms computed IN PowerShell: ConvertTo-Json renders a
  // DateTime as "\/Date(ms)\/" on 5.1 and as ISO on 7+, so the shape would
  // otherwise depend on which PowerShell answered. Probed on 5.1 (2026-09-06):
  // present even for csrss/System, where CommandLine is withheld.
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Created';e={ if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } }} | ConvertTo-Json -Compress";
  try {
    // windowsHide (defaulted by the spawn wrapper, #406): without a parent console
    // (daemon respawned detached by /api/server/restart) every powershell poll pops
    // a visible console window that flashes on screen — CREATE_NO_WINDOW keeps it
    // silent either way.
    const proc = bunSpawn(["powershell", "-NoProfile", "-Command", script], {
      stdout: "pipe",
      stderr: "ignore",
    });
    // Hard timeout: a hung WMI query (corrupt repo / system pressure) must not
    // wedge the 10s poll loop forever and leave a zombie powershell (devops R2 #2).
    const killer = setTimeout(() => { try { proc.kill(); } catch { /* already exited → nothing to kill */ } }, 4000);
    let out: string;
    try {
      out = await new Response(proc.stdout).text();
    } finally {
      clearTimeout(killer);
    }
    const parsed = JSON.parse(out);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map((p: Record<string, unknown>) => ({
      pid: Number(p.ProcessId) || 0,
      ppid: Number(p.ParentProcessId) || 0,
      name: String(p.Name ?? ""),
      command: String(p.CommandLine ?? ""),
      created: Number(p.Created) || 0,
    }));
  } catch {
    return [];
  }
}

async function batchCheckAlive(pids: number[]): Promise<Set<number>> {
  const alive = new Set<number>();
  if (pids.length === 0) return alive;
  // The WMI snapshot is Windows-only, so on macOS/Linux every session used to
  // come back dead and /api/sessions was always empty there (#1143's e2e went
  // red on both POSIX runners, v3.61.0 release prep). Signal 0 is the portable
  // liveness probe: it delivers nothing, ESRCH means gone, EPERM means alive
  // but owned by someone else. The process TREE stays Windows-only.
  if (process.platform !== "win32") {
    for (const pid of pids) {
      try { process.kill(pid, 0); alive.add(pid); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EPERM") alive.add(pid); }
    }
    return alive;
  }
  const snapshot = await snapshotAllProcesses();
  const living = new Set(snapshot.map(p => p.pid));
  for (const pid of pids) if (living.has(pid)) alive.add(pid);
  return alive;
}

/** Is `parent` really the process that spawned `child`? ParentProcessId alone
 *  is a pid, and pids are reused: the link holds only when both start times
 *  are known and the parent started no later than the child. Unknown (0) on
 *  either side → NOT trusted; this feeds the kill path, so the safe answer to
 *  "maybe" is "no". The server's own pid is never anyone's ancestor here — the
 *  daemon may itself be a session's child, and its WMI helpers are not the
 *  user's background work. */
export function isTrustedParent(parent: WinProc | undefined, child: WinProc, selfPid = process.pid): boolean {
  if (!parent || parent.pid === selfPid) return false;
  if (!parent.created || !child.created) return false;
  return parent.created <= child.created;
}

export function buildDescendantTree(rootPids: number[], allProcs: WinProc[], selfPid = process.pid): Map<number, number[]> {
  const byPid = new Map(allProcs.map(p => [p.pid, p]));
  // ppid -> children, keeping only links whose parent is provably older (#1061).
  const childrenOf = new Map<number, number[]>();
  for (const p of allProcs) {
    if (p.pid === selfPid) continue;
    if (!isTrustedParent(byPid.get(p.ppid), p, selfPid)) continue;
    let kids = childrenOf.get(p.ppid);
    if (!kids) { kids = []; childrenOf.set(p.ppid, kids); }
    kids.push(p.pid);
  }
  // root -> all descendants (BFS)
  const result = new Map<number, number[]>();
  for (const root of rootPids) {
    const descendants: number[] = [];
    const queue = [...(childrenOf.get(root) || [])];
    const seen = new Set<number>();
    while (queue.length) {
      const pid = queue.shift();
      if (pid === undefined) break;
      if (seen.has(pid)) continue;
      seen.add(pid);
      descendants.push(pid);
      for (const c of childrenOf.get(pid) || []) queue.push(c);
    }
    result.set(root, descendants);
  }
  return result;
}

const SELF_NAMES = new Set(["powershell.exe", "conhost.exe", "WmiPrvSE.exe", "cmd.exe"]);

const MAX_DESCENDANTS = 500;

// Pure core of the no-sessions branch (#775): prune entries whose pid is dead,
// KEEP the living ones marked orphaned. Exported for unit tests.
//
// "Alive" means the SAME process (#1062): the stored start time must match the
// live one, else the pid was recycled and the row describes a stranger. Rows
// stored before start times existed (no `created`) cannot be verified and are
// dropped — the live store carried 137 such "orphans", all system processes
// swallowed through a recycled parent pid; nothing re-derived is lost (undo.ts
// contract exemption 1: machine-derived rows the next refresh rebuilds).
export function pruneDescendantsAgainst(
  descendants: DevLogData["descendants"], living: Map<number, WinProc>, now: string,
): DevLogData["descendants"] {
  const kept = descendants.filter(d => sameProcess(d, living.get(d.pid)));
  for (const d of kept) { d.orphaned = true; d.lastSeen = now; }
  return kept;
}

/** The stored row and the live process are one and the same: pid AND start time. */
export function sameProcess(stored: { pid: number; created?: number }, live: WinProc | undefined): boolean {
  return !!live && !!stored.created && live.created === stored.created;
}

export async function refreshDescendants(data: DevLogData): Promise<void> {
  const sessions = await readActiveSessions();
  const aliveSessions = sessions.filter(s => s.alive);
  // No active Claude sessions: prune the DEAD descendants, keep live ones as
  // orphans. #775: this used to wipe data.descendants wholesale with no pid
  // check — killing live-orphan tracking — and a transiently-empty WMI snapshot
  // (which also zeroes aliveSessions) was enough to trigger the wipe, against
  // the module's own "transient failure must not read as mass death" promise.
  if (aliveSessions.length === 0) {
    if (data.descendants.length === 0) return;
    const snapshot = await snapshotAllProcesses();
    if (snapshot.length === 0) return;   // transient WMI failure — change nothing
    data.descendants = pruneDescendantsAgainst(
      data.descendants, new Map(snapshot.map(p => [p.pid, p])), new Date().toISOString(),
    );
    return;
  }
  const allProcs = await snapshotAllProcesses();
  if (allProcs.length === 0) return;

  const procMap = new Map(allProcs.map(p => [p.pid, p]));
  const trees = buildDescendantTree(aliveSessions.map(s => s.pid), allProcs);
  const now = new Date().toISOString();

  // Index existing descendants by pid
  const existing = new Map(data.descendants.map(d => [d.pid, d]));

  // Track newly-seen descendants from alive sessions
  const seenNow = new Set<number>();
  for (const session of aliveSessions) {
    const projectName_ = projectName(session.cwd);
    const descPids = trees.get(session.pid) || [];
    for (const pid of descPids) {
      const proc = procMap.get(pid);
      if (!proc) continue;
      // Skip noise: short-lived shell helpers spawned by hooks
      if (SELF_NAMES.has(proc.name)) continue;
      seenNow.add(pid);
      const prev = existing.get(pid);
      if (prev) {
        prev.lastSeen = now;
        prev.orphaned = false;
        prev.claudePid = session.pid;
        prev.sessionId = session.sessionId;
        prev.project = projectName_;
        prev.command = proc.command || prev.command;
        prev.name = proc.name || prev.name;
        prev.parentPid = proc.ppid;
        prev.created = proc.created;
      } else {
        data.descendants.push({
          pid,
          name: proc.name,
          command: proc.command,
          parentPid: proc.ppid,
          created: proc.created,
          claudePid: session.pid,
          sessionId: session.sessionId,
          project: projectName_,
          firstSeen: now,
          lastSeen: now,
          orphaned: false,
        });
      }
    }
  }

  // Mark orphans (stored descendants whose claude session is gone but they're still alive)
  const aliveSessionPids = new Set(aliveSessions.map(s => s.pid));
  data.descendants = data.descendants.filter(d => {
    // Remove if the process is dead — or if the pid now belongs to a stranger
    // (start time differs), or the row predates start-time tracking (#1062).
    if (!sameProcess(d, procMap.get(d.pid))) return false;
    // If its claude parent session is no longer alive → orphan
    if (!aliveSessionPids.has(d.claudePid)) d.orphaned = true;
    d.lastSeen = now;
    return true;
  });

  // Safety cap: keep only most recently seen entries if list grows excessive
  if (data.descendants.length > MAX_DESCENDANTS) {
    data.descendants.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
    data.descendants.length = MAX_DESCENDANTS;
  }
}

/** Kill a tracked process — after re-identifying it at kill time (#1062). The
 *  tracked row may be up to a poll interval old; if the pid has since been
 *  recycled, `taskkill /T` would take down a stranger and its whole tree. So
 *  the FRESH snapshot (never the 2s cache) must show the same pid with the
 *  same start time and name, or the kill is refused. */
export async function killProcess(
  pid: number, expected?: { name: string; created?: number },
): Promise<{ ok: boolean; error?: string; identityChanged?: boolean }> {
  if (process.platform !== "win32") return { ok: false, error: "process kill is Windows-only" };
  if (expected) {
    const live = (await snapshotAllProcessesUncached()).find(p => p.pid === pid);
    if (!live) return { ok: false, error: `pid ${pid} is no longer running`, identityChanged: true };
    if (!sameProcess({ pid, created: expected.created }, live) || live.name !== expected.name) {
      return { ok: false, identityChanged: true, error: `pid ${pid} now belongs to ${live.name || "another process"} (started ${live.created}) — not the tracked ${expected.name}; refusing to kill` };
    }
  }
  try {
    const proc = bunSpawn(["taskkill", "/PID", String(pid), "/F", "/T"], {
      stdout: "pipe", stderr: "pipe",
    });
    const code = await proc.exited;
    if (code === 0) return { ok: true };
    const err = await new Response(proc.stderr).text();
    return { ok: false, error: err.trim() || `exit ${code}` };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}
