import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storeTables } from "../../server/webhook-worker";

describe("limpieza y migración por tienda", () => {
  it("borra las tablas nuevas al eliminar una tienda", () => {
    expect(storeTables).toEqual(expect.arrayContaining(["tn_variants", "tn_categories", "location_mappings"]));
  });

  it("la migración 004 crea las tablas y columnas de homologación", () => {
    const sql = readFileSync("server/migrations/004_homologation.sql", "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS tn_variants");
    expect(sql).toContain("prices_direction");
    expect(sql).toContain("catalog_status");
  });
});
