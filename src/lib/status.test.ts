import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStatus, resetStatusCache, statusHttpCode } from "../../server/status";
import { renderStatusPage } from "../../server/status-page";

const clear = {
  pending: "0",
  oldest_pending_seconds: "0",
  failed: "0",
  stock_last_success: null,
  prices_last_success: null,
  stale_catalogs: "0",
  // Extra columns que nunca deben salir en la respuesta.
  store_id: "store-secret-123",
  store_name: "Tienda Secreta",
  access_token: "tok_abc",
};

const poolWith = (row: Record<string, unknown>) => ({ query: async () => ({ rows: [row] }) });

beforeEach(() => {
  resetStatusCache();
  vi.stubEnv("APP_VERSION", "");
  vi.stubEnv("SOURCE_COMMIT", "");
  delete process.env.APP_VERSION;
  delete process.env.SOURCE_COMMIT;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("getStatus", () => {
  it("ok con todo en orden", async () => {
    const result = await getStatus(poolWith(clear) as never);
    expect(result.status).toBe("ok");
    expect(result.database).toBe("ok");
    expect(result.queue).toEqual({ pending: 0, oldest_pending_seconds: 0, failed: 0 });
    expect(statusHttpCode(result.status)).toBe(200);
  });

  it("degraded si el evento pendiente más viejo supera 600 s", async () => {
    const result = await getStatus(poolWith({ ...clear, pending: "1", oldest_pending_seconds: "700" }) as never);
    expect(result.status).toBe("degraded");
    expect(result.queue.oldest_pending_seconds).toBe(700);
    expect(statusHttpCode(result.status)).toBe(200);
  });

  it("degraded si hay eventos fallidos", async () => {
    expect((await getStatus(poolWith({ ...clear, failed: "2" }) as never)).status).toBe("degraded");
  });

  it("degraded si hay catálogos stale", async () => {
    const result = await getStatus(poolWith({ ...clear, stale_catalogs: "1" }) as never);
    expect(result.status).toBe("degraded");
    expect(result.stale_catalogs).toBe(1);
  });

  it("down con database down y HTTP 503 si la consulta falla", async () => {
    const pool = { query: async () => { throw new Error("connection refused postgres://u:p@h/db"); } };
    const result = await getStatus(pool as never);
    expect(result.status).toBe("down");
    expect(result.database).toBe("down");
    expect(statusHttpCode(result.status)).toBe(503);
    expect(JSON.stringify(result)).not.toContain("postgres://");
  });

  it("serializa fechas de scheduler y nunca expone datos de tiendas", async () => {
    const when = new Date("2026-10-21T10:00:00.000Z");
    const result = await getStatus(poolWith({ ...clear, stock_last_success: when }) as never);
    expect(result.scheduler).toEqual({ stock_last_success: when.toISOString(), prices_last_success: null });
    const json = JSON.stringify(result);
    for (const leak of ["store_id", "store-secret-123", "Tienda Secreta", "tok_abc", "access_token"]) {
      expect(json).not.toContain(leak);
    }
  });
});

describe("versión", () => {
  it("unknown sin variables, APP_VERSION tal cual, SHA recortado a 12", async () => {
    expect((await getStatus(poolWith(clear) as never)).version).toBe("unknown");
    resetStatusCache();
    vi.stubEnv("APP_VERSION", "1.4.2");
    expect((await getStatus(poolWith(clear) as never)).version).toBe("1.4.2");
    resetStatusCache();
    vi.stubEnv("APP_VERSION", "");
    delete process.env.APP_VERSION;
    vi.stubEnv("SOURCE_COMMIT", "d49eefb0123456789abcdef0123456789abcdef0");
    expect((await getStatus(poolWith(clear) as never)).version).toBe("d49eefb01234");
  });

  it("también aparece cuando la base está caída", async () => {
    vi.stubEnv("APP_VERSION", "2.0.0");
    const pool = { query: async () => { throw new Error("x"); } };
    expect((await getStatus(pool as never)).version).toBe("2.0.0");
  });
});

describe("criterios de la consulta", () => {
  it("failed exige attempts >= 5; pending/oldest solo cuentan eventos listos", async () => {
    let sql = "";
    const pool = { query: async (text: string) => { sql = text; return { rows: [clear] }; } };
    await getStatus(pool as never);
    const normalized = sql.replace(/\s+/g, " ");
    expect(normalized).toContain("processed = false AND error_message IS NOT NULL AND attempts >= 5");
    expect(normalized.match(/processed = false AND next_attempt_at <= now\(\)/g)).toHaveLength(2);
  });

  it("un evento recién fallido (failed=0) es ok; con failed=1 (attempts>=5) es degraded", async () => {
    expect((await getStatus(poolWith({ ...clear, pending: "0", failed: "0" }) as never)).status).toBe("ok");
    resetStatusCache();
    expect((await getStatus(poolWith({ ...clear, failed: "1" }) as never)).status).toBe("degraded");
  });
});

describe("memo de 10 s", () => {
  it("reutiliza el resultado dentro de la ventana y recalcula después", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T10:00:00Z"));
    const query = vi.fn(async () => ({ rows: [clear] }));
    await getStatus({ query } as never);
    vi.advanceTimersByTime(9_000);
    await getStatus({ query } as never);
    expect(query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await getStatus({ query } as never);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("nunca memoiza down: la recuperación se ve de inmediato", async () => {
    const failing = vi.fn(async () => { throw new Error("db"); });
    expect((await getStatus({ query: failing } as never)).status).toBe("down");
    expect((await getStatus({ query: failing } as never)).status).toBe("down");
    expect(failing).toHaveBeenCalledTimes(2);
    expect((await getStatus(poolWith(clear) as never)).status).toBe("ok");
  });
});

describe("renderStatusPage", () => {
  it("es HTML autocontenido que consulta /api/status sin datos de tiendas", () => {
    const html = renderStatusPage();
    expect(html).toContain("<html");
    expect(html).toContain("/api/status");
    expect(html).toContain("data.version");
    expect(html).not.toMatch(/store_id|access_token/);
  });
});
