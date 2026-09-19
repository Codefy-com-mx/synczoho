import { serve } from "../../runtime.js";
// Sincroniza clientes Tiendanube → Zoho (bulk).
// Soporta skipExisting para no reprocesar clientes ya vinculados.
import {
  corsHeaders,
  getAdminClient,
  getZohoConnection,
  zohoFetch,
  logSync,
} from "../_shared/zoho.js";
import { getStore, tnFetchWithRetry } from "../_shared/tiendanube.js";

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const t0 = Date.now();
  try {
    const { storeId, limit = 50, page = 1, skipExisting = true } = await req.json();
    if (!storeId) {
      return new Response(JSON.stringify({ error: "storeId requerido" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const admin = getAdminClient();
    const store = await getStore(admin, storeId);
    const conn = await getZohoConnection(admin, storeId);

    // Llamada con retry automático en 429; leemos headers (x-total-count)
    const resp = await tnFetchWithRetry(store, `/customers?page=${page}&per_page=${limit}`);
    const text = await resp.text();
    if (!resp.ok) throw new Error(`Tiendanube ${resp.status}: ${text.slice(0, 300)}`);
    const customers: any[] = text ? JSON.parse(text) : [];
    const totalCount = Number(
      resp.headers.get("x-total-count") || resp.headers.get("X-Total-Count") || 0,
    );

    let created = 0;
    let linked = 0;
    let skipped = 0;
    let errors = 0;
    const details: any[] = [];

    // Pre-cargar mapping existente para esta página (1 query)
    const emails = customers.map((c) => c.email).filter(Boolean);
    const existingMap = new Map<string, string>();
    if (emails.length > 0) {
      const { data: existing } = await admin
        .from("customer_sync_map")
        .select("email, zoho_contact_id, status")
        .eq("store_id", storeId)
        .in("email", emails);
      for (const row of existing || []) {
        if (row.email && row.zoho_contact_id && row.status === "success") {
          existingMap.set(row.email, row.zoho_contact_id);
        }
      }
    }

    for (const c of customers) {
      try {
        const email = c.email;
        if (!email) {
          skipped++;
          details.push({ id: c.id, status: "skipped", reason: "sin email" });
          continue;
        }

        // Skip si ya existe y se pidió skipExisting
        if (skipExisting && existingMap.has(email)) {
          skipped++;
          details.push({ email, status: "skipped", reason: "ya sincronizado" });
          continue;
        }

        let zohoId = existingMap.get(email) || null;
        if (!zohoId) {
          // search en Zoho
          const sResp = await zohoFetch(
            admin,
            conn,
            `/inventory/v1/contacts?email=${encodeURIComponent(email)}`,
          );
          const sJson = await sResp.json();
          if (sJson.contacts?.[0]?.contact_id) {
            zohoId = sJson.contacts[0].contact_id;
            linked++;
          } else {
            // create
            const cResp = await zohoFetch(admin, conn, `/inventory/v1/contacts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contact_name: c.name || email,
                contact_type: "customer",
                contact_persons: [
                  {
                    first_name: c.name || email,
                    email,
                    phone: c.phone || "",
                    is_primary_contact: true,
                  },
                ],
              }),
            });
            const cJson = await cResp.json();
            if (cResp.ok && cJson.contact?.contact_id) {
              zohoId = cJson.contact.contact_id;
              created++;
            } else if (cJson.code === 3062) {
              // Nombre duplicado en Zoho — buscar por nombre y vincular
              const contactName = c.name || email;
              const searchResp = await zohoFetch(
                admin,
                conn,
                `/inventory/v1/contacts?contact_name=${encodeURIComponent(contactName)}&contact_type=customer`,
              );
              const searchJson = await searchResp.json();
              const existingContact = searchJson.contacts?.[0];
              if (existingContact?.contact_id) {
                zohoId = existingContact.contact_id;
                linked++;
              } else {
                // No se puede resolver — marcar como ignorado para no reintentar
                skipped++;
                details.push({ email, status: "skipped", reason: "nombre duplicado en Zoho sin coincidencia" });
                await admin.from("customer_sync_map").upsert(
                  { store_id: storeId, tiendanube_customer_id: c.id, email, status: "skipped", last_error: "Zoho 3062: nombre duplicado" },
                  { onConflict: "store_id,email" },
                );
                continue;
              }
            } else {
              throw new Error(cJson.message || JSON.stringify(cJson).slice(0, 200));
            }
          }
        }
        await admin.from("customer_sync_map").upsert(
          {
            store_id: storeId,
            tiendanube_customer_id: c.id,
            email,
            zoho_contact_id: zohoId,
            status: "success",
            last_synced_at: new Date().toISOString(),
            last_error: null,
          },
          { onConflict: "store_id,email" },
        );
        details.push({ email, status: "ok", zoho_contact_id: zohoId });
      } catch (e) {
        errors++;
        const msg = e instanceof Error ? e.message : "Error";
        details.push({ email: c.email, status: "error", error: msg });
        await admin.from("customer_sync_map").upsert(
          {
            store_id: storeId,
            tiendanube_customer_id: c.id,
            email: c.email,
            status: "error",
            last_error: msg,
          },
          { onConflict: "store_id,email" },
        );
      }
    }

    await logSync(admin, storeId, {
      operation: "customer_sync_bulk",
      status: errors === 0 ? "success" : "error",
      message: `Created: ${created} / Linked: ${linked} / Skipped: ${skipped} / Errors: ${errors}`,
      duration_ms: Date.now() - t0,
      payload: { created, linked, skipped, errors, total: customers.length, page },
    });

    return new Response(
      JSON.stringify({
        created,
        linked,
        skipped,
        errors,
        total: customers.length,
        total_count: totalCount,
        page,
        details,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
