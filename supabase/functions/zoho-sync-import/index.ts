// Importa items/grupos de Zoho a Tiendanube. Procesa de a uno y devuelve resultado por item.
// Soporta acciones: 'create' (crear nuevo), 'update' (actualizar vinculado), 'link' (solo vincular sin enviar).
//
// Modelo de variantes:
// - Si zoho_item_id viene como "group:{gid}" → trae el item_group de Zoho y crea
//   en TN un producto con N variantes (una por cada item hijo del grupo) mapeando
//   los atributos (Talle/Color) a `attributes`/`values`.
// - Si zoho_item_id es un item_id real → producto con 1 variante (caso simple).
import { corsHeaders, getAdminClient, getZohoConnection, getValidAccessToken, INVENTORY_DOMAINS, logSync, zohoFetch } from "../_shared/zoho.ts";
import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { tnFetchWithRetry } from "../_shared/tiendanube.ts";

interface ImportRequest {
  store_id: string;
  items: Array<{
    zoho_item_id: string; // puede ser "group:{gid}" o item_id real
    action: "create" | "update" | "link";
    tiendanube_product_id?: number | null;
  }>;
  publish?: boolean;
  fields?: Partial<Record<
    "name" | "sku" | "description" | "price" | "stock" | "images" | "category" |
    "weight" | "dimensions" | "barcode" | "brand" | "tax",
    boolean
  >>;
  overwrite?: boolean;
}

const DEFAULT_FIELDS = {
  name: true, sku: true, description: true, price: true, stock: true,
  images: false, category: false, weight: false, dimensions: false,
  barcode: false, brand: false, tax: false,
} as const;


interface ZohoVariantData {
  item_id: string;
  name: string;
  sku: string | null;
  rate: number;           // precio de lista (price en TN)
  sales_rate: number | null; // precio de venta (promotional_price en TN si distinto de rate)
  stock_on_hand: number;
  weight: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  upc: string | null;
  attributes: Record<string, string>;
}

interface ZohoProductData {
  // identificador estable usado en product_sync_map (group:{gid} o item_id)
  sync_key: string;
  is_group: boolean;
  group_id: string | null;
  representative_item_id: string;
  name: string;
  description: string;
  brand: string | null;
  category_name: string | null;
  image_name: string | null;
  variants: ZohoVariantData[];
  attribute_names: string[]; // ["Talle", "Color"]
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const admin = getAdminClient();
    const body = (await req.json().catch(() => ({}))) as ImportRequest;
    const { store_id: storeId, items, publish = false, fields, overwrite = true } = body;
    const F = { ...DEFAULT_FIELDS, ...(fields || {}) };

    if (!storeId || !Array.isArray(items) || items.length === 0) {
      return json({ error: "store_id e items son obligatorios" }, 400);
    }

    const { data: storeRow } = await admin
      .from("stores")
      .select("store_id, access_token")
      .eq("store_id", storeId)
      .maybeSingle();
    if (!storeRow) return json({ error: "Store not found" }, 404);
    // TiendanubeStore compatible con tnFetchWithRetry
    const store = { store_id: storeRow.store_id, access_token: storeRow.access_token, store_name: null };

    const conn = await getZohoConnection(admin, storeId);

    // Cargar mapeos de categorías para esta tienda
    const { data: catMappingsRaw } = await admin
      .from("category_mappings")
      .select("zoho_category, tn_category_id")
      .eq("store_id", storeId);
    const catMap = new Map<string, number>(
      (catMappingsRaw ?? []).map((m: { zoho_category: string; tn_category_id: number }) => [
        m.zoho_category,
        m.tn_category_id,
      ]),
    );

    const results: Array<{
      zoho_item_id: string;
      status: "success" | "error" | "skipped";
      message?: string;
      tiendanube_product_id?: number | null;
      action: string;
      variants_count?: number;
    }> = [];

    for (const entry of items) {
      const start = Date.now();
      try {
        // Resolver el producto (suelto o grupo)
        const product = await loadZohoProduct(admin, conn, entry.zoho_item_id);
        let tnProductId: number | null = entry.tiendanube_product_id || null;

        if (entry.action === "create") {
          const payload = buildCreatePayload(product, F, publish, catMap);
          if (F.images) {
            const imgs = await fetchProductImages(admin, conn, product);
            if (imgs.length > 0) payload.images = imgs;
          }
          const resp = await tnFetchWithRetry(store, "/products", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          const created = await resp.json();
          if (!resp.ok) throw new Error(tnErr(created, resp.status));
          tnProductId = created.id;
        } else if (entry.action === "update") {
          if (!tnProductId) throw new Error("tiendanube_product_id requerido para update");
          if (overwrite) {
            const payload: Record<string, unknown> = {};
            if (F.name) payload.name = { es: product.name };
            if (F.description) payload.description = { es: product.description || "" };
            if (F.brand && product.brand) payload.brand = product.brand;
            if (Object.keys(payload).length > 0) {
              const resp = await tnFetchWithRetry(store, `/products/${tnProductId}`, {
                method: "PUT",
                body: JSON.stringify(payload),
              });
              const updated = await resp.json();
              if (!resp.ok) throw new Error(tnErr(updated, resp.status));
            }
            // Sincronizar variantes: actualizar las que matchean por SKU
            await syncVariantsUpdate(store, tnProductId, product, F);

            if (F.images) {
              const imgs = await fetchProductImages(admin, conn, product);
              for (const img of imgs) {
                await tnFetchWithRetry(store, `/products/${tnProductId}/images`, {
                  method: "POST",
                  body: JSON.stringify(img),
                }).catch(() => {});
              }
            }
          }
        } else if (entry.action === "link") {
          if (!tnProductId) throw new Error("tiendanube_product_id requerido para link");
        }

        // Upsert en sync map: 1 fila para el "padre" (sync_key) + 1 fila por cada
        // variante hija (zoho_item_id real → tiendanube_product_id) para que la
        // sincronización de órdenes y stock pueda mapear por SKU/item_id.
        await admin.from("product_sync_map").upsert(
          {
            store_id: storeId,
            zoho_item_id: product.sync_key,
            zoho_sku: product.variants.map((v) => v.sku).filter(Boolean).join(",") || null,
            zoho_name: product.name,
            tiendanube_product_id: tnProductId,
            status: entry.action === "link" ? "linked" : "imported",
            last_synced_at: new Date().toISOString(),
            last_error: null,
            metadata: {
              is_group: product.is_group,
              group_id: product.group_id,
              variants_count: product.variants.length,
            },
          },
          { onConflict: "store_id,zoho_item_id" },
        );

        // Filas por variante (sólo si es grupo o si conviene mantener trazabilidad)
        if (product.is_group) {
          for (const v of product.variants) {
            await admin.from("product_sync_map").upsert(
              {
                store_id: storeId,
                zoho_item_id: v.item_id,
                zoho_sku: v.sku,
                zoho_name: v.name,
                tiendanube_product_id: tnProductId,
                status: entry.action === "link" ? "linked" : "imported",
                last_synced_at: new Date().toISOString(),
                last_error: null,
                metadata: { parent_group_id: product.group_id, attributes: v.attributes },
              },
              { onConflict: "store_id,zoho_item_id" },
            );
          }
        }

        await logSync(admin, storeId, {
          operation:
            entry.action === "create" ? "import_create"
              : entry.action === "update" ? "import_update"
              : "link",
          zoho_item_id: product.sync_key,
          tiendanube_product_id: tnProductId,
          status: "success",
          duration_ms: Date.now() - start,
          message: product.is_group ? `Grupo con ${product.variants.length} variantes` : undefined,
        });

        results.push({
          zoho_item_id: entry.zoho_item_id,
          status: "success",
          tiendanube_product_id: tnProductId,
          action: entry.action,
          variants_count: product.variants.length,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown";
        await admin.from("product_sync_map").upsert(
          {
            store_id: storeId,
            zoho_item_id: entry.zoho_item_id,
            tiendanube_product_id: entry.tiendanube_product_id || null,
            status: "error",
            last_error: msg,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: "store_id,zoho_item_id" },
        );
        await logSync(admin, storeId, {
          operation: entry.action,
          zoho_item_id: entry.zoho_item_id,
          tiendanube_product_id: entry.tiendanube_product_id || null,
          status: "error",
          message: msg,
          duration_ms: Date.now() - start,
        });
        results.push({
          zoho_item_id: entry.zoho_item_id,
          status: "error",
          message: msg,
          action: entry.action,
        });
      }
    }

    return json({ results });
  } catch (e) {
    console.error("zoho-sync-import error", e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});

// ============================================================
// Carga el "producto" desde Zoho. Si entry.zoho_item_id viene como "group:{gid}"
// trae el item_group entero. Si es un item_id, devuelve un producto de 1 variante.
async function loadZohoProduct(
  admin: any,
  conn: any,
  zohoItemId: string,
): Promise<ZohoProductData> {
  if (zohoItemId.startsWith("group:")) {
    const gid = zohoItemId.slice("group:".length);
    const r = await zohoFetch(admin, conn, `/inventory/v1/itemgroups/${gid}`);
    const j = await r.json();
    if (!r.ok || !j.item_group) {
      throw new Error(`Zoho item_group ${gid}: ${j?.message || r.statusText}`);
    }
    const ig = j.item_group;
    const itemsRaw: any[] = ig.items || [];
    if (itemsRaw.length === 0) throw new Error(`Item group ${gid} sin variantes`);

    const attrNames: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const n = ig[`attribute_name${i}`] || ig.attributes?.[i - 1]?.name;
      if (n) attrNames.push(String(n));
    }

    const variants: ZohoVariantData[] = itemsRaw.map((it: any) => {
      const rate = Number(it.rate ?? 0);
      const salesRate = it.sales_rate != null ? Number(it.sales_rate) : null;
      return {
        item_id: String(it.item_id),
        name: it.name,
        sku: it.sku || null,
        rate,
        // sales_rate es el precio de venta real; si difiere del rate (precio de lista),
        // se mapea como promotional_price en TN
        sales_rate: salesRate !== null && salesRate !== rate ? salesRate : null,
        stock_on_hand: Number(it.stock_on_hand ?? it.actual_available_stock ?? 0),
        weight: it.weight != null ? Number(it.weight) : null,
        length: it.length != null ? Number(it.length) : null,
        width: it.width != null ? Number(it.width) : null,
        height: it.height != null ? Number(it.height) : null,
        upc: it.upc || null,
        attributes: extractVariantAttrs(it, ig, attrNames),
      };
    });

    const first = itemsRaw[0];
    return {
      sync_key: `group:${gid}`,
      is_group: true,
      group_id: gid,
      representative_item_id: String(first.item_id),
      name: ig.group_name || ig.name || first.name,
      description: ig.description || first.description || "",
      brand: ig.brand || first.brand || null,
      category_name: ig.category_name || first.category_name || null,
      image_name: ig.image_name || first.image_name || null,
      variants,
      attribute_names: attrNames,
    };
  }

  // Item suelto
  const r = await zohoFetch(admin, conn, `/inventory/v1/items/${zohoItemId}`);
  const j = await r.json();
  if (!r.ok) throw new Error(`Zoho item ${zohoItemId}: ${j?.message || r.statusText}`);
  const it = j.item;
  const rate = Number(it.rate ?? 0);
  const salesRate = it.sales_rate != null ? Number(it.sales_rate) : null;
  return {
    sync_key: String(it.item_id),
    is_group: false,
    group_id: null,
    representative_item_id: String(it.item_id),
    name: it.name,
    description: it.description || "",
    brand: it.brand || null,
    category_name: it.category_name || null,
    image_name: it.image_name || null,
    variants: [{
      item_id: String(it.item_id),
      name: it.name,
      sku: it.sku || null,
      rate,
      sales_rate: salesRate !== null && salesRate !== rate ? salesRate : null,
      stock_on_hand: Number(it.stock_on_hand ?? 0),
      weight: it.weight != null ? Number(it.weight) : null,
      length: it.length != null ? Number(it.length) : null,
      width: it.width != null ? Number(it.width) : null,
      height: it.height != null ? Number(it.height) : null,
      upc: it.upc || null,
      attributes: {},
    }],
    attribute_names: [],
  };
}

function extractVariantAttrs(it: any, ig: any, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 1; i <= 3; i++) {
    const n = it[`attribute_name${i}`] || ig?.[`attribute_name${i}`] || names[i - 1] || null;
    const val = it[`attribute_option_name${i}`];
    if (n && val) out[String(n)] = String(val);
  }
  return out;
}

// ============================================================
// Construye el payload TN con `attributes` (nombres de los atributos) y
// `variants[].values[]` (valores por variante en el mismo orden).
function buildCreatePayload(
  p: ZohoProductData,
  F: typeof DEFAULT_FIELDS,
  publish: boolean,
  catMap: Map<string, number> = new Map(),
): Record<string, any> {
  const payload: Record<string, any> = { published: publish };

  if (F.name) payload.name = { es: p.name };
  if (F.description) payload.description = { es: p.description || "" };
  if (F.brand && p.brand) payload.brand = p.brand;
  if (F.category && p.category_name) {
    const mappedId = catMap.get(p.category_name);
    // Si existe un mapeo explícito → usar ID de TN (evita duplicados por nombre)
    // Si no → crear/buscar por nombre (comportamiento previo)
    payload.categories = mappedId
      ? [{ id: mappedId }]
      : [{ name: { es: p.category_name } }];
  }

  // attributes en TN: array de nombres traducibles
  if (p.attribute_names.length > 0) {
    payload.attributes = p.attribute_names.map((n) => ({ es: n }));
  }

  payload.variants = p.variants.map((v) => {
    const tnVar: Record<string, any> = {};
    if (F.price) {
      // Si hay sales_rate diferente al rate: rate = precio de lista, sales_rate = precio de venta
      tnVar.price = String(v.rate ?? 0);
      if (v.sales_rate != null) {
        tnVar.promotional_price = String(v.sales_rate);
      }
    }
    if (F.stock) {
      tnVar.stock_management = true;
      tnVar.stock = Number(v.stock_on_hand ?? 0);
    }
    if (F.sku && v.sku) tnVar.sku = v.sku;
    if (F.weight && v.weight != null) tnVar.weight = String(v.weight);
    if (F.dimensions) {
      if (v.length != null) tnVar.depth = String(v.length);
      if (v.width != null) tnVar.width = String(v.width);
      if (v.height != null) tnVar.height = String(v.height);
    }
    if (F.barcode && v.upc) tnVar.barcode = v.upc;

    // values: en el MISMO orden que payload.attributes
    if (p.attribute_names.length > 0) {
      tnVar.values = p.attribute_names.map((n) => ({ es: v.attributes[n] || "—" }));
    }
    return tnVar;
  });

  return payload;
}

// Para update: matchea variantes TN existentes por SKU y actualiza precio/stock.
async function syncVariantsUpdate(
  store: { store_id: string; access_token: string; store_name: string | null },
  tnProductId: number,
  p: ZohoProductData,
  F: typeof DEFAULT_FIELDS,
) {
  if (!F.price && !F.stock) return;
  // Traer variantes actuales
  const r = await tnFetchWithRetry(store, `/products/${tnProductId}/variants`);
  if (!r.ok) return;
  const tnVariants: any[] = await r.json();
  const norm = (s: any) => (s ?? "").toString().trim().toUpperCase();
  const bySku = new Map<string, any>();
  for (const tv of tnVariants) {
    if (tv.sku) bySku.set(norm(tv.sku), tv);
  }

  for (const v of p.variants) {
    if (!v.sku) continue;
    const tv = bySku.get(norm(v.sku));
    if (!tv) continue;
    const body: Record<string, unknown> = {};
    if (F.price) {
      body.price = String(v.rate ?? 0);
      if (v.sales_rate != null) body.promotional_price = String(v.sales_rate);
    }
    if (F.stock) {
      body.stock_management = true;
      body.stock = Number(v.stock_on_hand ?? 0);
    }
    if (Object.keys(body).length === 0) continue;
    await tnFetchWithRetry(store, `/products/${tnProductId}/variants/${tv.id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }).catch(() => {});
  }
}

// ============================================================
function tnErr(data: any, status: number) {
  if (!data) return `Tiendanube error ${status}`;
  if (typeof data === "string") return data;
  if (data.message) return typeof data.message === "string" ? data.message : JSON.stringify(data.message);
  return `Tiendanube error ${status}: ${JSON.stringify(data)}`;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Descarga imágenes de Zoho (autenticadas) y las convierte a attachments base64.
// Para grupos, intenta primero la imagen del grupo; si no existe, usa la del primer hijo.
async function fetchProductImages(
  admin: any,
  conn: any,
  p: ZohoProductData,
): Promise<Array<{ attachment: string; filename: string; position?: number }>> {
  const out: Array<{ attachment: string; filename: string; position?: number }> = [];
  const candidates: Array<{ id: string; name: string | null }> = [];
  if (p.is_group && p.group_id && p.image_name) {
    candidates.push({ id: p.representative_item_id, name: p.image_name });
  }
  // Imagen del primer ítem hijo
  if (p.variants[0]) {
    candidates.push({ id: p.variants[0].item_id, name: p.image_name || `zoho-${p.variants[0].item_id}.jpg` });
  }
  try {
    const token = await getValidAccessToken(admin, conn);
    const inventoryBase = INVENTORY_DOMAINS[conn.dc] || INVENTORY_DOMAINS.com;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const url = `${inventoryBase}/inventory/v1/items/${c.id}/image?organization_id=${conn.organization_id}`;
      const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
      if (!r.ok) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.byteLength === 0) continue;
      const filename = (c.name || `zoho-${c.id}.jpg`).replace(/[^\w.-]/g, "_");
      out.push({ attachment: encodeBase64(buf), filename, position: i + 1 });
      // Para item suelto con 1 sola variante, una sola imagen alcanza
      if (!p.is_group) break;
    }
  } catch (e) {
    console.error("fetchProductImages error", e);
  }
  return out;
}
