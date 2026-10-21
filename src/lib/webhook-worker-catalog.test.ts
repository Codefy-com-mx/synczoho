import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  query: vi.fn(),
  refreshProduct: vi.fn(),
  loadProductCatalog: vi.fn(),
  applyPricesToZoho: vi.fn(),
  deleteProduct: vi.fn(),
  refreshCategory: vi.fn(),
  backfillCatalog: vi.fn(),
  logSync: vi.fn(),
  getZohoConnection: vi.fn(),
  sendAlert: vi.fn(),
  observer: { onRetry: vi.fn() },
}));
const store = { store_id: "1", access_token: "t", store_name: "s" };
const conn = { store_id: "1", organization_id: "o" };
vi.mock("../../server/db", () => ({ getPool: () => ({ query: m.query }) }));
vi.mock("../../server/functions/_shared/tn-catalog", () => ({
  refreshProduct: m.refreshProduct, loadProductCatalog: m.loadProductCatalog, deleteProduct: m.deleteProduct,
  refreshCategory: m.refreshCategory, backfillCatalog: m.backfillCatalog,
}));
vi.mock("../../server/functions/_shared/price-from-tn", async (orig) => ({
  ...(await orig<typeof import("../../server/functions/_shared/price-from-tn")>()),
  applyPricesToZoho: m.applyPricesToZoho,
}));
vi.mock("../../server/functions/_shared/tiendanube", () => ({
  getStore: vi.fn(async () => store), TN_API: "", TN_USER_AGENT: "",
}));
vi.mock("../../server/functions/_shared/zoho", () => ({
  getAdminClient: () => ({}), logSync: m.logSync, getZohoConnection: m.getZohoConnection,
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
  m.loadProductCatalog.mockResolvedValue([]);
  m.applyPricesToZoho.mockResolvedValue({ updated: 1, errors: 0 });
  m.getZohoConnection.mockResolvedValue(conn);
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

describe("processEvent precios Tiendanube → Zoho", () => {
  const variant = (price: number, promo: number | null = null) =>
    ({ product_id: 55, variant_id: 1, sku: "SKU-1", price, promotional_price: promo, inventory_levels: [] });
  const settingsRows = (prices_direction: string, prices_enabled = true) =>
    m.query.mockImplementation(async (sql: string) =>
      /FROM sync_settings/.test(sql) ? { rows: [{ prices_direction, prices_enabled }], rowCount: 1 } : { rows: [], rowCount: 1 });

  it("con zoho_to_tn nunca aplica precios a Zoho", async () => {
    settingsRows("zoho_to_tn");
    m.loadProductCatalog.mockResolvedValueOnce([variant(10)]).mockResolvedValueOnce([variant(12)]);
    await processEvent(row("product/updated", { id: 55 }));
    expect(m.applyPricesToZoho).not.toHaveBeenCalled();
  });

  it("con tn_to_zoho y precio cambiado lo aplica una vez con el SKU correcto", async () => {
    settingsRows("tn_to_zoho");
    m.loadProductCatalog.mockResolvedValueOnce([variant(10)]).mockResolvedValueOnce([variant(12, 9)]);
    await processEvent(row("product/updated", { id: 55 }));
    expect(m.loadProductCatalog).toHaveBeenCalledWith("1", 55);
    expect(m.applyPricesToZoho).toHaveBeenCalledOnce();
    expect(m.applyPricesToZoho).toHaveBeenCalledWith({}, conn, "1", [{ sku: "SKU-1", price: 12, promotional_price: 9 }]);
  });

  it("con precio igual (eco) no llama a Zoho", async () => {
    settingsRows("tn_to_zoho");
    m.loadProductCatalog.mockResolvedValue([variant(10)]);
    await processEvent(row("product/updated", { id: 55 }));
    expect(m.applyPricesToZoho).not.toHaveBeenCalled();
  });

  it("con prices_enabled=false no llama a Zoho", async () => {
    settingsRows("tn_to_zoho", false);
    m.loadProductCatalog.mockResolvedValueOnce([variant(10)]).mockResolvedValueOnce([variant(12)]);
    await processEvent(row("product/updated", { id: 55 }));
    expect(m.applyPricesToZoho).not.toHaveBeenCalled();
  });

  it("errores por SKU no hacen fallar el evento", async () => {
    settingsRows("tn_to_zoho");
    m.loadProductCatalog.mockResolvedValueOnce([variant(10)]).mockResolvedValueOnce([variant(12)]);
    m.applyPricesToZoho.mockResolvedValueOnce({ updated: 0, errors: 1 });
    await expect(processEvent(row("product/updated", { id: 55 }))).resolves.toBeUndefined();
  });

  it("sin conexión Zoho falla ANTES de refrescar, con la caché intacta para el reintento", async () => {
    settingsRows("tn_to_zoho");
    m.getZohoConnection.mockRejectedValue(new Error("Zoho no está conectado"));
    await expect(processEvent(row("product/updated", { id: 55 }))).rejects.toThrow("Zoho");
    expect(m.refreshProduct).not.toHaveBeenCalled();
    expect(m.applyPricesToZoho).not.toHaveBeenCalled();
  });

  it("orden: conexión → snapshot previo → refresh → snapshot posterior → aplicar", async () => {
    settingsRows("tn_to_zoho");
    m.loadProductCatalog.mockResolvedValueOnce([variant(10)]).mockResolvedValueOnce([variant(12)]);
    await processEvent(row("product/updated", { id: 55 }));
    const order = (f: { mock: { invocationCallOrder: number[] } }, i = 0) => f.mock.invocationCallOrder[i];
    expect(order(m.getZohoConnection)).toBeLessThan(order(m.loadProductCatalog, 0));
    expect(order(m.loadProductCatalog, 0)).toBeLessThan(order(m.refreshProduct));
    expect(order(m.refreshProduct)).toBeLessThan(order(m.loadProductCatalog, 1));
    expect(order(m.loadProductCatalog, 1)).toBeLessThan(order(m.applyPricesToZoho));
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
