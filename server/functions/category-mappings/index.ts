import { serve } from "../../runtime.js";
// CRUD de mapeos de categorías Zoho→Tiendanube.
// Actions: list | save | delete
import { corsHeaders, getAdminClient, getZohoConnection, zohoFetch } from "../_shared/zoho.js";
import { getStore, tnFetchWithRetry } from "../_shared/tiendanube.js";

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const { storeId, action = "list", zohoCategory, tnCategoryId, tnCategoryName } = body as {
      storeId: string;
      action?: "list" | "save" | "delete";
      zohoCategory?: string;
      tnCategoryId?: number;
      tnCategoryName?: string;
    };
    if (!storeId) return json({ error: "storeId requerido" }, 400);

    const admin = getAdminClient();

    // ── DELETE ─────────────────────────────────────────────────────────────────
    if (action === "delete") {
      if (!zohoCategory) return json({ error: "zohoCategory requerido" }, 400);
      await admin.from("category_mappings")
        .delete()
        .eq("store_id", storeId)
        .eq("zoho_category", zohoCategory);
      return json({ deleted: true });
    }

    // ── SAVE ───────────────────────────────────────────────────────────────────
    if (action === "save") {
      if (!zohoCategory || !tnCategoryId || !tnCategoryName) {
        return json({ error: "zohoCategory, tnCategoryId y tnCategoryName son requeridos" }, 400);
      }
      await admin.from("category_mappings").upsert({
        store_id: storeId,
        zoho_category: zohoCategory,
        tn_category_id: tnCategoryId,
        tn_category_name: tnCategoryName,
      }, { onConflict: "store_id,zoho_category" });
      return json({ saved: true });
    }

    // ── LIST ───────────────────────────────────────────────────────────────────
    const conn = await getZohoConnection(admin, storeId);
    const store = await getStore(admin, storeId);

    // Zoho categories
    const zohoResp = await zohoFetch(admin, conn, "/inventory/v1/categories?per_page=200");
    const zohoJson = await zohoResp.json();
    const zohoCategories: { id: string; name: string }[] = (zohoJson.categories || []).map(
      (c: any) => ({ id: c.category_id, name: c.name }),
    );

    // TN categories
    const tnResp = await tnFetchWithRetry(store, "/categories?per_page=200");
    const tnJson = tnResp.ok ? await tnResp.json() : [];
    const flatten = (cats: any[], depth = 0): { id: number; name: string; depth: number }[] => {
      const out: { id: number; name: string; depth: number }[] = [];
      for (const c of cats || []) {
        const name = c.name?.es ?? c.name?.pt ?? c.name ?? `Cat ${c.id}`;
        out.push({ id: c.id, name, depth });
        if (c.subcategories?.length) out.push(...flatten(c.subcategories, depth + 1));
      }
      return out;
    };
    const tnCategories = flatten(Array.isArray(tnJson) ? tnJson : []);

    // Existing mappings
    const { data: mappings } = await admin
      .from("category_mappings")
      .select("zoho_category, tn_category_id, tn_category_name")
      .eq("store_id", storeId);

    return json({ zohoCategories, tnCategories, mappings: mappings ?? [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("category-mappings error", msg);
    return json({ error: msg }, 500);
  }
});
