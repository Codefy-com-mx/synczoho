import { describe, expect, it } from "vitest";
import { getStatus, statusHttpCode } from "../../server/status";
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

describe("renderStatusPage", () => {
  it("es HTML autocontenido que consulta /api/status sin datos de tiendas", () => {
    const html = renderStatusPage();
    expect(html).toContain("<html");
    expect(html).toContain("/api/status");
    expect(html).not.toMatch(/store_id|access_token/);
  });
});
