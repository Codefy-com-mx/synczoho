import { describe, expect, it } from "vitest";
import { buildStockPatch, deriveTnLocationCount, planStockChanges, resolveInitialLevels, zohoTotal, type ZohoStockItem } from "../../server/functions/_shared/stock-plan";
import type { CatalogVariant } from "../../server/functions/_shared/tn-catalog";
import { ZOHO_TOTAL, type LocationMapping } from "../../server/functions/_shared/locations";

const variant = (sku: string, levels: Array<[string, number]>, product_id = 10, variant_id = 100): CatalogVariant => ({
  product_id,
  variant_id,
  sku,
  price: 0,
  promotional_price: null,
  inventory_levels: levels.map(([location_id, stock]) => ({ location_id, stock })),
});
const mapping = (tn: string, zoho: string | null): LocationMapping => ({
  tn_location_id: tn,
  tn_location_name: `TN ${tn}`,
  zoho_location_id: zoho,
  zoho_location_name: zoho ? `Z ${zoho}` : null,
});
const base = { direction: "zoho_to_tn" as const, priority: "zoho" as const };

describe("planStockChanges", () => {
  it("(a) single legacy location: one change without location", () => {
    const zohoItems: ZohoStockItem[] = [{ item_id: "z1", sku: "SKU-1", stock_on_hand: 5 }];
    const plan = planStockChanges({
      ...base, zohoItems, catalog: [variant("SKU-1", [["L1", 3]])], mappings: [], tnLocationCount: 1,
    });
    expect(plan.blocked).toBeNull();
    expect(plan.changes).toEqual([
      { sku: "SKU-1", zoho_item_id: "z1", product_id: 10, variant_id: 100, tn_location_id: null, zoho_location_id: null, from: 3, to: 5, target: "tn" },
    ]);
    expect(buildStockPatch(plan.changes)).toEqual([{ id: 10, variants: [{ id: 100, inventory_levels: [{ stock: 5 }] }] }]);
  });

  it("legacy path also runs when location count is unknown (no scope)", () => {
    const plan = planStockChanges({
      ...base,
      zohoItems: [{ item_id: "z1", sku: "SKU-1", stock_on_hand: 5 }],
      catalog: [variant("SKU-1", [["L1", 3]])],
      mappings: [],
      tnLocationCount: null,
    });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].tn_location_id).toBeNull();
  });

  it("(b) two mapped locations: two explicit changes merged into one variant", () => {
    const zohoItems: ZohoStockItem[] = [{
      item_id: "z1", sku: "SKU-1", stock_on_hand: 12,
      locations: [{ location_id: "ZA", location_stock_on_hand: 7 }, { location_id: "ZB", location_stock_on_hand: "5" }],
    }];
    const plan = planStockChanges({
      ...base, zohoItems, catalog: [variant("SKU-1", [["L1", 1], ["L2", 2]])],
      mappings: [mapping("L1", "ZA"), mapping("L2", "ZB")], tnLocationCount: 2,
    });
    expect(plan.changes.map((c) => [c.tn_location_id, c.zoho_location_id, c.from, c.to, c.target])).toEqual([
      ["L1", "ZA", 1, 7, "tn"],
      ["L2", "ZB", 2, 5, "tn"],
    ]);
    expect(buildStockPatch(plan.changes)).toEqual([{
      id: 10,
      variants: [{ id: 100, inventory_levels: [{ location_id: "L1", stock: 7 }, { location_id: "L2", stock: 5 }] }],
    }]);
  });

  it("(c) two Tiendanube locations without mapping: blocked, no changes", () => {
    const plan = planStockChanges({
      ...base,
      zohoItems: [{ item_id: "z1", sku: "SKU-1", stock_on_hand: 5 }],
      catalog: [variant("SKU-1", [["L1", 3], ["L2", 0]])],
      mappings: [mapping("L1", null), mapping("L2", null)],
      tnLocationCount: 2,
    });
    expect(plan.blocked).toBe("locations_unmapped");
    expect(plan.changes).toEqual([]);
  });

  it("(d) an unmapped location among mapped ones is left untouched", () => {
    const plan = planStockChanges({
      ...base,
      zohoItems: [{ item_id: "z1", sku: "SKU-1", locations: [{ location_id: "ZA", location_stock_on_hand: 4 }] }],
      catalog: [variant("SKU-1", [["L1", 0], ["L2", 9]])],
      mappings: [mapping("L1", "ZA"), mapping("L2", null)],
      tnLocationCount: 2,
    });
    expect(plan.blocked).toBeNull();
    expect(plan.changes.map((c) => c.tn_location_id)).toEqual(["L1"]);
  });

  it("missing Tiendanube level counts as 0 and missing Zoho location stock counts as 0", () => {
    const plan = planStockChanges({
      ...base,
      zohoItems: [{ item_id: "z1", sku: "SKU-1", locations: [{ location_id: "ZA", location_stock_on_hand: 4 }] }],
      catalog: [variant("SKU-1", [["L2", 3]])],
      mappings: [mapping("L1", "ZA"), mapping("L2", "ZB")],
      tnLocationCount: 2,
    });
    expect(plan.changes.map((c) => [c.tn_location_id, c.from, c.to])).toEqual([["L1", 0, 4], ["L2", 3, 0]]);
  });

  it("Zoho location stock empty (\"\") is unknown, never 0: the pair is not touched", () => {
    const plan = planStockChanges({
      ...base,
      zohoItems: [{ item_id: "z1", sku: "SKU-1", locations: [{ location_id: "ZA", location_stock_on_hand: "" }] }],
      catalog: [variant("SKU-1", [["L1", 3]])],
      mappings: [mapping("L1", "ZA")],
      tnLocationCount: 1,
    });
    expect(plan.changes).toEqual([]);
  });

  it("(e) bidirectional: priority decides the target per pair, never negative", () => {
    const input = {
      zohoItems: [{ item_id: "z1", sku: "SKU-1", locations: [{ location_id: "ZA", location_stock_on_hand: -2 }] }],
      catalog: [variant("SKU-1", [["L1", 3]])],
      mappings: [mapping("L1", "ZA")],
      tnLocationCount: 1,
      direction: "bidirectional" as const,
    };
    const zohoWins = planStockChanges({ ...input, priority: "zoho" });
    expect(zohoWins.changes).toMatchObject([{ target: "tn", from: 3, to: 0 }]);
    const tnWins = planStockChanges({ ...input, priority: "tiendanube" });
    expect(tnWins.changes).toMatchObject([{ target: "zoho", from: -2, to: 3, zoho_location_id: "ZA" }]);
    expect(buildStockPatch(tnWins.changes)).toEqual([]);
  });

  it("(f) SKU without match goes to unmatched", () => {
    const plan = planStockChanges({
      ...base,
      zohoItems: [{ item_id: "z1", sku: "NOPE", stock_on_hand: 1 }, { item_id: "z2", sku: " sku-1 ", stock_on_hand: 3 }],
      catalog: [variant("SKU-1", [["L1", 3]])],
      mappings: [],
      tnLocationCount: 1,
    });
    expect(plan.unmatched).toEqual(["NOPE"]);
  });

  it("(g) equal stock counts as in sync", () => {
    const plan = planStockChanges({
      ...base,
      zohoItems: [{ item_id: "z1", sku: "SKU-1", locations: [{ location_id: "ZA", location_stock_on_hand: 3 }, { location_id: "ZB", location_stock_on_hand: 1 }] }],
      catalog: [variant("SKU-1", [["L1", 3], ["L2", 1]])],
      mappings: [mapping("L1", "ZA"), mapping("L2", "ZB")],
      tnLocationCount: 2,
    });
    expect(plan.changes).toEqual([]);
    expect(plan.inSync).toBe(2);
  });

  it("Zoho item without per-location data is skipped when locations are mapped (never guessed)", () => {
    const plan = planStockChanges({
      ...base,
      zohoItems: [{ item_id: "z1", sku: "SKU-1", stock_on_hand: 8 }],
      catalog: [variant("SKU-1", [["L1", 3]])],
      mappings: [mapping("L1", "ZA")],
      tnLocationCount: 1,
    });
    expect(plan.changes).toEqual([]);
  });
});

describe("planStockChanges with a ZOHO_TOTAL mapping", () => {
  const twoLocs = [variant("SKU-1", [["L1", 3], ["L2", 9]])];
  const totalMappings = [mapping("L1", null), { ...mapping("L2", ZOHO_TOTAL), zoho_location_name: "Stock total de Zoho" }];

  it("is not blocked: the total goes to the chosen location only, with a null zoho location", () => {
    const plan = planStockChanges({
      ...base, zohoItems: [{ item_id: "z1", sku: "SKU-1", stock_on_hand: 12 }],
      catalog: twoLocs, mappings: totalMappings, tnLocationCount: 2,
    });
    expect(plan.blocked).toBeNull();
    expect(plan.changes).toEqual([
      { sku: "SKU-1", zoho_item_id: "z1", product_id: 10, variant_id: 100, tn_location_id: "L2", zoho_location_id: null, from: 9, to: 12, target: "tn" },
    ]);
    expect(buildStockPatch(plan.changes)).toEqual([{ id: 10, variants: [{ id: 100, inventory_levels: [{ location_id: "L2", stock: 12 }] }] }]);
  });

  it("falls back to actual_available_stock and never goes negative", () => {
    const plan = planStockChanges({
      ...base, zohoItems: [{ item_id: "z1", sku: "SKU-1", actual_available_stock: -4 }],
      catalog: twoLocs, mappings: totalMappings, tnLocationCount: 2,
    });
    expect(plan.changes).toMatchObject([{ tn_location_id: "L2", from: 9, to: 0 }]);
  });

  it("bidirectional: priority decides the target; tiendanube priority adjusts the Zoho total", () => {
    const input = {
      zohoItems: [{ item_id: "z1", sku: "SKU-1", stock_on_hand: 12 }],
      catalog: twoLocs, mappings: totalMappings, tnLocationCount: 2, direction: "bidirectional" as const,
    };
    expect(planStockChanges({ ...input, priority: "zoho" }).changes).toMatchObject([{ target: "tn", from: 9, to: 12 }]);
    const tn = planStockChanges({ ...input, priority: "tiendanube" });
    expect(tn.changes).toMatchObject([{ target: "zoho", tn_location_id: "L2", zoho_location_id: null, from: 12, to: 9 }]);
    expect(buildStockPatch(tn.changes)).toEqual([]);
  });

  it.each(["zoho_to_tn", "tn_to_zoho", "bidirectional"] as const)("mixed total + real link (%s): blocked, no changes", (direction) => {
    const plan = planStockChanges({
      direction, priority: "zoho",
      zohoItems: [{ item_id: "z1", sku: "SKU-1", stock_on_hand: 12, locations: [{ location_id: "ZA", location_stock_on_hand: 4 }] }],
      catalog: twoLocs, mappings: [mapping("L1", "ZA"), mapping("L2", ZOHO_TOTAL)], tnLocationCount: 2,
    });
    expect(plan).toMatchObject({ changes: [], blocked: "locations_mixed" });
  });

  it("equal stock counts as in sync", () => {
    const plan = planStockChanges({
      ...base, zohoItems: [{ item_id: "z1", sku: "SKU-1", stock_on_hand: 9 }],
      catalog: twoLocs, mappings: totalMappings, tnLocationCount: 2,
    });
    expect(plan).toMatchObject({ changes: [], inSync: 1, blocked: null });
  });
});

describe("deriveTnLocationCount", () => {
  const unlinked = [mapping("L1", null), mapping("L2", null)];
  it("uses the live list when the fetch succeeded", () => {
    expect(deriveTnLocationCount([{}], unlinked, [])).toBe(1);
  });
  it("(1) fetch failed: stored mappings reveal 2 locations, so the plan blocks", () => {
    const count = deriveTnLocationCount(null, unlinked, [variant("SKU-1", [["L1", 3]])]);
    expect(count).toBe(2);
    const plan = planStockChanges({
      ...base, zohoItems: [{ item_id: "z1", sku: "SKU-1", stock_on_hand: 8 }],
      catalog: [variant("SKU-1", [["L1", 3]])], mappings: unlinked, tnLocationCount: count,
    });
    expect(plan).toMatchObject({ blocked: "locations_unmapped", changes: [] });
  });
  it("(2) fetch failed: catalog levels reveal 2 distinct locations without mappings", () => {
    expect(deriveTnLocationCount(null, [], [variant("A", [["L1", 3]]), variant("B", [["L1", 1], ["L2", 4]], 11, 110)])).toBe(2);
  });
  it("(3) fetch failed: a single known location keeps the legacy path", () => {
    expect(deriveTnLocationCount(null, [], [variant("A", [["L1", 3]]), variant("B", [["L1", 1]], 11, 110)])).toBe(1);
  });
  it("(4) fetch failed and nothing known: null (legacy path)", () => {
    expect(deriveTnLocationCount(null, [], [variant("A", [])])).toBeNull();
  });
});

describe("resolveInitialLevels", () => {
  const zl = [{ location_id: "Z1", stock: 7.9 }, { location_id: "Z2", stock: 3 }];
  it("linked real mappings: one explicit level per linked TN location, missing -> 0, unlinked skipped", () => {
    const r = resolveInitialLevels({
      total: 99, zohoLocations: zl, tnLocationCount: 3,
      mappings: [mapping("L1", "Z1"), mapping("L2", "Z9"), mapping("L3", null)],
    });
    expect(r).toEqual({ levels: [{ location_id: "L1", stock: 7 }, { location_id: "L2", stock: 0 }] });
  });
  it.each([[undefined], [[]]])("linked real mapping with zohoLocations %j: nothing sent (never assume 0)", (zohoLocations) => {
    expect(resolveInitialLevels({ total: 5, zohoLocations, mappings: [mapping("L1", "Z1")], tnLocationCount: 1 }))
      .toEqual({ levels: [], warning: "stock por almacén no disponible" });
  });
  it("location absent from a NON-empty received list: 0", () => {
    expect(resolveInitialLevels({
      total: 5, zohoLocations: [{ location_id: "Z2", stock: 4 }], mappings: [mapping("L1", "Z1")], tnLocationCount: 1,
    }).levels).toEqual([{ location_id: "L1", stock: 0 }]);
  });
  it("ZOHO_TOTAL mapping: one level with the total on that TN location", () => {
    expect(resolveInitialLevels({
      total: 12.7, mappings: [mapping("L1", ZOHO_TOTAL), mapping("L2", null)], tnLocationCount: 2,
    })).toEqual({ levels: [{ location_id: "L1", stock: 12 }] });
  });
  it("total + real link: no levels, mixed warning", () => {
    expect(resolveInitialLevels({
      total: 5, zohoLocations: zl, mappings: [mapping("L1", ZOHO_TOTAL), mapping("L2", "Z1")], tnLocationCount: 2,
    })).toEqual({ levels: [], warning: "locations mezcladas" });
  });
  it.each([null, 0, 1])("no links and tnLocationCount %s: legacy level without location_id", (n) => {
    expect(resolveInitialLevels({ total: 4, mappings: [mapping("L1", null)], tnLocationCount: n }))
      .toEqual({ levels: [{ stock: 4 }] });
  });
  it("no links and 2+ TN locations: nothing sent, unmapped warning", () => {
    expect(resolveInitialLevels({ total: 4, mappings: [], tnLocationCount: 2 }))
      .toEqual({ levels: [], warning: "locations sin mapear" });
  });
  it("floors and never goes negative", () => {
    expect(resolveInitialLevels({ total: -3, mappings: [], tnLocationCount: 1 }).levels).toEqual([{ stock: 0 }]);
    expect(resolveInitialLevels({
      total: 1, zohoLocations: [{ location_id: "Z1", stock: -2.5 }], mappings: [mapping("L1", "Z1")], tnLocationCount: 1,
    }).levels).toEqual([{ location_id: "L1", stock: 0 }]);
  });
});

describe("zohoTotal", () => {
  it("only finite numbers or non-empty numeric strings count", () => {
    expect(zohoTotal({ stock_on_hand: 4 })).toBe(4);
    expect(zohoTotal({ stock_on_hand: 0 })).toBe(0);
    expect(zohoTotal({ stock_on_hand: "0" } as any)).toBe(0);
    expect(zohoTotal({ stock_on_hand: " 7.5 " } as any)).toBe(7.5);
    expect(zohoTotal({ actual_available_stock: 3 })).toBe(3);
    expect(zohoTotal({ stock_on_hand: "" as any, actual_available_stock: 3 })).toBe(3);
    expect(zohoTotal({})).toBeNull();
    expect(zohoTotal({ stock_on_hand: "" } as any)).toBeNull();
    expect(zohoTotal({ stock_on_hand: null } as any)).toBeNull();
    expect(zohoTotal({ stock_on_hand: "abc" } as any)).toBeNull();
  });
});

describe("planStockChanges without a Zoho stock value (service / non-tracked items)", () => {
  const cases = [
    { name: "zoho_to_tn legacy", direction: "zoho_to_tn" as const, priority: "zoho" as const, mappings: [] as LocationMapping[] },
    { name: "bidirectional legacy", direction: "bidirectional" as const, priority: "zoho" as const, mappings: [] as LocationMapping[] },
    { name: "bidirectional tiendanube priority", direction: "bidirectional" as const, priority: "tiendanube" as const, mappings: [] as LocationMapping[] },
    { name: "ZOHO_TOTAL", direction: "zoho_to_tn" as const, priority: "zoho" as const, mappings: [mapping("L1", ZOHO_TOTAL)] },
  ];
  for (const c of cases) {
    for (const extra of [{}, { stock_on_hand: "" }, { stock_on_hand: null }]) {
      it(`${c.name} ${JSON.stringify(extra)}: no change, never 0`, () => {
        const plan = planStockChanges({
          direction: c.direction, priority: c.priority, mappings: c.mappings, tnLocationCount: 1,
          zohoItems: [{ item_id: "z1", sku: "SKU-1", ...extra } as any],
          catalog: [variant("SKU-1", [["L1", 12]])],
        });
        expect(plan.changes).toEqual([]);
        expect(plan.inSync).toBe(0);
      });
    }
  }

  it.each([0, "0"])("a genuine Zoho 0 (%j) still produces a change to 0", (stock) => {
    for (const mappings of [[], [mapping("L1", ZOHO_TOTAL)]]) {
      const plan = planStockChanges({
        ...base, mappings, tnLocationCount: 1,
        zohoItems: [{ item_id: "z1", sku: "SKU-1", stock_on_hand: stock } as any],
        catalog: [variant("SKU-1", [["L1", 12]])],
      });
      expect(plan.changes.map((ch) => [ch.from, ch.to])).toEqual([[12, 0]]);
    }
  });
});

describe("planStockChanges with two Zoho items sharing a SKU", () => {
  it.each([
    ["legacy", [] as LocationMapping[]],
    ["ZOHO_TOTAL", [mapping("L1", ZOHO_TOTAL)]],
    ["real locations", [mapping("L1", "ZA")]],
  ])("%s: the first Zoho item wins, one entry per variant/location", (_n, mappings) => {
    const plan = planStockChanges({
      ...base, mappings, tnLocationCount: 1,
      zohoItems: [
        { item_id: "z1", sku: "SKU-1", stock_on_hand: 5, locations: [{ location_id: "ZA", location_stock_on_hand: 5 }] },
        { item_id: "z2", sku: "sku-1", stock_on_hand: 9, locations: [{ location_id: "ZA", location_stock_on_hand: 9 }] },
      ],
      catalog: [variant("SKU-1", [["L1", 3]])],
    });
    expect(plan.changes.map((ch) => [ch.zoho_item_id, ch.to])).toEqual([["z1", 5]]);
    expect(buildStockPatch(plan.changes)[0].variants[0].inventory_levels).toHaveLength(1);
  });

  it("once in sync with the first item, a duplicate does not report a change every run", () => {
    const plan = planStockChanges({
      ...base, mappings: [], tnLocationCount: 1,
      zohoItems: [{ item_id: "z1", sku: "SKU-1", stock_on_hand: 3 }, { item_id: "z2", sku: "SKU-1", stock_on_hand: 9 }],
      catalog: [variant("SKU-1", [["L1", 3]])],
    });
    expect(plan.changes).toEqual([]);
    expect(plan.inSync).toBe(1);
  });
});

describe("resolveInitialLevels without a Zoho total", () => {
  it.each([
    ["legacy", [] as LocationMapping[]],
    ["ZOHO_TOTAL", [mapping("L1", ZOHO_TOTAL)]],
  ])("%s: no levels and 'stock no disponible'", (_n, mappings) => {
    expect(resolveInitialLevels({ total: null, mappings, tnLocationCount: 1 }))
      .toEqual({ levels: [], warning: "stock no disponible" });
  });

  it("real locations do not need the total", () => {
    expect(resolveInitialLevels({
      total: null, zohoLocations: [{ location_id: "Z1", stock: 4 }], mappings: [mapping("L1", "Z1")], tnLocationCount: 1,
    }).levels).toEqual([{ location_id: "L1", stock: 4 }]);
  });
});
