import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  query: vi.fn(),
  refreshProduct: vi.fn(),
  deleteProduct: vi.fn(),
  refreshCategory: vi.fn(),
  backfillCatalog: vi.fn(),
  logSync: vi.fn(),
  sendAlert: vi.fn(),
  observer: { onRetry: vi.fn() },
}));
const store = { store_id: "1", access_token: "t", store_name: "s" };
vi.mock("../../server/db", () => ({ getPool: () => ({ query: m.query }) }));
vi.mock("../../server/functions/_shared/tn-catalog", () => ({
  refreshProduct: m.refreshProduct, deleteProduct: m.deleteProduct,
  refreshCategory: m.refreshCategory, backfillCatalog: m.backfillCatalog,
}));
vi.mock("../../server/functions/_shared/tiendanube", () => ({
  getStore: vi.fn(async () => store), TN_API: "", TN_USER_AGENT: "",
}));
vi.mock("../../server/functions/_shared/zoho", () => ({
  getAdminClient: () => ({}), logSync: m.logSync,
}));
vi.mock("../../server/functions/_shared/tn-observer", () => ({ logRetryObserver: () => m.observer }));
vi.mock("../../server/functions/send-alert-email/index", () => ({ default: m.sendAlert }));
vi.mock("../../server/functions/zoho-create-salesorder/index", () => ({ default: vi.fn() }));
import { onEventFailure, processEvent } from "../../server/webhook-worker";

const row = (event_type: string, payload: Record<string, unknown> = {}, attempts = 1) =>
  ({ id: "e1", store_id: "1", event_type, payload, attempts });

beforeEach(() => {
  Object.values(m).forEach((f) => typeof f === "function" && "mockReset" in f && (f as any).mockReset());
  m.query.mockResolvedValue({ rows: [], rowCount: 1 });
  m.refreshProduct.mockResolvedValue("updated");
  m.backfillCatalog.mockResolvedValue({ products: 0, variants: 0 });
  m.sendAlert.mockResolvedValue(new Response("{}"));
});

describe("processEvent catálogo", () => {
  it("product/created|updated refresca el producto", async () => {
    await processEvent(row("product/updated", { id: 55 }));
    await processEvent(row("product/created", { id: 56 }));
    expect(m.refreshProduct).toHaveBeenNthCalledWith(1, store, 55);
    expect(m.refreshProduct).toHaveBeenNthCalledWith(2, store, 56);
  });

  it("product/deleted borra y un updated tardío que da 404 no lanza", async () => {
    await processEvent(row("product/deleted", { id: 55 }));
    expect(m.deleteProduct).toHaveBeenCalledWith("1", 55);
    m.refreshProduct.mockResolvedValueOnce("deleted");
    await expect(processEvent(row("product/updated", { id: 55 }))).resolves.toBeUndefined();
  });

  it("category/updated refresca y category/deleted borra de tn_categories", async () => {
    await processEvent(row("category/updated", { id: 9 }));
    expect(m.refreshCategory).toHaveBeenCalledWith(store, 9);
    await processEvent(row("category/deleted", { id: 9 }));
    expect(m.query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM tn_categories"), ["1", 9]);
    expect(m.refreshCategory).toHaveBeenCalledOnce();
  });

  it("internal/backfill llama backfillCatalog con observer", async () => {
    await processEvent(row("internal/backfill"));
    expect(m.backfillCatalog).toHaveBeenCalledWith(store, m.observer);
  });

  it("evento desconocido no lanza", async () => {
    await expect(processEvent(row("foo/bar"))).resolves.toBeUndefined();
  });
});

describe("onEventFailure", () => {
  it.each(["product/updated", "category/deleted", "internal/backfill"])(
    "%s con 5 intentos y UPDATE que cambia fila: marca stale, loguea y alerta una vez", async (type) => {
      await onEventFailure(row(type, {}, 5), "boom");
      expect(m.query).toHaveBeenCalledOnce();
      expect(m.query).toHaveBeenCalledWith(
        expect.stringMatching(/catalog_status='stale' WHERE store_id=\$1 AND catalog_status <> 'stale'/), ["1"]);
      expect(m.logSync).toHaveBeenCalledOnce();
      expect(m.logSync).toHaveBeenCalledWith({}, "1", expect.objectContaining({ operation: "catalog_webhook", status: "error" }));
      expect(m.sendAlert).toHaveBeenCalledOnce();
      const body = JSON.parse(await (m.sendAlert.mock.calls[0][0] as Request).text());
      expect(body).toEqual({ storeId: "1", operation: "catalog_webhook", errorMessage: expect.stringContaining("boom") });
    });

  it("con la tienda ya stale (rowCount 0) hace el UPDATE pero no loguea ni alerta", async () => {
    m.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await onEventFailure(row("product/updated", {}, 6), "boom");
    expect(m.query).toHaveBeenCalledOnce();
    expect(m.logSync).not.toHaveBeenCalled();
    expect(m.sendAlert).not.toHaveBeenCalled();
  });

  it("no hace nada con menos de 5 intentos ni en eventos que no son de catálogo", async () => {
    await onEventFailure(row("product/updated", {}, 4), "boom");
    await onEventFailure(row("order/paid", {}, 9), "boom");
    expect(m.query).not.toHaveBeenCalled();
    expect(m.logSync).not.toHaveBeenCalled();
    expect(m.sendAlert).not.toHaveBeenCalled();
  });

  it("registra console.error si el handler de alerta responde no-ok", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.sendAlert.mockResolvedValue(new Response("{}", { status: 500 }));
    await onEventFailure(row("internal/backfill", {}, 5), "boom");
    expect(err).toHaveBeenCalledWith("Catalog alert email failed", "1", 500);
    err.mockRestore();
  });
});
