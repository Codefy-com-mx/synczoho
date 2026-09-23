import { serve } from "../../runtime.js";
import { getLockPool, type DatabaseClient } from "../../db.js";
import { acquireSyncLock, type SyncLockHandle } from "../../sync-lock.js";
// Sincroniza precios de Zoho Inventory → Tiendanube vía PATCH /products/stock-price.
// Soporta dryRun (preview sin aplicar cambios).
import {
  corsHeaders,
  getAdminClient,
  getZohoConnection,
  zohoFetch,
  logSync,
} from "../_shared/zoho.js";
import { getStore, tnFetchWithRetry } from "../_shared/tiendanube.js";

const EPSILON = 0.01; // diferencia mínima para considerar que el precio cambió

function pricesMatch(a: number, b: number) {
  return Math.abs(a - b) < EPSILON;
}

function norm(s: any) {
  return (s ?? "").toString().trim().toUpperCase();
}

interface PricePair {
  zoho_item_id: string;
  sku: string;
  zoho_price: number;
  zoho_promo: number | null;
  tn_product_id: number;
  tn_variant_id: number;
  tn_price: number;
  tn_promo: number | null;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const t0 = Date.now();
  let storeId: string | null = null;
  let admin: DatabaseClient | null = null;
  let lock: SyncLockHandle | null = null;
  let terminalLogged = false;
  try {
    const body = await req.json();
    storeId = typeof body?.storeId === "string" ? body.storeId : null;
    const dryRun = body?.dryRun === true;
    if (!storeId) return json({ error: "storeId requerido" }, 400);

    // A real run takes the per-(store, operation) session advisory lock before
    // any Zoho/Tiendanube call. The lock comes from the dedicated lock pool so
    // it cannot starve handler queries. Contention returns a neutral response
    // without touching the network; dry runs stay lock-free and make no sync
    // writes, although the shared Zoho helper may still refresh credentials.
    if (!dryRun) {
      lock = await acquireSyncLock(getLockPool(), { storeId, operation: "price_sync_run" });
      if (!lock) {
        return json({ skipped: true, reason: "already_running" });
      }
    }

    admin = getAdminClient();
    const conn = await getZohoConnection(admin, storeId);
    const store = await getStore(admin, storeId);

    // 1) Cargar todos los items de Zoho (rate + sales_rate + sku)
    const zohoItems: { item_id: string; sku?: string; rate?: number; sales_rate?: number }[] = [];
    let page = 1;
    while (true) {
      const r = await zohoFetch(admin, conn, `/inventory/v1/items?per_page=200&page=${page}`);
      const j = await r.json();
      if (!r.ok) throw new Error(`Zoho items ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const items = j.items || [];
      zohoItems.push(...items);
      if (!j.page_context?.has_more_page) break;
      if (++page > 50) break;
    }

    // 2) Cargar todos los productos de Tiendanube con sus variantes y precios
    const tnProducts: any[] = [];
    let tnPage = 1;
    while (true) {
      const resp = await tnFetchWithRetry(store, `/products?per_page=200&page=${tnPage}&fields=id,variants`);
      if (!resp.ok) { await resp.text(); throw new Error(`Tiendanube products ${resp.status}`); }
      const arr = await resp.json();
      tnProducts.push(...arr);
      if (!arr || arr.length < 200) break;
      if (++tnPage > 50) break;
    }

    // 3) Mapear TN por SKU
    const tnBySku = new Map<string, {
      product_id: number;
      variant_id: number;
      price: number;
      promo: number | null;
    }>();
    for (const p of tnProducts) {
      for (const v of p.variants || []) {
        const sku = norm(v.sku);
        if (!sku) continue;
        if (!tnBySku.has(sku)) {
          tnBySku.set(sku, {
            product_id: p.id,
            variant_id: v.id,
            price: Number(v.price ?? 0),
            promo: v.promotional_price != null ? Number(v.promotional_price) : null,
          });
        }
      }
    }

    // 4) Cruzar por SKU y detectar diferencias de precio
    const toUpdate: PricePair[] = [];
    const alreadySync: PricePair[] = [];
    const unmatched: string[] = [];

    for (const it of zohoItems) {
      const sku = norm(it.sku);
      if (!sku) continue;
      const match = tnBySku.get(sku);
      if (!match) { unmatched.push(it.sku || it.item_id); continue; }

      const zohoPrice = Number(it.rate ?? 0);
      const zohoPriceRaw = Number(it.rate ?? 0);
      const zohoSalesRate = it.sales_rate != null ? Number(it.sales_rate) : null;
      // promotional_price: solo si sales_rate es distinto de rate
      const zohoPromo = (zohoSalesRate != null && !pricesMatch(zohoSalesRate, zohoPriceRaw))
        ? zohoSalesRate
        : null;

      const pair: PricePair = {
        zoho_item_id: it.item_id,
        sku: it.sku || "",
        zoho_price: zohoPrice,
        zoho_promo: zohoPromo,
        tn_product_id: match.product_id,
        tn_variant_id: match.variant_id,
        tn_price: match.price,
        tn_promo: match.promo,
      };

      const priceChanged = !pricesMatch(zohoPrice, match.price);
      const promoChanged = (zohoPromo !== null || match.promo !== null) &&
        !(zohoPromo === null && match.promo === null) &&
        (zohoPromo === null || match.promo === null || !pricesMatch(zohoPromo, match.promo));

      if (priceChanged || promoChanged) {
        toUpdate.push(pair);
      } else {
        alreadySync.push(pair);
      }
    }

    // ── DRY RUN ────────────────────────────────────────────────────────────────
    if (dryRun) {
      return json({
        dry_run: true,
        total: toUpdate.length + alreadySync.length,
        to_update: toUpdate.length,
        in_sync: alreadySync.length,
        unmatched: unmatched.length,
        unmatched_sample: unmatched.slice(0, 20),
        details: toUpdate.slice(0, 100).map((p) => ({
          sku: p.sku,
          tn_price: p.tn_price,
          new_price: p.zoho_price,
          tn_promo: p.tn_promo,
          new_promo: p.zoho_promo,
          dry_run: true,
        })),
      });
    }

    // ── MODO REAL ──────────────────────────────────────────────────────────────
    // Agrupar por product_id
    const byProduct = new Map<number, Array<{ id: number; price: string; promotional_price?: string | null }>>();
    for (const p of toUpdate) {
      if (!byProduct.has(p.tn_product_id)) byProduct.set(p.tn_product_id, []);
      const variant: { id: number; price: string; promotional_price?: string | null } = {
        id: p.tn_variant_id,
        price: p.zoho_price.toFixed(2),
      };
      // Enviar promotional_price: el nuevo valor o null para limpiarla
      variant.promotional_price = p.zoho_promo != null ? p.zoho_promo.toFixed(2) : null;
      byProduct.get(p.tn_product_id)!.push(variant);
    }

    const products = [...byProduct.entries()].map(([id, variants]) => ({ id, variants }));
    const CHUNK = 100;
    let updated = 0;
    let errors = 0;
    const details: any[] = [];

    for (let i = 0; i < products.length; i += CHUNK) {
      const chunk = products.slice(i, i + CHUNK);
      const r = await tnFetchWithRetry(store, "/products/stock-price", {
        method: "PATCH",
        body: JSON.stringify(chunk),
      });

      if (!r.ok) {
        const errText = await r.text();
        for (const prod of chunk) {
          const pairsInChunk = toUpdate.filter((p) => p.tn_product_id === prod.id);
          for (const p of pairsInChunk) {
            errors++;
            details.push({ sku: p.sku, error: `TN PATCH ${r.status}: ${errText.slice(0, 100)}` });
          }
        }
      } else {
        await r.text().catch(() => "");
        for (const prod of chunk) {
          const pairsInChunk = toUpdate.filter((p) => p.tn_product_id === prod.id);
          for (const p of pairsInChunk) {
            updated++;
            details.push({
              sku: p.sku,
              old_price: p.tn_price,
              new_price: p.zoho_price,
              old_promo: p.tn_promo,
              new_promo: p.zoho_promo,
            });
          }
        }
      }
    }

    await logSync(admin, storeId, {
      operation: "price_sync_run",
      status: errors === 0 ? "success" : "error",
      message: `Actualizados: ${updated} · Ya sincronizados: ${alreadySync.length} · Errores: ${errors} · Sin match: ${unmatched.length}`,
      duration_ms: Date.now() - t0,
      payload: { updated, in_sync: alreadySync.length, errors, unmatched: unmatched.length },
    });
    terminalLogged = true;

    return json({
      dry_run: false,
      total: toUpdate.length + alreadySync.length,
      updated,
      in_sync: alreadySync.length,
      errors,
      unmatched: unmatched.length,
      unmatched_sample: unmatched.slice(0, 20),
      details: details.slice(0, 100),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("sync-prices-run error", msg);
    // Best-effort terminal log: the shared logSync helper swallows write
    // failures and does not inspect QueryResult.error, so this row may be
    // missing. The guard only avoids a duplicate row when the run already
    // recorded its partial result.
    if (admin && storeId && !terminalLogged) {
      await logSync(admin, storeId, {
        operation: "price_sync_run",
        status: "error",
        message: msg,
        duration_ms: Date.now() - t0,
      });
    }
    return json({ error: msg }, 500);
  } finally {
    // The advisory lock and its pooled session must be released on every path,
    // including hard errors and interrupted runs.
    if (lock) await lock.release();
  }
});
