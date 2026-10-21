import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ updates: [] as any[], inserts: [] as any[], existing: { id: "x" } as any }));

vi.mock("../../server/functions/_shared/zoho.js", () => ({
  corsHeaders: {},
  getAdminClient: () => ({
    from: () => {
      const b: any = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: h.existing });
      b.update = (v: any) => { h.updates.push(v); return b; };
      b.insert = async (v: any) => { h.inserts.push(v); };
      return b;
    },
  }),
}));

import syncSettings from "../../server/functions/sync-settings/index";

const save = (settings: Record<string, unknown>) =>
  syncSettings(new Request("http://localhost/x", {
    method: "POST",
    body: JSON.stringify({ storeId: "s1", action: "save", settings }),
  }));

beforeEach(() => { h.updates = []; h.inserts = []; h.existing = { id: "x" }; });

describe("sync-settings prices_direction", () => {
  it("persiste los dos valores permitidos", async () => {
    await save({ prices_direction: "tn_to_zoho" });
    await save({ prices_direction: "zoho_to_tn" });
    expect(h.updates.map((u) => u.prices_direction)).toEqual(["tn_to_zoho", "zoho_to_tn"]);
  });

  it("ignora cualquier otro valor", async () => {
    await save({ prices_direction: "bidirectional", prices_enabled: true });
    expect(h.updates[0]).not.toHaveProperty("prices_direction");
    expect(h.updates[0]).toMatchObject({ prices_enabled: true });
  });

  it("el insert inicial usa zoho_to_tn por defecto", async () => {
    h.existing = null;
    await save({ prices_enabled: true });
    expect(h.inserts[0].prices_direction).toBe("zoho_to_tn");
  });
});
