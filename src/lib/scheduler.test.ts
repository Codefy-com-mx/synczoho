import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CLAIM_SCHEDULED_RUN_SQL,
  FINISH_SCHEDULED_RUN_SQL,
  claimScheduledRun,
  createTickGuard,
  finishScheduledRun,
  type ScheduledSyncPool,
} from "../../server/scheduler";

const HOUR_MS = 60 * 60 * 1000;

interface StateRow {
  attemptToken: string | null;
  status: string;
  startedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}

interface SyncLogRow {
  storeId: string;
  operation: string;
  status: string;
  createdAt: number;
}

/**
 * In-memory stand-in for `scheduled_sync_state` plus the `sync_logs` success
 * gate. It mirrors the conditional upsert, the token-guarded terminal update,
 * and the recent-success filter so the helper contract can be exercised
 * without a database. The atomicity and the exact filters of the real SQL are
 * pinned by the SQL text assertions below; no isolated test Postgres is
 * available, so runtime DB integration is intentionally out of scope here.
 */
class FakeSyncStatePool implements ScheduledSyncPool {
  readonly rows = new Map<string, StateRow>();
  readonly logs: SyncLogRow[] = [];
  readonly claimParameters: unknown[][] = [];
  readonly finishParameters: unknown[][] = [];

  seed(storeId: string, operation: string, row: Partial<StateRow> = {}): void {
    this.rows.set(`${storeId}:${operation}`, {
      attemptToken: null,
      status: "idle",
      startedAt: null,
      lastSuccessAt: null,
      lastError: null,
      ...row,
    });
  }

  seedLog(storeId: string, operation: string, status: string, createdAt: number): void {
    this.logs.push({ storeId, operation, status, createdAt });
  }

  private hasRecentSuccess(storeId: string, operation: string, intervalSeconds: number): boolean {
    const cutoff = Date.now() - intervalSeconds * 1000;
    return this.logs.some(
      (log) =>
        log.storeId === storeId &&
        log.operation === operation &&
        log.status === "success" &&
        log.createdAt > cutoff,
    );
  }

  async query(text: string, values: unknown[] = []) {
    if (text === CLAIM_SCHEDULED_RUN_SQL) {
      this.claimParameters.push(values);
      const [storeId, operation, attemptToken, intervalSeconds] = values as [
        string,
        string,
        string,
        number,
      ];
      if (this.hasRecentSuccess(storeId, operation, intervalSeconds)) return { rows: [], rowCount: 0 };
      const key = `${storeId}:${operation}`;
      const existing = this.rows.get(key);
      const anchor = existing?.startedAt ?? existing?.lastSuccessAt ?? null;
      const due = !existing || anchor === null || anchor <= Date.now() - intervalSeconds * 1000;
      if (!due) return { rows: [], rowCount: 0 };
      this.rows.set(key, {
        attemptToken,
        status: "running",
        startedAt: Date.now(),
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        lastError: null,
      });
      return { rows: [{ store_id: storeId, operation, attempt_token: attemptToken }], rowCount: 1 };
    }
    if (text === FINISH_SCHEDULED_RUN_SQL) {
      this.finishParameters.push(values);
      const [storeId, operation, attemptToken, outcome, errorMessage] = values as [
        string,
        string,
        string,
        "success" | "error",
        string | null,
      ];
      const key = `${storeId}:${operation}`;
      const existing = this.rows.get(key);
      if (!existing || existing.attemptToken !== attemptToken) return { rows: [], rowCount: 0 };
      existing.status = outcome;
      existing.lastError = errorMessage;
      if (outcome === "success") existing.lastSuccessAt = Date.now();
      return { rows: [{ store_id: storeId }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }
}

function claimOptions(attemptToken: string, intervalMs = HOUR_MS) {
  return { storeId: "store-1", operation: "stock_sync_run", intervalMs, attemptToken };
}

describe("claimScheduledRun", () => {
  it("claims a due job only once when two replicas race for it", async () => {
    const pool = new FakeSyncStatePool();

    const results = await Promise.all([
      claimScheduledRun(pool, claimOptions("attempt-a")),
      claimScheduledRun(pool, claimOptions("attempt-b")),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(pool.rows.get("store-1:stock_sync_run")?.status).toBe("running");
  });

  it("keeps the cadence from the last recorded success when no success log is present", async () => {
    const pool = new FakeSyncStatePool();
    pool.seed("store-1", "stock_sync_run", { lastSuccessAt: Date.now() - 10 * 60_000 });

    expect(await claimScheduledRun(pool, claimOptions("attempt-a"))).toBe(false);
  });

  it("claims a store whose recorded last success is older than the interval", async () => {
    const pool = new FakeSyncStatePool();
    pool.seed("store-1", "stock_sync_run", { lastSuccessAt: Date.now() - 2 * HOUR_MS });

    expect(await claimScheduledRun(pool, claimOptions("attempt-a"))).toBe(true);
  });

  it("blocks a first-deployment claim while a recent success log exists without a state row", async () => {
    const pool = new FakeSyncStatePool();
    pool.seedLog("store-1", "stock_sync_run", "success", Date.now() - 10 * 60_000);

    expect(await claimScheduledRun(pool, claimOptions("attempt-a"))).toBe(false);
  });

  it("claims once the first-deployment success log ages past the interval", async () => {
    const pool = new FakeSyncStatePool();
    pool.seedLog("store-1", "stock_sync_run", "success", Date.now() - 2 * HOUR_MS);

    expect(await claimScheduledRun(pool, claimOptions("attempt-a"))).toBe(true);
  });

  it("does not re-claim a failed attempt on the next tick", async () => {
    const pool = new FakeSyncStatePool();
    await claimScheduledRun(pool, claimOptions("attempt-a"));
    await finishScheduledRun(pool, { ...claimOptions("attempt-a"), outcome: "error", errorMessage: "boom" });

    expect(await claimScheduledRun(pool, claimOptions("attempt-b"))).toBe(false);
  });

  it("re-claims a failed attempt once the interval has elapsed", async () => {
    const pool = new FakeSyncStatePool();
    pool.seed("store-1", "stock_sync_run", {
      status: "error",
      attemptToken: "attempt-a",
      startedAt: Date.now() - 2 * HOUR_MS,
    });

    expect(await claimScheduledRun(pool, claimOptions("attempt-b"))).toBe(true);
  });

  it("re-claims a still-running or crashed attempt only after the interval", async () => {
    const pool = new FakeSyncStatePool();
    pool.seed("store-1", "stock_sync_run", {
      status: "running",
      attemptToken: "attempt-a",
      startedAt: Date.now() - 2 * HOUR_MS,
    });

    expect(await claimScheduledRun(pool, claimOptions("attempt-b"))).toBe(true);
  });

  it("postpones the next claim while a manual success is newer than the last scheduled attempt", async () => {
    const pool = new FakeSyncStatePool();
    pool.seed("store-1", "stock_sync_run", {
      status: "success",
      attemptToken: "attempt-a",
      startedAt: Date.now() - 2 * HOUR_MS,
      lastSuccessAt: Date.now() - 2 * HOUR_MS,
    });
    pool.seedLog("store-1", "stock_sync_run", "success", Date.now() - 10 * 60_000);

    expect(await claimScheduledRun(pool, claimOptions("attempt-b"))).toBe(false);
  });

  it("re-claims once the manual success is older than the configured interval", async () => {
    const pool = new FakeSyncStatePool();
    pool.seed("store-1", "stock_sync_run", {
      status: "success",
      attemptToken: "attempt-a",
      startedAt: Date.now() - 3 * HOUR_MS,
      lastSuccessAt: Date.now() - 3 * HOUR_MS,
    });
    pool.seedLog("store-1", "stock_sync_run", "success", Date.now() - 2 * HOUR_MS);

    expect(await claimScheduledRun(pool, claimOptions("attempt-b"))).toBe(true);
  });

  it("does not gate on success logs of other operations or on failed rows", async () => {
    const pool = new FakeSyncStatePool();
    pool.seed("store-1", "stock_sync_run", {
      status: "success",
      attemptToken: "attempt-a",
      startedAt: Date.now() - 2 * HOUR_MS,
      lastSuccessAt: Date.now() - 2 * HOUR_MS,
    });
    pool.seedLog("store-1", "price_sync_run", "success", Date.now());
    pool.seedLog("store-1", "stock_sync_run", "error", Date.now());

    expect(await claimScheduledRun(pool, claimOptions("attempt-b"))).toBe(true);
  });

  it("passes the configured interval in seconds to the claim statement", async () => {
    const pool = new FakeSyncStatePool();

    await claimScheduledRun(pool, claimOptions("attempt-a", 6 * HOUR_MS));

    expect(pool.claimParameters[0]).toEqual(["store-1", "stock_sync_run", "attempt-a", 6 * 3600]);
  });
});

describe("finishScheduledRun", () => {
  it("records success and refreshes the last success anchor", async () => {
    const pool = new FakeSyncStatePool();
    await claimScheduledRun(pool, claimOptions("attempt-a"));

    const recorded = await finishScheduledRun(pool, { ...claimOptions("attempt-a"), outcome: "success" });

    expect(recorded).toBe(true);
    const row = pool.rows.get("store-1:stock_sync_run");
    expect(row?.status).toBe("success");
    expect(row?.lastSuccessAt).not.toBeNull();
    expect(row?.lastError).toBeNull();
  });

  it("records the error message without refreshing the last success anchor", async () => {
    const pool = new FakeSyncStatePool();
    await claimScheduledRun(pool, claimOptions("attempt-a"));

    await finishScheduledRun(pool, {
      ...claimOptions("attempt-a"),
      outcome: "error",
      errorMessage: "boom",
    });

    const row = pool.rows.get("store-1:stock_sync_run");
    expect(row?.status).toBe("error");
    expect(row?.lastError).toBe("boom");
    expect(row?.lastSuccessAt).toBeNull();
  });

  it("ignores a terminal update from a superseded attempt", async () => {
    const pool = new FakeSyncStatePool();
    pool.seed("store-1", "stock_sync_run", {
      status: "running",
      attemptToken: "attempt-b",
      startedAt: Date.now(),
    });

    const recorded = await finishScheduledRun(pool, {
      ...claimOptions("attempt-a"),
      outcome: "error",
      errorMessage: "stale",
    });

    expect(recorded).toBe(false);
    expect(pool.rows.get("store-1:stock_sync_run")?.status).toBe("running");
  });
});

describe("createTickGuard", () => {
  it("skips a tick while the previous one is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => gate);
    const onSkip = vi.fn();
    const tick = createTickGuard(run, onSkip);

    const first = tick();
    const second = tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);
    await tick();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("releases the guard after a failed tick", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const tick = createTickGuard(run);

    await expect(tick()).rejects.toThrow("boom");
    await tick();

    expect(run).toHaveBeenCalledTimes(2);
  });
});

function readScheduledStateMigration(): string {
  return readFileSync(
    path.resolve(process.cwd(), "server/migrations/002_scheduled_sync_state.sql"),
    "utf8",
  );
}

describe("scheduled admission SQL", () => {
  it("claims through an atomic conditional upsert anchored at claim time", () => {
    expect(CLAIM_SCHEDULED_RUN_SQL).toContain("ON CONFLICT (store_id, operation) DO UPDATE");
    expect(CLAIM_SCHEDULED_RUN_SQL).toContain(
      "WHERE COALESCE(state.started_at, state.last_success_at",
    );
    expect(CLAIM_SCHEDULED_RUN_SQL).toContain("RETURNING store_id, operation, attempt_token");
  });

  it("gates both claim paths on recent successful sync_logs bounded by store and time window", () => {
    const gates = CLAIM_SCHEDULED_RUN_SQL.match(/NOT EXISTS \(/g) ?? [];
    expect(gates).toHaveLength(2);
    expect(CLAIM_SCHEDULED_RUN_SQL).toContain("FROM sync_logs");
    expect(CLAIM_SCHEDULED_RUN_SQL).toContain("sync_logs.store_id = $1");
    expect(CLAIM_SCHEDULED_RUN_SQL).toContain("sync_logs.operation = $2");
    expect(CLAIM_SCHEDULED_RUN_SQL).toContain("sync_logs.status = 'success'");
    expect(CLAIM_SCHEDULED_RUN_SQL).toContain("sync_logs.created_at > now() - make_interval");
  });

  it("guards the terminal update with the attempt token", () => {
    expect(FINISH_SCHEDULED_RUN_SQL).toContain(
      "WHERE store_id = $1 AND operation = $2 AND attempt_token = $3",
    );
    expect(FINISH_SCHEDULED_RUN_SQL).toContain("CASE WHEN $4 = 'success' THEN now()");
  });

  it("defines the state table keyed by store and operation", () => {
    const migration = readScheduledStateMigration();

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS scheduled_sync_state");
    expect(migration).toContain("PRIMARY KEY (store_id, operation)");
  });

  it("cascades scheduled state when the store is removed", () => {
    expect(readScheduledStateMigration()).toContain(
      "REFERENCES stores(store_id) ON DELETE CASCADE",
    );
  });

  it("keeps the startup migration free of sync_logs backfills and index builds", () => {
    const migration = readScheduledStateMigration();

    // server/migrate.ts runs migrations in a startup transaction; a full
    // sync_logs scan or index build there could block production writes.
    expect(migration).not.toContain("INSERT INTO scheduled_sync_state");
    expect(migration).not.toContain("FROM sync_logs");
    expect(migration).not.toContain("CREATE INDEX");
  });
});
