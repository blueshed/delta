/**
 * How the free-form document (`registerDoc`) and the JSON file (`./json`)
 * keep their file. @internal
 *
 * A save is whole or not at all: it goes to a temp file beside the real one
 * (through a symlink, beside what it points at), given the file's mode,
 * synced, and renamed over it; the folder is then synced, so the rename
 * survives a power cut too. A temp a crash left (`<file>.<pid>.<n>.tmp`, its
 * process gone) is cleared when the file is next opened.
 */
import fs from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * A JSON file's value, or undefined when there is no file. One that is there
 * but not JSON (empty, or cut short) throws, naming the file: it holds data
 * that should not be opened as nothing and saved over.
 */
export function readJsonFile(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (err: any) {
    throw new Error(`${file} is not JSON (${err.message}): restore it, or move it away to start from empty`);
  }
}

let saves = 0;

/** The real file a path names, symlinks resolved: the file's own, or (not there yet) its folder's. */
function real(file: string): string {
  try { return fs.realpathSync(file); } catch { /* not there yet */ }
  try { return join(fs.realpathSync(dirname(file)), basename(file)); } catch { return file; }
}

/** Where a save goes: the real file, a temp beside it, and the mode it keeps. */
function plan(file: string): { target: string; temp: string; mode?: number } {
  const target = real(file);
  let mode: number | undefined;
  try { mode = fs.statSync(target).mode & 0o7777; } catch { /* not there yet: the default */ }
  return { target, temp: `${target}.${process.pid}.${++saves}.tmp`, mode };
}

/** Sync a folder, so a rename in it is kept; a platform that cannot open a folder (Windows) skips it. */
function syncFolder(path: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dirname(path), "r");
    fs.fsyncSync(fd);
  } catch { /* not possible here */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Write `text` to `file` whole or not at all (see the module's note). */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const { target, temp, mode } = plan(file);
  try {
    await Bun.write(temp, text);   // makes the folder, if need be
    const handle = await fs.promises.open(temp, "r+");
    try {
      if (mode !== undefined) await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temp, target);
  } catch (err) {
    await fs.promises.rm(temp, { force: true });
    throw err;
  }
  const folder = await fs.promises.open(dirname(target), "r").catch(() => undefined);
  if (folder) await folder.sync().catch(() => {}).finally(() => folder.close());
}

/** `writeFileAtomic`, for a caller that cannot wait (`./json`'s `importTables`). */
export function writeFileAtomicSync(file: string, text: string): void {
  const { target, temp, mode } = plan(file);
  try {
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.writeFileSync(temp, text);
    const fd = fs.openSync(temp, "r+");
    try {
      if (mode !== undefined) fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  syncFolder(target);
}

/** Is process `pid` still running? (One we may not signal is.) */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** Remove the temps a crash left beside `file`: its own (`<name>.<pid>.<n>.tmp`), of a process no longer running. */
export function clearStaleTemps(file: string): void {
  const target = real(file);
  const name = basename(target);
  let entries: string[];
  try { entries = fs.readdirSync(dirname(target)); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith(`${name}.`)) continue;
    const m = /^\.(\d+)\.\d+\.tmp$/.exec(entry.slice(name.length));
    if (!m || Number(m[1]) === process.pid || running(Number(m[1]))) continue;
    fs.rmSync(join(dirname(target), entry), { force: true });
  }
}
