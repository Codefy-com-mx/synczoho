import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: any[] }>,
  stored: [] as any[],
  zoho: [] as any,
  fetchZohoLocations: vi.fn(),
}));

vi.mock("../../server/db.js", () => ({
  getPool: () => ({
    query: async (text: string, values: any[] = []) => {
      h.queries.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  }),
}));
vi.mock("../../server/functions/_shared/zoho.js", () => ({
  corsHeaders: {},
  getAdminClient: () => ({}),
  getZohoConnection: async () => ({ store_id: "s1" }),
}));
vi.mock("../../server/functions/_shared/tiendanube.js", () => ({ getStore: vi.fn() }));
vi.mock("../../server/functions/_shared/locations.js", () => ({
  fetchZohoLocations: h.fetchZohoLocations,
  loadLocationMappings: async () => h.stored,
  refreshLocationMappings: vi.fn(),
}));

import handler from "../../server/functions/location-mappings/index";

const row = (tn: string, zoho: string | null) => ({
  tn_location_id: tn, tn_location_name: tn, zoho_location_id: zoho, zoho_location_name: zoho,
});
const save = (mappings: unknown) =>
  handler(new Request("https://x/api/functions/v1/location-mappings", {
    method: "POST", body: JSON.stringify({ storeId: "s1", action: "save", mappings }),
  }));
const updates = () => h.queries.filter((q) => /^UPDATE/.test(q.text.trim()));

beforeEach(() => {
  h.queries.length = 0;
  h.stored = [row("A", "z1"), row("B", null), row("C", "z3")];
  h.fetchZohoLocations.mockReset();
  h.fetchZohoLocations.mockResolvedValue([
    { id: "z1", name: "Z1" }, { id: "z2", name: "Z2" }, { id: "z3", name: "Z3" },
  ]);
});

describe("location-mappings save", () => {
  it("503 si Zoho no está disponible (null) y no escribe", async () => {
    h.fetchZohoLocations.mockResolvedValue(null);
    const res = await save([{ tn_location_id: "B", zoho_location_id: "z2" }]);
    expect(res.status).toBe(503);
    expect(updates()).toHaveLength(0);
  });

  it("400 si el mismo zoho id va a dos locations del lote, sin escribir nada", async () => {
    const res = await save([
      { tn_location_id: "B", zoho_location_id: "z2" },
      { tn_location_id: "C", zoho_location_id: "z2" },
    ]);
    expect(res.status).toBe(400);
    expect(updates()).toHaveLength(0);
  });

  it("400 si el zoho id ya está guardado en otra location que no cambia", async () => {
    const res = await save([{ tn_location_id: "B", zoho_location_id: "z1" }]);
    expect(res.status).toBe(400);
    expect(updates()).toHaveLength(0);
  });

  it("acepta intercambiar dos vínculos en el mismo lote", async () => {
    const res = await save([
      { tn_location_id: "A", zoho_location_id: "z3" },
      { tn_location_id: "C", zoho_location_id: "z1" },
    ]);
    expect(res.status).toBe(200);
    expect(updates().map((q) => q.values.slice(1, 3))).toEqual([["A", "z3"], ["C", "z1"]]);
  });

  it("400 para un id de Zoho inexistente y para una location de Tiendanube desconocida", async () => {
    expect((await save([{ tn_location_id: "B", zoho_location_id: "nope" }])).status).toBe(400);
    expect((await save([{ tn_location_id: "X", zoho_location_id: null }])).status).toBe(400);
  });
});
