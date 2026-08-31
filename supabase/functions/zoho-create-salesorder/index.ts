// Crea/actualiza un Sales Order en Zoho a partir de una orden de Tiendanube.
// Manejado por webhook automático y por reintento manual.
import {
  corsHeaders,
  getAdminClient,
  getZohoConnection,
  zohoFetch,
  logSync,
} from "../_shared/zoho.ts";
import { getStore, tnFetchJson } from "../_shared/tiendanube.ts";

interface OrderProductItem {
  product_id?: number;
  variant_id?: number;
  name?: string;
  price?: string | number;
  quantity?: number;
  sku?: string | null;
}
interface TNOrder {
  id: number;
  number: number;
  contact_email?: string;
  contact_name?: string;
  customer?: { id?: number; email?: string; name?: string; phone?: string };
  status?: string;
  payment_status?: string;
  currency?: string;
  total?: string;
  products?: OrderProductItem[];
  note?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const t0 = Date.now();
  try {
    const { storeId, orderId, event = "manual" } = await req.json();
    if (!storeId || !orderId) {
      return new Response(JSON.stringify({ error: "storeId y orderId requeridos" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = getAdminClient();

    // 1) Settings
    const { data: settings } = await admin
      .from("sync_settings")
      .select("*")
      .eq("store_id", storeId)
      .maybeSingle();

    if (settings && settings.orders_enabled === false) {
      await logSync(admin, storeId, {
        operation: "order_sync",
        status: "skipped",
        message: "Sync de órdenes deshabilitado",
        duration_ms: Date.now() - t0,
      });
      return jsonOk({ skipped: true, reason: "disabled" });
    }

    // 2) Traer orden de TN
    const store = await getStore(admin, storeId);
    const order = await tnFetchJson<TNOrder>(store, `/orders/${orderId}`);

    // 2.b) Filtro: solo órdenes pagadas
    if (settings?.orders_only_paid && order.payment_status !== "paid") {
      await logSync(admin, storeId, {
        operation: "order_sync",
        status: "skipped",
        message: `Orden #${order.number} omitida (estado de pago: ${order.payment_status})`,
        duration_ms: Date.now() - t0,
      });
      return jsonOk({ skipped: true, reason: "not_paid", payment_status: order.payment_status });
    }

    // 3) Conexión Zoho
    const conn = await getZohoConnection(admin, storeId);

    // 4) Asegurar contacto en Zoho
    const email = order.contact_email || order.customer?.email || `orden+${order.id}@tiendanube.local`;
    const contactName = order.contact_name || order.customer?.name || `Cliente ${order.customer?.id || ""}`;

    let zohoContactId: string | null = null;
    if (settings?.customers_auto_sync_on_order !== false) {
      // buscar mapping
      const { data: map } = await admin
        .from("customer_sync_map")
        .select("zoho_contact_id")
        .eq("store_id", storeId)
        .eq("email", email)
        .maybeSingle();
      if (map?.zoho_contact_id) {
        zohoContactId = map.zoho_contact_id;
      } else {
        // buscar en Zoho por email
        const searchResp = await zohoFetch(
          admin,
          conn,
          `/inventory/v1/contacts?email=${encodeURIComponent(email)}`,
        );
        const searchJson = await searchResp.json();
        const found = searchJson.contacts?.[0];
        if (found?.contact_id) {
          zohoContactId = found.contact_id;
        } else {
          // crear
          const createResp = await zohoFetch(admin, conn, `/inventory/v1/contacts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contact_name: contactName,
              contact_type: "customer",
              contact_persons: [
                {
                  first_name: contactName,
                  email,
                  phone: order.customer?.phone || "",
                  is_primary_contact: true,
                },
              ],
            }),
          });
          const createJson = await createResp.json();
          if (createResp.ok && createJson.contact?.contact_id) {
            zohoContactId = createJson.contact.contact_id;
          } else {
            console.error("zoho contact create failed", createJson);
          }
        }
        if (zohoContactId) {
          await admin.from("customer_sync_map").upsert(
            {
              store_id: storeId,
              email,
              tiendanube_customer_id: order.customer?.id || null,
              zoho_contact_id: zohoContactId,
              status: "success",
              last_synced_at: new Date().toISOString(),
            },
            { onConflict: "store_id,email" },
          );
        }
      }
    }

    // 5) Mapear line items (usar product_sync_map para encontrar zoho_item_id)
    const lineItems: Array<Record<string, unknown>> = [];
    for (const p of order.products || []) {
      let zohoItemId: string | null = null;
      if (p.sku) {
        const { data: pmap } = await admin
          .from("product_sync_map")
          .select("zoho_item_id")
          .eq("store_id", storeId)
          .eq("zoho_sku", p.sku)
          .maybeSingle();
        zohoItemId = pmap?.zoho_item_id || null;
      }
      const item: Record<string, unknown> = {
        name: p.name || "Producto",
        rate: Number(p.price || 0),
        quantity: Number(p.quantity || 1),
      };
      if (zohoItemId) item.item_id = zohoItemId;
      if (p.sku) item.sku = p.sku;
      lineItems.push(item);
    }

    // 6) Crear o actualizar Sales Order
    const { data: existingMap } = await admin
      .from("order_sync_map")
      .select("zoho_salesorder_id")
      .eq("store_id", storeId)
      .eq("tiendanube_order_id", order.id)
      .maybeSingle();

    const soBody: Record<string, unknown> = {
      customer_id: zohoContactId,
      reference_number: `TN-${order.number || order.id}`,
      line_items: lineItems,
      notes: order.note || `Importado desde Tiendanube. Estado: ${order.status}`,
      status: settings?.orders_create_as_draft ? "draft" : (settings?.orders_auto_confirm ? "confirmed" : "draft"),
    };

    let salesorderId = existingMap?.zoho_salesorder_id || null;
    let invoiceId: string | null = (existingMap as any)?.zoho_invoice_id || null;
    const isPaid = order.payment_status === "paid" || event === "order/paid";

    if (salesorderId) {
      // update
      const updResp = await zohoFetch(admin, conn, `/inventory/v1/salesorders/${salesorderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(soBody),
      });
      const updJson = await updResp.json();
      if (!updResp.ok) throw new Error(`Zoho update SO: ${JSON.stringify(updJson).slice(0, 400)}`);
    } else {
      const createResp = await zohoFetch(admin, conn, `/inventory/v1/salesorders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(soBody),
      });
      const createJson = await createResp.json();
      if (!createResp.ok || !createJson.salesorder?.salesorder_id) {
        throw new Error(`Zoho create SO: ${JSON.stringify(createJson).slice(0, 400)}`);
      }
      salesorderId = createJson.salesorder.salesorder_id;

      if (settings?.orders_auto_confirm) {
        await zohoFetch(admin, conn, `/inventory/v1/salesorders/${salesorderId}/status/confirmed`, {
          method: "POST",
        });
      }
    }

    // 7) Si está pagada: asegurar SO confirmada → crear/obtener factura → marcar como pagada
    if (isPaid && salesorderId) {
      // 7.a) Confirmar SO si aún está en draft (Zoho no permite facturar borradores)
      try {
        await zohoFetch(admin, conn, `/inventory/v1/salesorders/${salesorderId}/status/confirmed`, {
          method: "POST",
        });
      } catch (_) { /* puede ya estar confirmada */ }

      // 7.b) Crear factura si configurado y aún no existe
      if (settings?.orders_generate_invoice_on_paid && !invoiceId) {
        const invResp = await zohoFetch(
          admin,
          conn,
          `/inventory/v1/invoices/fromsalesorder?salesorder_id=${salesorderId}`,
          { method: "POST" },
        );
        const invJson = await invResp.json();
        if (invResp.ok && invJson.invoice?.invoice_id) {
          invoiceId = invJson.invoice.invoice_id;
        } else {
          console.error("invoice from SO failed", invJson);
        }
      }

      // 7.c) Marcar la factura como pagada en Zoho registrando un payment por el balance pendiente
      if (invoiceId) {
        try {
          const invGet = await zohoFetch(admin, conn, `/inventory/v1/invoices/${invoiceId}`);
          const invData = await invGet.json();
          const inv = invData?.invoice;
          const balance = Number(inv?.balance ?? inv?.total ?? order.total ?? 0);
          const customerId = inv?.customer_id || zohoContactId;
          if (balance > 0 && customerId) {
            const payResp = await zohoFetch(admin, conn, `/inventory/v1/customerpayments`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                customer_id: customerId,
                payment_mode: "Tiendanube",
                amount: balance,
                date: new Date().toISOString().slice(0, 10),
                reference_number: `TN-${order.number || order.id}`,
                description: `Pago recibido por orden Tiendanube #${order.number || order.id}`,
                invoices: [{ invoice_id: invoiceId, amount_applied: balance }],
              }),
            });
            const payJson = await payResp.json();
            if (!payResp.ok) {
              console.error("zoho payment failed", payJson);
            }
          }
        } catch (e) {
          console.error("mark invoice paid error", e);
        }
      }
    }

    // 8) Persistir mapping
    await admin.from("order_sync_map").upsert(
      {
        store_id: storeId,
        tiendanube_order_id: order.id,
        zoho_salesorder_id: salesorderId,
        zoho_invoice_id: invoiceId,
        status: "success",
        last_synced_at: new Date().toISOString(),
        last_error: null,
        payload: { event, total: order.total },
      },
      { onConflict: "store_id,tiendanube_order_id" },
    );

    await logSync(admin, storeId, {
      operation: "order_sync",
      status: "success",
      message: `Orden #${order.number || order.id} → SO ${salesorderId}`,
      duration_ms: Date.now() - t0,
    });

    return jsonOk({ ok: true, salesorder_id: salesorderId, invoice_id: invoiceId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("create-salesorder error", msg);
    try {
      const { storeId, orderId } = await req.clone().json().catch(() => ({}));
      if (storeId && orderId) {
        const admin = getAdminClient();
        await admin.from("order_sync_map").upsert(
          {
            store_id: storeId,
            tiendanube_order_id: orderId,
            status: "error",
            last_error: msg,
          },
          { onConflict: "store_id,tiendanube_order_id" },
        );
        await logSync(admin, storeId, {
          operation: "order_sync",
          status: "error",
          message: msg,
          tiendanube_product_id: null,
        });
      }
    } catch {}
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function jsonOk(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
