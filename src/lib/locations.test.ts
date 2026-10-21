import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: any[] }>,
  rows: [] as any[],
  zohoFetch: vi.fn(),
}));

vi.mock("../../server/db.js", () => ({
  getPool: () => ({
    query: async (text: string, values: any[] = []) => {
      h.queries.push({ text, values });
      return { rows: /^\s*SELECT/i.test(text) ? h.rows : [], rowCount: 1 };
    },
  }),
}));
vi.mock("../../server/functions/_shared/zoho.js", () => ({ zohoFetch: h.zohoFetch }));

import {
  ZOHO_TOTAL,
  autoMatchLocations,
  fetchTnLocations,
  fetchZohoLocations,
  refreshLocationMappings,
  type LocationMapping,
} from "../../server/functions/_shared/locations.js";

const store = { store_id: "s1", access_token: "tok", store_name: null };
const tn = (id: string, name: string) => ({ id, name });
const zo = (id: string, name: string) => ({ id, name });
const existing = (tnId: string, zohoId: string | null): LocationMapping => ({
  tn_location_id: tnId, tn_location_name: tnId, zoho_location_id: zohoId, zoho_location_name: zohoId && `old-${zohoId}`,
});
const stubFetch = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

beforeEach(() => {
  h.queries.length = 0;
  h.rows = [];
  h.zohoFetch.mockReset();
  vi.unstubAllGlobals();
});

describe("autoMatchLocations", () => {
  it("empareja por nombre sin acentos ni mayúsculas", () => {
    const [m] = autoMatchLocations(
      [tn("A", "Depósito Central"), tn("B", "Otro")], [zo("z1", " Deposito central "), zo("z2", "Zeta")], [],
    );
    expect(m).toMatchObject({ tn_location_id: "A", zoho_location_id: "z1", zoho_location_name: " Deposito central " });
  });

  it("1 TN + 1 Zoho con nombres distintos se vinculan", () => {
    const [m] = autoMatchLocations([tn("A", "Tienda")], [zo("z1", "Bodega")], []);
    expect(m.zoho_location_id).toBe("z1");
  });

  it("2 TN + 1 Zoho con nombres distintos no vincula ninguno", () => {
    const out = autoMatchLocations([tn("A", "Uno"), tn("B", "Dos")], [zo("z1", "Bodega")], []);
    expect(out.map((m) => m.zoho_location_id)).toEqual([null, null]);
  });

  it("conserva el mapeo existente aunque los nombres no coincidan", () => {
    const [a, b] = autoMatchLocations(
      [tn("A", "Uno"), tn("B", "Dos")], [zo("z1", "Dos"), zo("z2", "Tres")], [existing("A", "z1")],
    );
    expect(a.zoho_location_id).toBe("z1");
    expect(a.zoho_location_name).toBe("Dos");
    expect(b.zoho_location_id).toBeNull(); // z1 ya está usado por A
  });

  it("un mapeo cuyo id de Zoho desapareció vuelve a null", () => {
    const out = autoMatchLocations([tn("A", "Uno"), tn("B", "Dos")], [zo("z9", "Otra")], [existing("A", "z1")]);
    expect(out[0].zoho_location_id).toBeNull();
    expect(out[0].zoho_location_name).toBeNull();
  });
});

describe("ZOHO_TOTAL", () => {
  it("autoMatch conserva el vínculo al total aunque no esté en la lista de Zoho", () => {
    const out = autoMatchLocations([tn("A", "Central"), tn("B", "Norte")], [], [existing("A", null), existing("B", ZOHO_TOTAL)]);
    expect(out.map((m) => m.zoho_location_id)).toEqual([null, ZOHO_TOTAL]);
    expect(out[1].zoho_location_name).toBe("Stock total de Zoho");
  });

  it("refresh con lista [] conserva el total y lo persiste", async () => {
    stubFetch(200, [{ id: "A", name: "Tienda" }, { id: "B", name: "Filial" }]);
    h.rows = [existing("B", ZOHO_TOTAL)];
    h.zohoFetch.mockResolvedValue(new Response("{}", { status: 400 }));
    const out = await refreshLocationMappings({} as any, store, { store_id: "s1" } as any);
    expect(out.mappings.map((m) => m.zoho_location_id)).toEqual([null, ZOHO_TOTAL]);
    const ins = h.queries.find((q) => /INSERT INTO location_mappings/.test(q.text))!;
    expect(ins.values[3]).toEqual([null, ZOHO_TOTAL]);
  });
});

describe("fetchTnLocations", () => {
  it("403 sin scope devuelve null", async () => {
    stubFetch(403, {});
    expect(await fetchTnLocations(store)).toBeNull();
  });

  it("200 devuelve ids string con el nombre resuelto", async () => {
    stubFetch(200, [
      { id: "01HTMFDH09VC6E2Q8KGTGP44D3", name: { es: "Central", pt: "Centro" } },
      { id: "01HTMFDH09VC6E2Q8KGTGP44D4", name: { pt: "Filial", en: "Branch" } },
      { id: "01HTMFDH09VC6E2Q8KGTGP44D5", name: "Plano" },
      { id: "01HTMFDH09VC6E2Q8KGTGP44D6", name: {} },
    ]);
    expect(await fetchTnLocations(store)).toEqual([
      { id: "01HTMFDH09VC6E2Q8KGTGP44D3", name: "Central" },
      { id: "01HTMFDH09VC6E2Q8KGTGP44D4", name: "Filial" },
      { id: "01HTMFDH09VC6E2Q8KGTGP44D5", name: "Plano" },
      { id: "01HTMFDH09VC6E2Q8KGTGP44D6", name: "Location" },
    ]);
  });
});

describe("fetchZohoLocations", () => {
  const conn: any = { store_id: "s1" };
  it("4xx distinto de 429 devuelve [] (org sin multi-location)", async () => {
    h.zohoFetch.mockResolvedValue(new Response("{}", { status: 400 }));
    expect(await fetchZohoLocations({} as any, conn)).toEqual([]);
  });

  it.each([429, 503])("%i devuelve null (transitorio)", async (status) => {
    h.zohoFetch.mockResolvedValue(new Response("{}", { status }));
    expect(await fetchZohoLocations({} as any, conn)).toBeNull();
  });

  it("200 sin locations devuelve []", async () => {
    h.zohoFetch.mockResolvedValue(new Response(JSON.stringify({ locations: [] })));
    expect(await fetchZohoLocations({} as any, conn)).toEqual([]);
  });

  it("mapea location_id y location_name", async () => {
    h.zohoFetch.mockResolvedValue(new Response(JSON.stringify({ locations: [{ location_id: "9", location_name: "Main" }] })));
    expect(await fetchZohoLocations({} as any, conn)).toEqual([{ id: "9", name: "Main" }]);
  });
});

describe("refreshLocationMappings", () => {
  const conn: any = { store_id: "s1" };

  it("sin scope (tn null) no modifica filas y devuelve las existentes", async () => {
    stubFetch(403, {});
    h.rows = [existing("A", "z1")];
    h.zohoFetch.mockResolvedValue(new Response(JSON.stringify({ locations: [{ location_id: "z1", location_name: "Z" }] })));
    const out = await refreshLocationMappings({} as any, store, conn);
    expect(out).toEqual({
      mappings: h.rows, tn_available: false, zoho_available: true, zoho_locations: [{ id: "z1", name: "Z" }],
    });
    expect(h.queries.every((q) => /^\s*SELECT/i.test(q.text))).toBe(true);
  });

  it("persiste con upsert y borra locations que ya no existen en Tiendanube", async () => {
    stubFetch(200, [{ id: "A", name: { es: "Tienda" } }]);
    h.zohoFetch.mockResolvedValue(new Response(JSON.stringify({ locations: [{ location_id: "z1", location_name: "Bodega" }] })));
    const out = await refreshLocationMappings({} as any, store, conn);
    expect(out.tn_available).toBe(true);
    expect(out.zoho_available).toBe(true);
    expect(out.mappings).toEqual([
      { tn_location_id: "A", tn_location_name: "Tienda", zoho_location_id: "z1", zoho_location_name: "Bodega" },
    ]);
    const sqls = h.queries.map((q) => q.text).join("\n");
    expect(sqls).toMatch(/INSERT INTO location_mappings/);
    expect(sqls).toMatch(/DELETE FROM location_mappings/);
    const del = h.queries.find((q) => /DELETE FROM location_mappings/.test(q.text))!;
    expect(del.values).toEqual(["s1", ["A"]]);
  });

  it("con Zoho caído (null) conserva los vínculos y no los persiste como null", async () => {
    stubFetch(200, [{ id: "A", name: "Tienda" }]);
    h.rows = [existing("A", "z1")];
    h.zohoFetch.mockResolvedValue(new Response("{}", { status: 503 }));
    const out = await refreshLocationMappings({} as any, store, conn);
    expect(out.zoho_available).toBe(false);
    expect(out.mappings[0]).toMatchObject({ zoho_location_id: "z1", zoho_location_name: "old-z1" });
    const ins = h.queries.find((q) => /INSERT INTO location_mappings/.test(q.text))!;
    expect(ins.values[3]).toEqual(["z1"]);
  });

  it("con lista [] y conexión activa limpia los vínculos y los persiste", async () => {
    stubFetch(200, [{ id: "A", name: "Tienda" }, { id: "B", name: "Filial" }]);
    h.rows = [existing("A", "z1")];
    h.zohoFetch.mockResolvedValue(new Response("{}", { status: 400 }));
    const out = await refreshLocationMappings({} as any, store, conn);
    expect(out.zoho_available).toBe(false);
    expect(out.mappings.map((m) => m.zoho_location_id)).toEqual([null, null]);
    const ins = h.queries.find((q) => /INSERT INTO location_mappings/.test(q.text))!;
    expect(ins.values[3]).toEqual([null, null]);
  });

  it("sin conexión Zoho conserva los vínculos existentes", async () => {
    stubFetch(200, [{ id: "A", name: "Tienda" }]);
    h.rows = [existing("A", "z1")];
    const out = await refreshLocationMappings({} as any, store, null);
    expect(out.zoho_available).toBe(false);
    expect(out.mappings[0]).toMatchObject({ zoho_location_id: "z1", zoho_location_name: "old-z1" });
  });
});
