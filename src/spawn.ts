// Unified spawn helpers (#406). Every raw spawn site had to remember windowsHide
// by hand — without it a detached / console child flashes its own console window
// on Windows, and doctor.ts's git spawnSync simply forgot the flag (latent: it
// only runs from the CLI, never the daemon). Each new call site was one more
// chance to forget. These wrappers default windowsHide:true so the safe behavior
// is the DEFAULT; a caller can still override it by passing windowsHide:false.
//
// Two runtimes on purpose: node:child_process for the detached restart respawn
// (a Bun.spawn child dies with its parent on Windows — freshness.ts), Bun.spawn
// for everything else.

import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

/** node:child_process spawn (async), windowsHide defaulted on. */
export function spawn(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess {
  return nodeSpawn(command, args, { windowsHide: true, ...options });
}

/** node:child_process spawnSync, windowsHide defaulted on. Overloaded like the
 *  original so a string `encoding` still yields string stdout/stderr. */
export function spawnSync(command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function spawnSync(command: string, args?: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<Buffer>;
export function spawnSync(command: string, args: readonly string[] = [], options: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
  return nodeSpawnSync(command, args, { windowsHide: true, ...options });
}

// The Bun wrappers mirror Bun.spawn/spawnSync's own `const In/Out/Err` generics so
// the caller's literal `stdout: "pipe"` still narrows the returned subprocess's
// stream types (a non-generic wrapper widens them and breaks `new Response(stdout)`).

/** Bun.spawn (async subprocess), windowsHide defaulted on. */
export function bunSpawn<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "inherit",
>(cmd: string[], options?: Bun.SpawnOptions.OptionsObject<In, Out, Err>): Bun.Subprocess<In, Out, Err> {
  return Bun.spawn(cmd, { windowsHide: true, ...options } as Bun.SpawnOptions.OptionsObject<In, Out, Err>);
}

/** Bun.spawnSync, windowsHide defaulted on. */
export function bunSpawnSync<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "pipe",
>(cmd: string[], options?: Bun.SpawnOptions.OptionsObject<In, Out, Err>): Bun.SyncSubprocess<Out, Err> {
  return Bun.spawnSync(cmd, { windowsHide: true, ...options } as Bun.SpawnOptions.OptionsObject<In, Out, Err>);
}
