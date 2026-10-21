import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ deletePendingCatalogEvents: vi.fn(), deleted: [] as string[] }));

vi.mock("../../server/functions/_shared/tn-catalog.js", () => ({ deletePendingCatalogEvents: h.deletePendingCatalogEvents }));
vi.mock("../../server/functions/_shared/zoho.js", () => ({
  corsHeaders: {},
  getAdminClient: () => ({
    from: (table: string) => ({ delete: () => ({ eq: async () => { h.deleted.push(table); return { error: null }; } }) }),
  }),
}));

import handler from "../../server/functions/tiendanube-disconnect/index";

beforeEach(() => {
  h.deleted = [];
  h.deletePendingCatalogEvents.mockReset().mockResolvedValue(undefined);
});

describe("tiendanube-disconnect", () => {
  it("borra los eventos de catálogo pendientes de la tienda antes de borrar la tienda", async () => {
    h.deletePendingCatalogEvents.mockImplementation(async () => { h.deleted.push("webhook_events"); });
    const res = await handler(new Request("http://x/api/functions/v1/tiendanube-disconnect", {
      method: "POST", body: JSON.stringify({ store_id: "s1" }),
    }));
    expect(await res.json()).toEqual({ ok: true });
    expect(h.deletePendingCatalogEvents).toHaveBeenCalledWith("s1");
    expect(h.deleted.indexOf("webhook_events")).toBeLessThan(h.deleted.indexOf("stores"));
  });
});
