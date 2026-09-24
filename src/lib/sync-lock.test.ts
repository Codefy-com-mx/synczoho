import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  RELEASE_SYNC_LOCK_SQL,
  SYNC_LOCK_NAMESPACE,
  TRY_SYNC_LOCK_SQL,
  acquireSyncLock,
  syncLockKey,
  type SyncLockClient,
} from "../../server/sync-lock";

const MIGRATION_LOCK_KEY = 731_908_221;

class FakeLockClient implements SyncLockClient {
  readonly owned = new Set<string>();
  released = 0;
  releaseError: Error | undefined;

  constructor(private readonly pool: FakeLockPool) {}

  async query(text: string, values: unknown[] = []) {
    const key = String(values[0]);
    this.pool.queries.push({ sql: text, key });
    if (text === TRY_SYNC_LOCK_SQL) {
      if (this.pool.failTry) throw new Error("try-lock failed");
      if (this.pool.held.has(key)) return { rows: [{ locked: false }] };
      this.pool.held.add(key);
      this.owned.add(key);
      return { rows: [{ locked: true }] };
    }
    if (text === RELEASE_SYNC_LOCK_SQL) {
      if (this.pool.failRelease) throw new Error("unlock failed");
      if (this.pool.unlockResult === "false") return { rows: [{ unlocked: false }] };
      if (this.pool.unlockResult === "malformed") return { rows: [] };
      this.pool.held.delete(key);
      this.owned.delete(key);
      return { rows: [{ unlocked: true }] };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  release(error?: Error): void {
    this.released++;
    this.releaseError = error;
    // A destroyed session drops every lock it still holds.
    for (const key of this.owned) this.pool.held.delete(key);
  }
}

class FakeLockPool {
  readonly held = new Set<string>();
  readonly clients: FakeLockClient[] = [];
  readonly queries: Array<{ sql: string; key: string }> = [];
  failTry = false;
  failRelease = false;
  unlockResult: "confirmed" | "false" | "malformed" = "confirmed";

  async connect(): Promise<FakeLockClient> {
    const client = new FakeLockClient(this);
    this.clients.push(client);
    return client;
  }
}

describe("acquireSyncLock", () => {
  it("takes the session lock and releases it exactly once", async () => {
    const pool = new FakeLockPool();
    const handle = await acquireSyncLock(pool, { storeId: "store-1", operation: "stock_sync_run" });

    expect(handle).not.toBeNull();
    expect(pool.held.has(syncLockKey("store-1", "stock_sync_run"))).toBe(true);
    expect(pool.clients[0].released).toBe(0);

    await handle?.release();

    expect(pool.held.size).toBe(0);
    expect(pool.clients[0].released).toBe(1);
    expect(pool.queries.map((entry) => entry.sql)).toEqual([
      TRY_SYNC_LOCK_SQL,
      RELEASE_SYNC_LOCK_SQL,
    ]);
    expect(pool.queries[0].key).toBe("stock_sync_run:store-1");
  });

  it("returns null on contention and gives the client back without unlocking", async () => {
    const pool = new FakeLockPool();
    const key = syncLockKey("store-1", "stock_sync_run");
    pool.held.add(key);

    const handle = await acquireSyncLock(pool, { storeId: "store-1", operation: "stock_sync_run" });

    expect(handle).toBeNull();
    expect(pool.held.has(key)).toBe(true);
    expect(pool.clients[0].released).toBe(1);
    expect(pool.queries.map((entry) => entry.sql)).toEqual([TRY_SYNC_LOCK_SQL]);
  });

  it("does not contend across different stores or operations", async () => {
    const pool = new FakeLockPool();

    const stock = await acquireSyncLock(pool, { storeId: "store-1", operation: "stock_sync_run" });
    const prices = await acquireSyncLock(pool, { storeId: "store-1", operation: "price_sync_run" });
    const otherStore = await acquireSyncLock(pool, { storeId: "store-2", operation: "stock_sync_run" });

    expect(stock).not.toBeNull();
    expect(prices).not.toBeNull();
    expect(otherStore).not.toBeNull();
    expect(pool.held.size).toBe(3);
  });

  it("destroys the session when the try-lock query fails", async () => {
    const pool = new FakeLockPool();
    pool.failTry = true;

    await expect(
      acquireSyncLock(pool, { storeId: "store-1", operation: "stock_sync_run" }),
    ).rejects.toThrow("try-lock failed");

    expect(pool.clients[0].released).toBe(1);
    expect(pool.clients[0].releaseError).toBeInstanceOf(Error);
    expect(pool.held.size).toBe(0);
  });

  it("destroys the session when the unlock fails so the lock cannot leak", async () => {
    const pool = new FakeLockPool();
    pool.failRelease = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = await acquireSyncLock(pool, { storeId: "store-1", operation: "stock_sync_run" });

    await handle?.release();

    expect(pool.clients[0].released).toBe(1);
    expect(pool.clients[0].releaseError).toBeInstanceOf(Error);
    expect(pool.held.size).toBe(0);
    consoleError.mockRestore();
  });

  it("ignores a repeated release", async () => {
    const pool = new FakeLockPool();
    const handle = await acquireSyncLock(pool, { storeId: "store-1", operation: "stock_sync_run" });

    await handle?.release();
    await handle?.release();

    expect(pool.queries.filter((entry) => entry.sql === RELEASE_SYNC_LOCK_SQL)).toHaveLength(1);
    expect(pool.clients[0].released).toBe(1);
  });

  it("destroys the session when the unlock reports that nothing was released", async () => {
    const pool = new FakeLockPool();
    pool.unlockResult = "false";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = await acquireSyncLock(pool, { storeId: "store-1", operation: "stock_sync_run" });

    await handle?.release();

    expect(pool.clients[0].released).toBe(1);
    expect(pool.clients[0].releaseError).toBeInstanceOf(Error);
    expect(pool.held.size).toBe(0);
    consoleError.mockRestore();
  });

  it("destroys the session on a malformed unlock response", async () => {
    const pool = new FakeLockPool();
    pool.unlockResult = "malformed";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = await acquireSyncLock(pool, { storeId: "store-1", operation: "stock_sync_run" });

    await handle?.release();

    expect(pool.clients[0].released).toBe(1);
    expect(pool.clients[0].releaseError).toBeInstanceOf(Error);
    expect(pool.held.size).toBe(0);
    consoleError.mockRestore();
  });
});

describe("sync lock namespace", () => {
  it("uses a namespace distinct from the startup migration lock", () => {
    const migrate = readFileSync(path.resolve(process.cwd(), "server/migrate.ts"), "utf8");

    expect(SYNC_LOCK_NAMESPACE).not.toBe(MIGRATION_LOCK_KEY);
    expect(migrate).toContain("pg_advisory_lock($1)");
    expect(migrate.replace(/_/g, "")).toContain(String(MIGRATION_LOCK_KEY));
    expect(TRY_SYNC_LOCK_SQL).toContain(String(SYNC_LOCK_NAMESPACE));
    expect(RELEASE_SYNC_LOCK_SQL).toContain(String(SYNC_LOCK_NAMESPACE));
  });

  it("hashes the store/operation key server-side without opening a transaction", () => {
    expect(TRY_SYNC_LOCK_SQL).toContain("pg_try_advisory_lock(hashtextextended($1");
    expect(RELEASE_SYNC_LOCK_SQL).toContain("pg_advisory_unlock(hashtextextended($1");
    for (const sql of [TRY_SYNC_LOCK_SQL, RELEASE_SYNC_LOCK_SQL]) {
      expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/);
    }
  });

  it("keeps the key stable and scoped to store plus operation", () => {
    expect(syncLockKey("store-1", "stock_sync_run")).toBe("stock_sync_run:store-1");
    expect(syncLockKey("store-1", "stock_sync_run")).not.toBe(syncLockKey("store-1", "price_sync_run"));
    expect(syncLockKey("store-1", "stock_sync_run")).not.toBe(syncLockKey("store-2", "stock_sync_run"));
  });
});
