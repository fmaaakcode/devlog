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

interface WinProc {
  pid: number;
  ppid: number;
  name: string;
  command: string;
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
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
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
    }));
  } catch {
    return [];
  }
}

async function batchCheckAlive(pids: number[]): Promise<Set<number>> {
  const alive = new Set<number>();
  if (pids.length === 0) return alive;
  const snapshot = await snapshotAllProcesses();
  const living = new Set(snapshot.map(p => p.pid));
  for (const pid of pids) if (living.has(pid)) alive.add(pid);
  return alive;
}

export function buildDescendantTree(rootPids: number[], allProcs: WinProc[]): Map<number, number[]> {
  // ppid -> children
  const childrenOf = new Map<number, number[]>();
  for (const p of allProcs) {
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

export async function refreshDescendants(data: DevLogData): Promise<void> {
  const sessions = await readActiveSessions();
  const aliveSessions = sessions.filter(s => s.alive);
  // Short-circuit: no active Claude sessions means nothing can be a descendant
  // and any stored entry whose pid is not alive anymore should be pruned. Skip
  // the expensive PowerShell snapshot when we only need to prune.
  if (aliveSessions.length === 0) {
    if (data.descendants.length === 0) return;
    data.descendants = [];
    return;
  }
  const allProcs = await snapshotAllProcesses();
  if (allProcs.length === 0) return;

  const procMap = new Map(allProcs.map(p => [p.pid, p]));
  const trees = buildDescendantTree(aliveSessions.map(s => s.pid), allProcs);
  const now = new Date().toISOString();
  const aliveSet = new Set(allProcs.map(p => p.pid));

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
      } else {
        data.descendants.push({
          pid,
          name: proc.name,
          command: proc.command,
          parentPid: proc.ppid,
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
    // Remove if process is dead
    if (!aliveSet.has(d.pid)) return false;
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

export async function killProcess(pid: number): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== "win32") return { ok: false, error: "process kill is Windows-only" };
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
