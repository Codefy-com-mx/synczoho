/**
 * Session-scoped PostgreSQL advisory locks that keep a single real stock or
 * price run per (store, operation) across replicas and manual requests.
 *
 * A real run holds a dedicated pooled client for its whole duration and takes
 * a `pg_try_advisory_lock` on that session. Contention never blocks: the
 * caller receives `null` and can answer with a neutral already-running
 * response. The lock is released with `pg_advisory_unlock` and the client is
 * returned to the pool from the caller's `finally` block. If the process
 * dies, PostgreSQL drops the lock when the connection closes.
 *
 * No transaction is opened here, so external Zoho and Tiendanube I/O never
 * runs inside a transaction and a long catalog fetch cannot pin one.
 *
 * Callers acquire the lock from the dedicated bounded lock pool (`getLockPool`
 * in `server/db.ts`), not from the main data pool, so a held lock cannot
 * starve handler queries.
 *
 * The lock key is `hashtextextended(operation:storeId, SYNC_LOCK_NAMESPACE)`,
 * evaluated by PostgreSQL, so every replica derives the same 64-bit key from
 * the same text. Hashing cannot make collisions impossible: two distinct
 * (store, operation) pairs could in principle share a key, but the 64-bit
 * space makes that probability negligible, and a collision can only
 * over-serialize two runs, never let two real runs proceed together. The
 * namespace seed differs from the raw migration lock key used by
 * `server/migrate.ts` (731908221) to keep the two lock families practically
 * disjoint.
 */

export const SYNC_LOCK_NAMESPACE = 847_291_004;

export const TRY_SYNC_LOCK_SQL =
  `SELECT pg_try_advisory_lock(hashtextextended($1, ${SYNC_LOCK_NAMESPACE})) AS locked`;

export const RELEASE_SYNC_LOCK_SQL =
  `SELECT pg_advisory_unlock(hashtextextended($1, ${SYNC_LOCK_NAMESPACE})) AS unlocked`;

export interface SyncLockClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  /**
   * Returns the client to the pool. Passing an error destroys the underlying
   * connection, which makes PostgreSQL release every lock held by it.
   */
  release(error?: Error): void;
}

export interface SyncLockPool {
  connect(): Promise<SyncLockClient>;
}

export interface SyncLockTarget {
  storeId: string;
  operation: string;
}

export interface SyncLockHandle {
  /** Releases the advisory lock and returns the client to the pool. */
  release(): Promise<void>;
}

/**
 * Stable text key for the advisory lock. Both stock and prices handlers derive
 * the key from the same operation names the scheduler uses, so a manual and a
 * scheduled run of the same store and operation contend with each other.
 */
export function syncLockKey(storeId: string, operation: string): string {
  return `${operation}:${storeId}`;
}

/**
 * Acquires the session advisory lock without blocking. Returns `null` when
 * another session already holds the same key, and releases that session's
 * client before returning. On an unexpected failure the connection is
 * destroyed instead of pooled, so a lock that may have been taken is never
 * leaked into a reusable session.
 *
 * The caller should pass the dedicated lock pool. A saturated lock pool makes
 * `connect()` wait up to that pool's connection timeout and then reject; it
 * never silently starts a second overlapping run.
 */
export async function acquireSyncLock(
  pool: SyncLockPool,
  target: SyncLockTarget,
): Promise<SyncLockHandle | null> {
  const key = syncLockKey(target.storeId, target.operation);
  const client = await pool.connect();

  let locked: boolean;
  try {
    const result = await client.query(TRY_SYNC_LOCK_SQL, [key]);
    const row = result.rows[0] as { locked?: boolean } | undefined;
    locked = row?.locked === true;
  } catch (error) {
    client.release(error instanceof Error ? error : new Error("sync lock acquisition failed"));
    throw error;
  }

  if (!locked) {
    client.release();
    return null;
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        const result = await client.query(RELEASE_SYNC_LOCK_SQL, [key]);
        const row = result.rows[0] as { unlocked?: boolean } | undefined;
        if (row?.unlocked !== true) {
          // `pg_advisory_unlock` returns false when this session does not own
          // the key, and a malformed response cannot be trusted either.
          // Destroy the connection instead of returning a possibly locked
          // session to the pool.
          console.error("sync lock release was not confirmed; destroying pooled session");
          client.release(new Error("sync lock release was not confirmed"));
          return;
        }
      } catch (error) {
        // A failed unlock could leave a healthy session holding the lock, and
        // returning that session to the pool would leak it. Destroy the
        // connection instead so PostgreSQL drops the lock.
        console.error("sync lock release failed; destroying pooled session", error);
        client.release(error instanceof Error ? error : new Error("sync lock release failed"));
        return;
      }
      client.release();
    },
  };
}
