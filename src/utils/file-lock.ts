/**
 * Per-file write serialization (issue #139).
 *
 * A new `SemanticRouter` is constructed per request, so a per-instance lock
 * cannot serialize concurrent requests. This is a process-wide singleton
 * (same pattern as `ContentBufferManager`) that serializes operations
 * targeting the *same* file path while leaving operations on *different*
 * paths fully concurrent.
 *
 * Without this, an MCP client that batches several `edit.window`/`append`/
 * `patch` calls against one file in parallel triggers overlapping
 * read-modify-write cycles: every call reports success but only one edit
 * survives, with no error surfaced (#139).
 */

/** Normalize a vault path to a stable lock key for the same logical file. */
function lockKey(path: string): string {
  return path
    .trim()
    .replace(/^\.\//, '')   // drop leading "./"
    .replace(/\/{2,}/g, '/') // collapse duplicate slashes
    .replace(/^\/+/, '');    // drop leading slashes
}

export class FileLockManager {
  private static instance: FileLockManager;

  /**
   * Tail of the promise chain per file path. Each `withLock` call appends
   * to the tail, so callers run strictly in arrival order for a given path.
   * The entry is deleted once its chain fully drains to bound memory.
   */
  private chains: Map<string, Promise<unknown>> = new Map();

  private constructor() {}

  static getInstance(): FileLockManager {
    if (!FileLockManager.instance) {
      FileLockManager.instance = new FileLockManager();
    }
    return FileLockManager.instance;
  }

  /**
   * Run `fn` with exclusive access to `path`. Calls for the same path are
   * serialized in arrival order; calls for different paths run concurrently.
   * `fn`'s result (or rejection) is propagated to the caller unchanged; a
   * rejection does not break serialization for subsequent waiters.
   */
  async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const key = lockKey(path);
    const prev = this.chains.get(key) ?? Promise.resolve();

    // Chain after the previous holder, swallowing its result/error so this
    // waiter runs regardless of how the prior one settled.
    const run = prev.then(() => fn(), () => fn());

    // The chain tail tracks completion (success or failure) without throwing.
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(key, tail);

    // Once this is the last queued operation for the path, drop the entry so
    // the map does not grow unbounded across many distinct files.
    void tail.then(() => {
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    });

    return run;
  }

  /** Test/diagnostic helper: number of paths with an in-flight chain. */
  activeLockCount(): number {
    return this.chains.size;
  }
}
