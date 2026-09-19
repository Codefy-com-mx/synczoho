import { serve } from "../../runtime.js";
// Lista items desde Zoho Inventory con paginación, búsqueda y filtros.
// Agrupa items por group_id (variantes en Zoho) → 1 fila por grupo con N variantes.
// Devuelve también el match con productos de Tiendanube y el estado del mapa local.
import { corsHeaders, getAdminClient, getZohoConnection, zohoFetch } from "../_shared/zoho.js";

interface ZohoVariant {
  item_id: string;
  name: string;
  sku: string | null;
  status: string;
  rate: number;
  stock_on_hand: number;
  attributes: Record<string, string>; // {Talle: "M", Color: "Rojo"}
}

interface ZohoRow {
  // Identificador "lógico" para selección y sync
  // Para items con group_id usamos `group:{group_id}`, sino `item:{item_id}`
  row_id: string;
  is_group: boolean;
  group_id: string | null;
  // Si is_group=true, item_id apunta al primer hijo (representante).
  // Si es item suelto, item_id es ese único item.
  item_id: string;
  name: string;
  sku: string | null;
  status: string;
  rate: number;
  stock_on_hand: number;
  description: string;
  category_name: string | null;
  image_name: string | null;
  variants: ZohoVariant[]; // [] para items sueltos, N para grupos
  // enriquecimiento
  match_status: string;
  tiendanube_product_id: number | null;
  last_synced_at: string | null;
  last_error: string | null;
}

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const admin = getAdminClient();
    const body = await req.json().catch(() => ({}));
    const storeId: string = body.store_id;
    const page: number = Math.max(1, Number(body.page) || 1);
    const perPage: number = Math.min(200, Math.max(1, Number(body.per_page) || 25));
    const search: string | undefined = body.search?.trim() || undefined;
    const status: string | undefined = body.status;
    const stockFilter: string | undefined = body.stock;
    const matchFilter: string | undefined = body.match;

    if (!storeId) {
      return json({ error: "store_id is required" }, 400);
    }

    const conn = await getZohoConnection(admin, storeId);

    // Pedimos un poco más a Zoho porque después agrupamos.
    const fetchSize = Math.min(200, perPage * 4);
    const qs = new URLSearchParams();
    qs.set("page", String(page));
    qs.set("per_page", String(fetchSize));
    if (search) qs.set("search_text", search);
    if (status) qs.set("filter_by", `Status.${status === "active" ? "Active" : "Inactive"}`);

    const resp = await zohoFetch(admin, conn, `/inventory/v1/items?${qs.toString()}`);
    const data = await resp.json();
    if (!resp.ok) {
      console.error("zoho items error", data);
      return json({ error: data?.message || "Error de Zoho", details: data }, resp.status);
    }

    const rawItems = (data.items || []) as any[];

    // ---- Agrupar por group_id ----
    // Estructura: si tiene group_id, lo metemos en el grupo. Sino, queda como item suelto.
    const groupMap = new Map<string, any[]>();
    const standalone: any[] = [];

    for (const it of rawItems) {
      const gid = it.group_id ? String(it.group_id) : null;
      if (gid) {
        if (!groupMap.has(gid)) groupMap.set(gid, []);
        groupMap.get(gid)!.push(it);
      } else {
        standalone.push(it);
      }
    }

    // Para cada grupo presente, traemos el itemgroup completo desde Zoho para
    // asegurarnos de tener TODAS sus variantes (puede que Zoho devuelva sólo
    // algunas en /items por la paginación).
    const groupRows: ZohoRow[] = [];
    for (const [gid, sample] of groupMap.entries()) {
      try {
        const gResp = await zohoFetch(admin, conn, `/inventory/v1/itemgroups/${gid}`);
        const gJson = await gResp.json();
        const ig = gResp.ok ? gJson.item_group : null;
        const allItems: any[] = ig?.items?.length ? ig.items : sample;

        const variants: ZohoVariant[] = allItems.map((v: any) => ({
          item_id: String(v.item_id),
          name: v.name,
          sku: v.sku || null,
          status: v.status,
          rate: Number(v.rate ?? 0),
          stock_on_hand: Number(v.stock_on_hand ?? v.actual_available_stock ?? 0),
          attributes: extractAttributes(v, ig),
        }));

        const totalStock = variants.reduce((s, v) => s + (v.stock_on_hand || 0), 0);
        const first: any = variants[0] || sample[0];
        const groupName = ig?.group_name || ig?.name || stripVariantSuffix(first?.name || "");

        groupRows.push({
          row_id: `group:${gid}`,
          is_group: true,
          group_id: gid,
          item_id: String(first.item_id),
          name: groupName,
          sku: variants.map((v) => v.sku).filter(Boolean).join(", ") || null,
          status: ig?.status || first.status,
          rate: Math.min(...variants.map((v) => v.rate || 0)),
          stock_on_hand: totalStock,
          description: ig?.description || first.description || "",
          category_name: ig?.category_name || first.category_name || null,
          image_name: ig?.image_name || first.image_name || null,
          variants,
          match_status: "new",
          tiendanube_product_id: null,
          last_synced_at: null,
          last_error: null,
        });
      } catch (e) {
        console.error(`itemgroup ${gid} fetch error`, e);
        // Fallback: usar lo que vino en /items
        const variants: ZohoVariant[] = sample.map((v: any) => ({
          item_id: String(v.item_id),
          name: v.name,
          sku: v.sku || null,
          status: v.status,
          rate: Number(v.rate ?? 0),
          stock_on_hand: Number(v.stock_on_hand ?? v.actual_available_stock ?? 0),
          attributes: extractAttributes(v),
        }));
        groupRows.push({
          row_id: `group:${gid}`,
          is_group: true,
          group_id: gid,
          item_id: String(sample[0].item_id),
          name: stripVariantSuffix(sample[0].name || ""),
          sku: variants.map((v) => v.sku).filter(Boolean).join(", ") || null,
          status: sample[0].status,
          rate: Math.min(...variants.map((v) => v.rate || 0)),
          stock_on_hand: variants.reduce((s, v) => s + v.stock_on_hand, 0),
          description: sample[0].description || "",
          category_name: sample[0].category_name || null,
          image_name: sample[0].image_name || null,
          variants,
          match_status: "new",
          tiendanube_product_id: null,
          last_synced_at: null,
          last_error: null,
        });
      }
    }

    const standaloneRows: ZohoRow[] = standalone.map((it: any) => ({
      row_id: `item:${it.item_id}`,
      is_group: false,
      group_id: null,
      item_id: String(it.item_id),
      name: it.name,
      sku: it.sku || null,
      status: it.status,
      rate: Number(it.rate ?? 0),
      stock_on_hand: Number(it.stock_on_hand ?? it.actual_available_stock ?? 0),
      description: it.description || "",
      category_name: it.category_name || null,
      image_name: it.image_name || null,
      variants: [],
      match_status: "new",
      tiendanube_product_id: null,
      last_synced_at: null,
      last_error: null,
    }));

    let rows: ZohoRow[] = [...groupRows, ...standaloneRows];

    // Filtro de stock
    if (stockFilter === "in") rows = rows.filter((r) => r.stock_on_hand > 0);
    if (stockFilter === "out") rows = rows.filter((r) => r.stock_on_hand <= 0);

    // ---- Cargar mapa de sync ----
    // Para grupos guardamos en product_sync_map con zoho_item_id = "group:{gid}"
    // Para items sueltos zoho_item_id = item_id real
    const syncIds = rows.map((r) => (r.is_group ? `group:${r.group_id}` : r.item_id));

    const { data: maps } = await admin
      .from("product_sync_map")
      .select("zoho_item_id, tiendanube_product_id, status, last_synced_at, last_error")
      .eq("store_id", storeId)
      .in("zoho_item_id", syncIds.length ? syncIds : ["__none__"]);

    const mapByKey = new Map((maps || []).map((m: any) => [m.zoho_item_id, m]));

    // Match por nombre con productos TN existentes (para detectar conflictos en items "new")
    const { data: tnProducts } = await admin
      .from("products")
      .select("tiendanube_product_id, name, store_id")
      .eq("store_id", storeId);

    const productByName = new Map<string, any>();
    (tnProducts || []).forEach((p: any) => {
      const nameVal = typeof p.name === "object" ? Object.values(p.name)[0] : p.name;
      if (typeof nameVal === "string") productByName.set(nameVal.toLowerCase().trim(), p);
    });

    rows = rows.map((r) => {
      const mapKey = r.is_group ? `group:${r.group_id}` : r.item_id;
      const m = mapByKey.get(mapKey);
      let matchStatus: string;
      let tnProductId: number | null = null;
      if (m) {
        matchStatus = (m as any).status;
        tnProductId = (m as any).tiendanube_product_id;
      } else {
        const candidate = productByName.get((r.name || "").toLowerCase().trim());
        if (candidate) {
          matchStatus = "conflict";
          tnProductId = candidate.tiendanube_product_id;
        } else {
          matchStatus = "new";
        }
      }
      return {
        ...r,
        match_status: matchStatus,
        tiendanube_product_id: tnProductId,
        last_synced_at: (m as any)?.last_synced_at || null,
        last_error: (m as any)?.last_error || null,
      };
    });

    if (matchFilter) {
      rows = rows.filter((r) => r.match_status === matchFilter);
    }

    // Recortamos a perPage (después de agrupar y filtrar)
    const sliced = rows.slice(0, perPage);
    const hasMore = rows.length > perPage || !!data.page_context?.has_more_page;

    return json({
      items: sliced,
      page_context: { page, per_page: perPage, has_more_page: hasMore },
    });
  } catch (e) {
    console.error("zoho-list-items error", e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});

// Extrae atributos de variante. Zoho los expone como attribute_name1/option_name1...
function extractAttributes(v: any, ig?: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 1; i <= 3; i++) {
    const aName =
      v[`attribute_name${i}`] ||
      ig?.[`attribute_name${i}`] ||
      ig?.attributes?.[i - 1]?.name ||
      null;
    const aVal = v[`attribute_option_name${i}`] || null;
    if (aName && aVal) out[String(aName)] = String(aVal);
  }
  return out;
}

// "Remera Roja - Talle M" → "Remera Roja" (best effort)
function stripVariantSuffix(name: string): string {
  return name.replace(/\s*[-–—]\s*Talle.*$/i, "").trim() || name;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
