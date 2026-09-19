import { serve } from "../../runtime.js";
// GET/PUT settings de sincronización por tienda
import { corsHeaders, getAdminClient } from "../_shared/zoho.js";

const DEFAULT_FIELDS = {
  name: true,
  sku: true,
  description: true,
  price: true,
  stock: true,
  images: false,
  category: false,
  weight: false,
  dimensions: false,
  barcode: false,
  brand: false,
  tax: false,
};

const DEFAULTS = {
  orders_enabled: true,
  orders_create_as_draft: true,
  orders_auto_confirm: false,
  orders_generate_invoice_on_paid: false,
  orders_only_paid: false,
  stock_enabled: false,
  stock_direction: "zoho_to_tn",
  stock_priority: "zoho",
  stock_warehouse_id: null as string | null,
  customers_auto_sync_on_order: true,
  alert_on_error: false,
  alert_email: null as string | null,
  prices_enabled: false,
  stock_schedule: "disabled" as string,
  prices_schedule: "disabled" as string,
  products_publish_on_import: false,
  products_overwrite_existing: true,
  products_match_strategy: "sku",
  products_sync_fields: DEFAULT_FIELDS,
};

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const { storeId, action = "get", settings } = body as {
      storeId?: string;
      action?: "get" | "save";
      settings?: Record<string, unknown>;
    };
    if (!storeId) {
      return new Response(JSON.stringify({ error: "storeId requerido" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = getAdminClient();

    if (action === "save" && settings) {
      // Sólo persistimos campos conocidos
      const allowed = Object.keys(DEFAULTS);
      const clean: Record<string, unknown> = { store_id: storeId };
      for (const k of allowed) {
        if (k in settings) clean[k] = settings[k];
      }
      const { data: existing } = await admin
        .from("sync_settings")
        .select("id")
        .eq("store_id", storeId)
        .maybeSingle();
      if (existing) {
        await admin.from("sync_settings").update(clean).eq("store_id", storeId);
      } else {
        await admin.from("sync_settings").insert({ ...DEFAULTS, ...clean });
      }
    }

    const { data } = await admin
      .from("sync_settings")
      .select("*")
      .eq("store_id", storeId)
      .maybeSingle();

    const result = data || { ...DEFAULTS, store_id: storeId };

    return new Response(JSON.stringify({ settings: result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
