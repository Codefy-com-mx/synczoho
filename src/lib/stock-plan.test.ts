import { describe, expect, it } from "vitest";
import { buildStockPatch, deriveTnLocationCount, planStockChanges, type ZohoStockItem } from "../../server/functions/_shared/stock-plan";
import type { CatalogVariant } from "../../server/functions/_shared/tn-catalog";
import type { LocationMapping } from "../../server/functions/_shared/locations";

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
