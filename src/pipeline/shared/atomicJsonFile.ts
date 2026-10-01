import fs from 'node:fs';
import path from 'node:path';

/**
 * Crash-safe and concurrency-safe writes for the JSON stores (traceability/manifest.json,
 * flaky/quarantine.json).
 *
 * TWO SEPARATE PROBLEMS, TWO SEPARATE TOOLS.
 *
 * 1. `writeJsonFileAtomic` fixes CORRUPTION. A plain `fs.writeFileSync` to the destination
 *    truncates the file first and then writes; a process killed in between leaves a half-written
 *    manifest that fails to JSON.parse on the next run, taking the whole pipeline down with it.
 *    Writing to a temp file in the same directory and renaming over the destination means a reader
 *    only ever sees the complete old file or the complete new one.
 *
 * 2. `withFileLock` fixes LOST UPDATES. Every store does load -> mutate in memory -> write whole
 *    file. Two processes doing that concurrently (a CI job and someone running a stage locally)
 *    each read the same starting state, and the later write silently discards the earlier one's
 *    changes with no error to either caller. An atomic write does NOT help with this - both writes
 *    are individually perfect, and one of them is still gone. The whole read-modify-write sequence
 *    has to be inside the lock, which is why the stores expose `updateX(mutator)` helpers rather
 *    than expecting callers to remember to take a lock around a load/save pair.
 */

const LOCK_SUFFIX = '.lock';

/** How long to wait for another process's lock before giving up and throwing. */
export const LOCK_TIMEOUT_MS = 10_000;

/**
 * A lock older than this is assumed to belong to a process that died without releasing it.
 *
 * Generous on purpose: breaking a live lock reintroduces exactly the lost update this exists to
 * prevent, so the cost of waiting too long (a slow run) is much lower than the cost of breaking
 * too early (silent data loss). This project's own AGENTS.md documents an EDR agent that kills
 * processes mid-run, so stale locks are a real occurrence, not a theoretical one.
 */
export const LOCK_STALE_MS = 120_000;

const RETRY_INTERVAL_MS = 50;

/** Blocks the thread without a busy loop. These stores are synchronous throughout. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isErrnoException(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}

/**
 * Writes JSON so a reader never sees a partial file.
 *
 * The temp file is created in the SAME directory as the destination, because rename is only
 * atomic within one filesystem - a temp file in the OS temp directory could land on a different
 * volume and silently degrade into a copy.
 */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    // Best effort: a leftover temp file is harmless (it is dot-prefixed and never read), but
    // leaving one behind on every failure would slowly litter the data directory.
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      /* the original error is the one worth reporting */
    }
    throw err;
  }
}

/**
 * Runs `fn` while holding an exclusive lock on `filePath`.
 *
 * The lock is a directory rather than a file because `mkdir` is atomic and fails cleanly with
 * EEXIST on every platform this runs on, including Windows - no separate create-if-not-exists
 * dance, and no risk of two processes both believing they created it.
 */
export function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockPath = `${filePath}${LOCK_SUFFIX}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (err) {
      if (!isErrnoException(err, 'EEXIST')) throw err;

      if (isStale(lockPath)) {
        // Someone died holding this. Remove it and race for it again rather than assuming we won -
        // two processes can reach this line at the same moment.
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
        } catch {
          /* another process got there first; the next attempt will find out */
        }
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${LOCK_TIMEOUT_MS}ms waiting for the lock on ${filePath}. ` +
            `Another process is writing it. If nothing else is running, remove ${lockPath} by hand.`,
        );
      }
      sleepSync(RETRY_INTERVAL_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* a lock we cannot remove will be treated as stale by the next writer */
    }
  }
}

function isStale(lockPath: string): boolean {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    // It vanished between the EEXIST and the stat - the holder released it. Not stale; retry.
    return false;
  }
}
