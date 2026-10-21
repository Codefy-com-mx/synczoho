import { serve } from "../../runtime.js";
import { getLockPool, type DatabaseClient } from "../../db.js";
import { acquireSyncLock, type SyncLockHandle } from "../../sync-lock.js";
// Sincroniza stock entre Zoho y Tiendanube según settings.
// Modo on-demand: corre un sync completo (Zoho → TN, TN → Zoho o bidireccional).
// Vincula automáticamente productos por SKU si aún no están mapeados.
// Mejoras v2:
//   - TN updates vía PATCH /products/stock-price (batch, hasta 50 variantes por request)
//   - inventory_levels por location mapeada (location_id explícito); sin mapeos
//     y con una sola location (o sin scope read_locations) se omite location_id
//   - Variantes desde la caché local tn_variants (sin polling a /products)
//   - Retry automático en 429 vía tnFetchWithRetry
//   - dryRun: simula sin aplicar cambios
import {
  corsHeaders,
  getAdminClient,
  getZohoConnection,
  zohoFetch,
  logSync,
} from "../_shared/zoho.js";
import { getStore, tnFetchWithRetry } from "../_shared/tiendanube.js";
import { chunkStockPriceBatch } from "../_shared/stock-price-batch.js";
import { enqueueBackfill, getCatalogStatus, loadCatalog } from "../_shared/tn-catalog.js";
import { ZOHO_TOTAL, fetchTnLocations, loadLocationMappings } from "../_shared/locations.js";
import { buildStockPatch, deriveTnLocationCount, matchBySku, planStockChanges, type StockChange, type ZohoStockItem } from "../_shared/stock-plan.js";
import { logRetryObserver } from "../_shared/tn-observer.js";

const ZOHO_DETAIL_CONCURRENCY = 3;

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

    // Sin catálogo local todavía no hay contra qué comparar: neutro, sin tocar Zoho ni Tiendanube.
    if ((await getCatalogStatus(storeId)) === "pending") {
      // Idempotente: si el encolado de la instalación falló, sin esto la tienda quedaría 'pending' para siempre.
      await enqueueBackfill(storeId).catch((e) => console.error(`[sync-stock-run] enqueueBackfill falló`, storeId, e));
      return json({ skipped: true, reason: "catalog_not_ready" });
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
    const observer = logRetryObserver(admin, storeId);

    // 1) Cargar TODOS los items de Zoho (con stock + sku)
    const zohoItems: ZohoStockItem[] = [];
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

    // 2) Variantes de Tiendanube desde la caché local, mapeos y cantidad de locations
    const catalog = await loadCatalog(storeId);
    const mappings = await loadLocationMappings(storeId);
    const tnLocations = await fetchTnLocations(store);
    const tnLocationCount = deriveTnLocationCount(tnLocations, mappings, catalog);
    // Locations de Tiendanube conocidas y sin vincular (solo se informan si hay al menos un vínculo).
    const linkedIds = new Set(mappings.filter((m) => m.zoho_location_id).map((m) => m.tn_location_id));
    const unmapped_locations = linkedIds.size === 0 ? [] : [
      ...new Set((tnLocations ? tnLocations.map((l) => l.id) : mappings.map((m) => m.tn_location_id)).filter((l) => !linkedIds.has(l))),
    ];

    // 3) Si la lista de Zoho no trae stock por location, pedir el detalle solo de los ítems con match
    let errors = 0;
    const details: any[] = [];
    const { pairs } = matchBySku(zohoItems, catalog);
    if (mappings.some((m) => m.zoho_location_id && m.zoho_location_id !== ZOHO_TOTAL)) {
      const queue = pairs.map((p) => p.item).filter((it) => !Array.isArray(it.locations));
      await Promise.all(Array.from({ length: ZOHO_DETAIL_CONCURRENCY }, async () => {
        for (let it = queue.shift(); it; it = queue.shift()) {
          const r = await zohoFetch(admin!, conn, `/inventory/v1/items/${it.item_id}`);
          const j = await r.json().catch(() => ({}));
          if (r.ok && Array.isArray(j.item?.locations)) {
            it.locations = j.item.locations;
          } else {
            // Sin locations el planificador no toca el ítem; se informa como error.
            errors++;
            details.push({ sku: it.sku || it.item_id, error: `Zoho item ${r.status}: sin stock por location` });
          }
        }
      }));
    }

    // 4) Planificar cambios por (variante, location)
    const plan = planStockChanges({ zohoItems, catalog, mappings, tnLocationCount, direction, priority });
    const { unmatched, inSync, blocked } = plan;
    const tnChanges = plan.changes.filter((c) => c.target === "tn");
    const zohoChanges = plan.changes.filter((c) => c.target === "zoho");
    const total = plan.changes.length + inSync;
    const detailOf = (c: StockChange) => ({
      sku: c.sku, from: c.from, to: c.to, target: c.target,
      location_id: c.target === "tn" ? c.tn_location_id : c.zoho_location_id,
    });

    // ── DRY RUN ──────────────────────────────────────────────────────────────
    if (dryRun) {
      return json({
        dry_run: true,
        blocked,
        unmapped_locations,
        total,
        updated: plan.changes.length,
        inSync,
        errors,
        unmatched: unmatched.length,
        unmatched_sample: unmatched.slice(0, 20),
        details: [...details, ...plan.changes.map((c) => ({ ...detailOf(c), dry_run: true }))].slice(0, 100),
      });
    }

    // ── MODO REAL ─────────────────────────────────────────────────────────────

    if (blocked) {
      // Visible en los logs del comerciante; errors queda en 0 para el scheduler (no es un fallo de ejecución).
      await logSync(admin, storeId, {
        operation: "stock_sync_run",
        status: "error",
        message: blocked === "locations_mixed"
          ? "La configuración de ubicaciones mezcla el stock total con vínculos a ubicaciones de Zoho: deja solo uno de los dos en Configuración"
          : "Hay varias ubicaciones en Tiendanube: elige en Configuración cuál recibe el stock total o vincúlalas con Zoho",
        duration_ms: Date.now() - t0,
        payload: { blocked, tn_locations: tnLocationCount },
      });
      terminalLogged = true;
      return json({
        dry_run: false, blocked, unmapped_locations, total: 0, updated: 0, inSync: 0, errors: 0,
        unmatched: unmatched.length, unmatched_sample: unmatched.slice(0, 20), details: [],
      });
    }

    // 5) Auto-vincular en product_sync_map
    for (const { item, variant } of pairs) {
      await admin.from("product_sync_map").upsert(
        {
          store_id: storeId,
          zoho_item_id: item.item_id,
          zoho_sku: item.sku || "",
          tiendanube_product_id: variant.product_id,
          status: "linked",
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "store_id,zoho_item_id" },
      );
    }

    let updated = 0;
    // stock_sync_state tiene una fila por SKU: con varias locations se guarda el primer cambio aplicado.
    const stateWritten = new Set<string>();
    const saveState = async (c: StockChange) => {
      if (stateWritten.has(c.sku)) return;
      stateWritten.add(c.sku);
      await admin!.from("stock_sync_state").upsert(
        {
          store_id: storeId,
          sku: c.sku,
          zoho_item_id: c.zoho_item_id,
          tiendanube_product_id: c.product_id,
          tiendanube_variant_id: c.variant_id,
          last_qty: c.to,
          last_source: c.target === "tn" ? "zoho" : "tiendanube",
          last_synced_at: new Date().toISOString(),
          last_error: null,
        },
        { onConflict: "store_id,sku" },
      );
    };

    // 6a) TN updates — batch via PATCH /products/stock-price ──────────────────
    // stock_management lo calcula Tiendanube: enviar un stock numérico lo activa.
    for (const chunk of chunkStockPriceBatch(buildStockPatch(tnChanges))) {
      const sent = new Set(chunk.flatMap((prod) => prod.variants.map((v) => v.id)));
      const chunkChanges = tnChanges.filter((c) => sent.has(c.variant_id));
      const r = await tnFetchWithRetry(store, "/products/stock-price", {
        method: "PATCH",
        body: JSON.stringify(chunk),
      }, undefined, observer);

      if (!r.ok) {
        const errText = await r.text();
        for (const c of chunkChanges) {
          errors++;
          details.push({ sku: c.sku, location_id: c.tn_location_id, error: `TN batch PATCH ${r.status}: ${errText.slice(0, 120)}` });
        }
        continue;
      }
      await r.text().catch(() => "");
      // ponytail: no se actualiza la caché tn_variants tras el PATCH; el webhook product/updated resultante la refresca.
      for (const c of chunkChanges) {
        updated++;
        details.push(detailOf(c));
        await saveState(c);
      }
    }

    // 6b) Zoho updates — un ajuste de inventario por (ítem, location) ─────────
    for (const c of zohoChanges) {
      try {
        const adj = await zohoFetch(admin, conn, `/inventory/v1/inventoryadjustments`, {
          method: "POST",
          body: JSON.stringify({
            date: new Date().toISOString().slice(0, 10),
            reason: "Sync desde Tiendanube",
            adjustment_type: "quantity",
            line_items: [{
              item_id: c.zoho_item_id,
              quantity_adjusted: c.to - c.from,
              ...(c.zoho_location_id ? { location_id: c.zoho_location_id } : {}),
            }],
          }),
          headers: { "Content-Type": "application/json" },
        });
        if (!adj.ok) {
          const j = await adj.json();
          throw new Error(`Zoho adjust ${adj.status}: ${JSON.stringify(j).slice(0, 200)}`);
        }
        updated++;
        details.push(detailOf(c));
        await saveState(c);
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : "Error";
        details.push({ sku: c.sku, location_id: c.zoho_location_id, error: msg });
      }
    }

    await logSync(admin, storeId, {
      operation: "stock_sync_run",
      status: errors === 0 ? "success" : "error",
      message: `Vinculados: ${pairs.length} · Actualizados: ${updated} · Ya sync: ${inSync} · Errores: ${errors} · Sin match: ${unmatched.length}`,
      duration_ms: Date.now() - t0,
      payload: { updated, inSync, errors, total, unmatched: unmatched.slice(0, 50), unmapped_locations },
    });
    terminalLogged = true;

    return json({
      dry_run: false,
      blocked: null,
      unmapped_locations,
      total,
      updated,
      inSync,
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
