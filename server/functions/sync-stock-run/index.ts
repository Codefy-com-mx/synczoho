import { serve } from "../../runtime.js";
import { getLockPool, type DatabaseClient } from "../../db.js";
import { acquireSyncLock, type SyncLockHandle } from "../../sync-lock.js";
// Sincroniza stock entre Zoho y Tiendanube según settings.
// Modo on-demand: corre un sync completo (Zoho → TN, TN → Zoho o bidireccional).
// Vincula automáticamente productos por SKU si aún no están mapeados.
// Mejoras v2:
//   - TN updates vía PATCH /products/stock-price (batch, hasta 100 productos por chunk)
//   - inventory_levels con location_id (recomendación de certificación TN)
//   - Retry automático en 429 vía tnFetchWithRetry
//   - dryRun: simula sin aplicar cambios
import {
  corsHeaders,
  getAdminClient,
  getZohoConnection,
  zohoFetch,
  logSync,
} from "../_shared/zoho.js";
import {
  getStore,
  tnFetchWithRetry,
  getTnDefaultLocationId,
} from "../_shared/tiendanube.js";

interface PairItem {
  zoho_item_id: string;
  zoho_sku: string;
  zoho_qty: number;
  tn_product_id: number;
  tn_variant_id: number;
  tn_qty: number;
}

type SyncTarget = "tn" | "zoho" | null;

function getTarget(
  p: PairItem,
  direction: string,
  priority: string,
): SyncTarget {
  if (p.zoho_qty === p.tn_qty) return null;
  if (direction === "zoho_to_tn") return "tn";
  if (direction === "tn_to_zoho") return "zoho";
  return priority === "zoho" ? "tn" : "zoho";
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
    if (!storeId) {
      return json({ error: "storeId requerido" }, 400);
    }
    admin = getAdminClient();
    const { data: settings } = await admin
      .from("sync_settings")
      .select("*")
      .eq("store_id", storeId)
      .maybeSingle();

    if (!settings?.stock_enabled) {
      return json({ error: "Sincronización de stock deshabilitada" }, 400);
    }

    // A real run takes the per-(store, operation) session advisory lock before
    // any Zoho/Tiendanube call or write. The lock comes from the dedicated
    // lock pool so it cannot starve handler queries. Contention returns a
    // neutral response without touching the network; dry runs stay lock-free
    // and make no sync writes, although the shared Zoho helper may still
    // refresh credentials.
    if (!dryRun) {
      lock = await acquireSyncLock(getLockPool(), { storeId, operation: "stock_sync_run" });
      if (!lock) {
        return json({ skipped: true, reason: "already_running" });
      }
    }

    const direction = settings.stock_direction as "zoho_to_tn" | "tn_to_zoho" | "bidirectional";
    const priority = settings.stock_priority as "zoho" | "tiendanube";

    const conn = await getZohoConnection(admin, storeId);
    const store = await getStore(admin, storeId);

    // 1) Cargar TODOS los items de Zoho (con stock + sku)
    const zohoItems: {
      item_id: string; sku?: string; name?: string;
      stock_on_hand?: number; actual_available_stock?: number;
    }[] = [];
    let page = 1;
    while (true) {
      const r = await zohoFetch(admin, conn, `/inventory/v1/items?per_page=200&page=${page}`);
      const j = await r.json();
      if (!r.ok) throw new Error(`Zoho items ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const items = j.items || [];
      zohoItems.push(...items);
      if (!j.page_context?.has_more_page) break;
      page++;
      if (page > 50) break;
    }

    // 2) Cargar productos de Tiendanube (con variantes/sku/stock)
    const tnProducts: any[] = [];
    let tnPage = 1;
    while (true) {
      const resp = await tnFetchWithRetry(store, `/products?per_page=200&page=${tnPage}&fields=id,variants`);
      if (!resp.ok) { await resp.text(); throw new Error(`Tiendanube products ${resp.status}`); }
      const arr = await resp.json();
      tnProducts.push(...arr);
      if (!arr || arr.length < 200) break;
      tnPage++;
      if (tnPage > 50) break;
    }

    // 3) Construir mapa por SKU (case-insensitive, trim)
    const norm = (s: any) => (s ?? "").toString().trim().toUpperCase();
    const tnBySku = new Map<string, { product_id: number; variant_id: number; stock: number }>();
    for (const p of tnProducts) {
      for (const v of p.variants || []) {
        const sku = norm(v.sku);
        if (!sku) continue;
        if (!tnBySku.has(sku)) {
          tnBySku.set(sku, { product_id: p.id, variant_id: v.id, stock: Number(v.stock ?? 0) });
        }
      }
    }

    // 4) Cruzar por SKU
    const pairs: PairItem[] = [];
    const unmatched: string[] = [];
    for (const it of zohoItems) {
      const sku = norm(it.sku);
      if (!sku) continue;
      const match = tnBySku.get(sku);
      if (!match) { unmatched.push(it.sku || it.item_id); continue; }
      pairs.push({
        zoho_item_id: it.item_id,
        zoho_sku: it.sku || "",
        zoho_qty: Number(it.stock_on_hand ?? it.actual_available_stock ?? 0),
        tn_product_id: match.product_id,
        tn_variant_id: match.variant_id,
        tn_qty: match.stock,
      });
    }

    // 5) Clasificar targets
    const tnPairs = pairs.filter((p) => getTarget(p, direction, priority) === "tn");
    const zohoPairs = pairs.filter((p) => getTarget(p, direction, priority) === "zoho");
    const inSyncPairs = pairs.filter((p) => getTarget(p, direction, priority) === null);

    // ── DRY RUN ──────────────────────────────────────────────────────────────
    if (dryRun) {
      return json({
        dry_run: true,
        total: pairs.length,
        updated: tnPairs.length + zohoPairs.length,
        inSync: inSyncPairs.length,
        errors: 0,
        unmatched: unmatched.length,
        unmatched_sample: unmatched.slice(0, 20),
        details: [
          ...tnPairs.map((p) => ({ sku: p.zoho_sku, from: p.tn_qty, to: p.zoho_qty, target: "tn", dry_run: true })),
          ...zohoPairs.map((p) => ({ sku: p.zoho_sku, from: p.zoho_qty, to: p.tn_qty, target: "zoho", dry_run: true })),
        ].slice(0, 100),
      });
    }

    // ── MODO REAL ─────────────────────────────────────────────────────────────

    // 6) Auto-vincular en product_sync_map
    for (const p of pairs) {
      await admin.from("product_sync_map").upsert(
        {
          store_id: storeId,
          zoho_item_id: p.zoho_item_id,
          zoho_sku: p.zoho_sku,
          tiendanube_product_id: p.tn_product_id,
          status: "linked",
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "store_id,zoho_item_id" },
      );
    }

    let updated = 0;
    let errors = 0;
    const details: any[] = [];

    // 7a) TN updates — batch via PATCH /products/stock-price ──────────────────
    if (tnPairs.length > 0) {
      // Obtener location_id del primer depósito activo
      const locationId = await getTnDefaultLocationId(store);

      // Primero, habilitar stock_management en variantes que no lo tengan
      // (PATCH /products/stock-price no expone este flag; lo seteamos vía PUT)
      for (const p of tnPairs) {
        const r = await tnFetchWithRetry(store, `/products/${p.tn_product_id}/variants/${p.tn_variant_id}`, {
          method: "PUT",
          body: JSON.stringify({ stock_management: true }),
        });
        // 422 = ya estaba habilitado — ignorar
        if (!r.ok && r.status !== 422) {
          await r.text(); // consumir body
        } else {
          await r.text().catch(() => "");
        }
      }

      // Agrupar por product_id
      const byProduct = new Map<number, Array<{ id: number; inventory_levels: Array<{ location_id: number | null; stock: number }> }>>();
      for (const p of tnPairs) {
        if (!byProduct.has(p.tn_product_id)) byProduct.set(p.tn_product_id, []);
        byProduct.get(p.tn_product_id)!.push({
          id: p.tn_variant_id,
          inventory_levels: [{ location_id: locationId, stock: p.zoho_qty }],
        });
      }

      // Enviar en chunks de hasta 100 productos por request
      const CHUNK = 100;
      const products = [...byProduct.entries()].map(([id, variants]) => ({ id, variants }));

      for (let i = 0; i < products.length; i += CHUNK) {
        const chunk = products.slice(i, i + CHUNK);
        const r = await tnFetchWithRetry(store, "/products/stock-price", {
          method: "PATCH",
          body: JSON.stringify(chunk),
        });

        if (!r.ok) {
          const errText = await r.text();
          // Marcar todas las variantes de este chunk como error
          for (const prod of chunk) {
            const chunkPairs = tnPairs.filter((p) => p.tn_product_id === prod.id);
            for (const p of chunkPairs) {
              errors++;
              details.push({ sku: p.zoho_sku, error: `TN batch PATCH ${r.status}: ${errText.slice(0, 120)}` });
            }
          }
        } else {
          await r.text().catch(() => "");
          // Éxito — registrar y actualizar stock_sync_state
          for (const prod of chunk) {
            const chunkPairs = tnPairs.filter((p) => p.tn_product_id === prod.id);
            for (const p of chunkPairs) {
              updated++;
              details.push({ sku: p.zoho_sku, from: p.tn_qty, to: p.zoho_qty, target: "tn" });
              await admin.from("stock_sync_state").upsert(
                {
                  store_id: storeId,
                  sku: p.zoho_sku || p.zoho_item_id,
                  zoho_item_id: p.zoho_item_id,
                  tiendanube_product_id: p.tn_product_id,
                  tiendanube_variant_id: p.tn_variant_id,
                  last_qty: p.zoho_qty,
                  last_source: "zoho",
                  last_synced_at: new Date().toISOString(),
                  last_error: null,
                },
                { onConflict: "store_id,sku" },
              );
            }
          }
        }
      }
    }

    // 7b) Zoho updates — ajustes individuales de inventario ───────────────────
    for (const p of zohoPairs) {
      try {
        const adj = await zohoFetch(admin, conn, `/inventory/v1/inventoryadjustments`, {
          method: "POST",
          body: JSON.stringify({
            date: new Date().toISOString().slice(0, 10),
            reason: "Sync desde Tiendanube",
            adjustment_type: "quantity",
            line_items: [{ item_id: p.zoho_item_id, quantity_adjusted: p.tn_qty - p.zoho_qty }],
          }),
          headers: { "Content-Type": "application/json" },
        });
        if (!adj.ok) {
          const j = await adj.json();
          throw new Error(`Zoho adjust ${adj.status}: ${JSON.stringify(j).slice(0, 200)}`);
        }
        updated++;
        details.push({ sku: p.zoho_sku, from: p.zoho_qty, to: p.tn_qty, target: "zoho" });
        await admin.from("stock_sync_state").upsert(
          {
            store_id: storeId,
            sku: p.zoho_sku || p.zoho_item_id,
            zoho_item_id: p.zoho_item_id,
            tiendanube_product_id: p.tn_product_id,
            tiendanube_variant_id: p.tn_variant_id,
            last_qty: p.tn_qty,
            last_source: "tiendanube",
            last_synced_at: new Date().toISOString(),
            last_error: null,
          },
          { onConflict: "store_id,sku" },
        );
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : "Error";
        details.push({ sku: p.zoho_sku, error: msg });
      }
    }

    await logSync(admin, storeId, {
      operation: "stock_sync_run",
      status: errors === 0 ? "success" : "error",
      message: `Vinculados: ${pairs.length} · Actualizados: ${updated} · Ya sync: ${inSyncPairs.length} · Errores: ${errors} · Sin match: ${unmatched.length}`,
      duration_ms: Date.now() - t0,
      payload: { updated, inSync: inSyncPairs.length, errors, total: pairs.length, unmatched: unmatched.slice(0, 50) },
    });
    terminalLogged = true;

    return json({
      dry_run: false,
      total: pairs.length,
      updated,
      inSync: inSyncPairs.length,
      errors,
      unmatched: unmatched.length,
      unmatched_sample: unmatched.slice(0, 20),
      details: details.slice(0, 100),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("sync-stock-run error", msg);
    // Only a real run that acquired the lock should produce a terminal log.
    if (lock && admin && storeId && !terminalLogged) {
      await logSync(admin, storeId, {
        operation: "stock_sync_run",
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

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
