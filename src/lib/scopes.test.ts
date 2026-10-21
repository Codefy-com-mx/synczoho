import { describe, expect, it } from "vitest";
import { REQUIRED_SCOPES, missingScopes } from "../../server/functions/_shared/scopes";

describe("missingScopes", () => {
  it("exposes the four MultiCD scopes", () => {
    expect(REQUIRED_SCOPES).toEqual(["read_products", "write_products", "read_locations", "read_fulfillment_orders"]);
  });

  it("returns the absent ones in required order", () => {
    expect(missingScopes("read_products,write_products")).toEqual(["read_locations", "read_fulfillment_orders"]);
  });

  it("returns [] when all four are granted, ignoring extras", () => {
    expect(missingScopes("read_orders,read_products,write_products,read_locations,read_fulfillment_orders")).toEqual([]);
  });

  it("returns all four for null, undefined or empty", () => {
    for (const v of [null, undefined, "", "  "]) expect(missingScopes(v)).toEqual([...REQUIRED_SCOPES]);
  });

  it("splits on commas and whitespace and trims", () => {
    expect(missingScopes(" read_products , write_products\nread_locations  read_fulfillment_orders ")).toEqual([]);
  });

  it("is case-sensitive", () => {
    expect(missingScopes("READ_PRODUCTS,write_products,read_locations,read_fulfillment_orders")).toEqual(["read_products"]);
  });
});
