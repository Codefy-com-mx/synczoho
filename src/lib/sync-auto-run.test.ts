import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLAIM_SCHEDULED_RUN_SQL, FINISH_SCHEDULED_RUN_SQL } from "../../server/scheduler";

const h = vi.hoisted(() => ({
  pool: undefined as unknown as {
    query: (
      text: string,
      values?: unknown[],
    ) => Promise<{ rowCount: number | null; rows: unknown[] }>;
  },
  schedules: { data: [] as any[], error: null as unknown },
  stores: { data: [] as any[], error: null as unknown },
  child: { kind: "json" as "json" | "status" | "throw", status: 200, payload: {} as any },
  fetchCalls: [] as Array<{ url: string; body: any }>,
  alertCalls: [] as Array<{ storeId: string; operation: string; errorMessage: string }>,
}));

vi.mock("../../server/db.js", () => ({ getPool: () => h.pool }));

vi.mock("../../server/functions/_shared/zoho.js", () => ({
  corsHeaders: {},
  getAdminClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.or = () => Promise.resolve(table === "sync_settings" ? h.schedules : h.stores);
      builder.in = () => Promise.resolve(table === "sync_settings" ? h.schedules : h.stores);
      return builder;
    },
  }),
}));

async function mockChild(name: string, request: Request): Promise<Response> {
  h.fetchCalls.push({ url: `/${name}`, body: await request.json() });
  if (h.child.kind === "throw") throw new Error("network down");
  if (h.child.kind === "status") return new Response("failure", { status: h.child.status });
  return Response.json(h.child.payload);
}

vi.mock("../../server/functions/sync-stock-run/index.js", () => ({
  default: (request: Request) => mockChild("sync-stock-run", request),
}));
vi.mock("../../server/functions/sync-prices-run/index.js", () => ({
  default: (request: Request) => mockChild("sync-prices-run", request),
}));
vi.mock("../../server/functions/send-alert-email/index.js", () => ({
  default: async (request: Request) => {
    h.alertCalls.push(await request.json());
    return Response.json({ sent: true });
  },
}));

import syncAutoRun from "../../server/functions/sync-auto-run/index";

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
 * In-memory `scheduled_sync_state` plus `sync_logs` success gate used to
 * exercise the handler without a database. Claim semantics mirror the
 * conditional upsert in `server/scheduler.ts`: a recent claim, a recent
 * recorded success, or a recent successful sync_logs row blocks the next
 * claim, so the handler must skip the child call.
 */
class FakeSyncStatePool {
  readonly rows = new Map<string, StateRow>();
  readonly logs: SyncLogRow[] = [];
  readonly claimCalls: unknown[][] = [];
  readonly finishCalls: unknown[][] = [];
  finishResult = true;

  seedState(storeId: string, operation: string, row: Partial<StateRow>): void {
    this.rows.set(`${storeId}:${operation}`, {
      attemptToken: null,
      status: "idle",
      startedAt: null,
      lastSuccessAt: null,
      lastError: null,
      ...row,
    });
  }

  seedLastSuccess(storeId: string, operation: string, lastSuccessAt: number): void {
    this.seedState(storeId, operation, { lastSuccessAt });
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
      this.claimCalls.push(values);
      const [storeId, operation, attemptToken, intervalSeconds] = values as [
        string,
        string,
        string,
        number,
      ];
      if (this.hasRecentSuccess(storeId, operation, intervalSeconds)) return { rows: [], rowCount: 0 };
      const key = `${storeId}:${operation}`;
      const existing = this.rows.get(key);
      const anchor = Math.max(existing?.startedAt ?? 0, existing?.lastSuccessAt ?? 0);
      if (existing && anchor > Date.now() - intervalSeconds * 1000) {
        return { rows: [], rowCount: 0 };
      }
      this.rows.set(key, {
        attemptToken,
        status: "running",
        startedAt: Date.now(),
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        lastError: null,
      });
      return { rows: [{ store_id: storeId }], rowCount: 1 };
    }
    if (text === FINISH_SCHEDULED_RUN_SQL) {
      this.finishCalls.push(values);
      if (!this.finishResult) return { rows: [], rowCount: 0 };
      const [storeId, operation, attemptToken, outcome, errorMessage] = values as [
        string,
        string,
        string,
        "success" | "error" | "skipped",
        string | null,
      ];
      const row = this.rows.get(`${storeId}:${operation}`);
      if (!row || row.attemptToken !== attemptToken) return { rows: [], rowCount: 0 };
      row.status = outcome;
      row.lastError = errorMessage;
      if (outcome === "success") row.lastSuccessAt = Date.now();
      return { rows: [{ store_id: storeId }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }
}

let pool: FakeSyncStatePool;

function scheduleStore(overrides: Record<string, unknown> = {}): void {
  h.schedules = {
    data: [
      {
        store_id: "store-1",
        stock_enabled: true,
        stock_schedule: "hourly",
        prices_enabled: false,
        prices_schedule: "disabled",
        ...overrides,
      },
    ],
    error: null,
  };
  h.stores = { data: [{ store_id: "store-1" }], error: null };
}

async function runHandler(): Promise<{ response: Response; payload: any }> {
  const response = await syncAutoRun(
    new Request("http://localhost/api/functions/v1/sync-auto-run", { method: "POST", body: "{}" }),
  );
  return { response, payload: await response.json() };
}

function childCalls(): Array<{ url: string; body: any }> {
  return h.fetchCalls.filter(
    (call) => call.url.includes("/sync-stock-run") || call.url.includes("/sync-prices-run"),
  );
}

beforeEach(() => {
  pool = new FakeSyncStatePool();
  h.pool = pool;
  h.fetchCalls = [];
  h.alertCalls = [];
  h.child = { kind: "json", status: 200, payload: { updated: 0, errors: 0 } };
  scheduleStore();
});

describe("sync-auto-run scheduled admission", () => {
  it("claims a due operation, runs the child once and records success without alerting", async () => {
    h.child.payload = { updated: 4, errors: 0 };

    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(payload.results).toEqual([{ store_id: "store-1", stock: "ok (updated:4, errors:0)" }]);
    expect(childCalls()).toHaveLength(1);
    expect(pool.finishCalls).toHaveLength(1);
    expect(pool.finishCalls[0][3]).toBe("success");
    expect(pool.finishCalls[0][4]).toBeNull();
    expect(h.alertCalls).toHaveLength(0);
  });

  it("records a 200 response with errors as a failed attempt and alerts once", async () => {
    h.child.payload = { updated: 1, errors: 2 };

    const { payload } = await runHandler();

    expect(pool.finishCalls[0][3]).toBe("error");
    expect(String(pool.finishCalls[0][4])).toContain("2 error(s)");
    expect(h.alertCalls).toHaveLength(1);
    expect(h.alertCalls[0]).toMatchObject({ storeId: "store-1", operation: "stock_sync_run" });
    expect(String(payload.results[0].stock)).toContain("error");
  });

  it("records an HTTP failure as a failed attempt and alerts once", async () => {
    h.child.kind = "status";
    h.child.status = 500;

    const { response } = await runHandler();

    expect(response.status).toBe(200);
    expect(pool.finishCalls[0][3]).toBe("error");
    expect(pool.finishCalls[0][4]).toBe("La función no respondió correctamente");
    expect(h.alertCalls).toHaveLength(1);
  });

  it("records a thrown child call as a failed attempt without failing the whole tick", async () => {
    h.child.kind = "throw";

    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(pool.finishCalls[0][3]).toBe("error");
    expect(pool.finishCalls[0][4]).toBe("network down");
    expect(h.alertCalls).toHaveLength(1);
    expect(String(payload.results[0].stock)).toContain("error");
  });

  it("skips the child call and the alert when the claim is not granted", async () => {
    pool.seedLastSuccess("store-1", "stock_sync_run", Date.now());

    const { payload } = await runHandler();

    expect(payload.results).toEqual([{ store_id: "store-1", stock: "skip (not yet due)" }]);
    expect(childCalls()).toHaveLength(0);
    expect(pool.finishCalls).toHaveLength(0);
    expect(h.alertCalls).toHaveLength(0);
  });

  it("keeps the first-deployment cadence from a recent success log without a state row", async () => {
    pool.seedLog("store-1", "stock_sync_run", "success", Date.now() - 10 * 60_000);

    const { payload } = await runHandler();

    expect(payload.results[0].stock).toBe("skip (not yet due)");
    expect(childCalls()).toHaveLength(0);
  });

  it("postpones the tick when a manual success is newer than the last scheduled attempt", async () => {
    pool.seedState("store-1", "stock_sync_run", {
      status: "success",
      attemptToken: "attempt-a",
      startedAt: Date.now() - 2 * 60 * 60_000,
      lastSuccessAt: Date.now() - 2 * 60 * 60_000,
    });
    pool.seedLog("store-1", "stock_sync_run", "success", Date.now() - 10 * 60_000);

    const { payload } = await runHandler();

    expect(payload.results[0].stock).toBe("skip (not yet due)");
    expect(childCalls()).toHaveLength(0);
    expect(h.alertCalls).toHaveLength(0);
  });

  it("runs the child once when two ticks race for the same due operation", async () => {
    const [first, second] = await Promise.all([runHandler(), runHandler()]);

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(childCalls()).toHaveLength(1);
    expect(h.alertCalls).toHaveLength(0);
  });

  it("does not alert for a failed attempt that was already superseded", async () => {
    pool.finishResult = false;
    h.child.payload = { updated: 0, errors: 3 };

    const { payload } = await runHandler();

    expect(h.alertCalls).toHaveLength(0);
    expect(String(payload.results[0].stock)).toContain("superseded");
  });

  it("runs prices with its configured cadence and leaves disabled stock untouched", async () => {
    scheduleStore({
      stock_enabled: false,
      stock_schedule: "disabled",
      prices_enabled: true,
      prices_schedule: "every6h",
    });
    h.child.payload = { updated: 7, errors: 0 };

    const { payload } = await runHandler();

    expect(payload.results).toEqual([{ store_id: "store-1", prices: "ok (updated:7, errors:0)" }]);
    expect(childCalls()).toHaveLength(1);
    expect(childCalls()[0].url).toContain("/sync-prices-run");
    expect(pool.claimCalls[0][1]).toBe("price_sync_run");
    expect(pool.claimCalls[0][3]).toBe(6 * 3600);
  });

  it("treats a child that is already running as a neutral skip without alerting", async () => {
    h.child.payload = { skipped: true, reason: "already_running" };

    const { response, payload } = await runHandler();

    expect(response.status).toBe(200);
    expect(payload.results).toEqual([{ store_id: "store-1", stock: "skip (already running)" }]);
    expect(pool.finishCalls).toHaveLength(1);
    expect(pool.finishCalls[0][3]).toBe("skipped");
    expect(pool.finishCalls[0][4]).toBeNull();
    expect(h.alertCalls).toHaveLength(0);
    expect(pool.rows.get("store-1:stock_sync_run")?.lastSuccessAt).toBeNull();
  });

  it("keeps the retry anchored at claim time after a neutral skip", async () => {
    h.child.payload = { skipped: true, reason: "already_running" };

    const first = await runHandler();
    const second = await runHandler();

    expect(first.payload.results[0].stock).toBe("skip (already running)");
    expect(second.payload.results[0].stock).toBe("skip (not yet due)");
    expect(childCalls()).toHaveLength(1);
    expect(h.alertCalls).toHaveLength(0);
  });
});
