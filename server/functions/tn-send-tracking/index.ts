import { serve } from "../../runtime.js";
// Envía código de seguimiento (tracking) a Tiendanube para un pedido ya facturado.
// POST { storeId, orderId, trackingCode, trackingUrl?, carrier? }
//
// Flujo:
//  1. Obtiene los fulfillment_orders del pedido
//  2. Para cada fulfillment_order actualiza: status=DISPATCHED, tracking_code, tracking_url
//  3. Actualiza el shipping status del pedido a "shipped"
//  4. notify_customer: true → TN envía el email de seguimiento al consumidor final
//
// Compatible con los pasos 16 y 17 del guión de homologación ERP de Tiendanube.
import { corsHeaders, getAdminClient, logSync } from "../_shared/zoho.js";
import { getStore, tnFetch, tnFetchJson } from "../_shared/tiendanube.js";

interface TrackingRequest {
  storeId: string;
  orderId: number;
  trackingCode: string;
  trackingUrl?: string;
  carrier?: string;
  notifyCustomer?: boolean;
}

interface FulfillmentOrder {
  id: number;
  status: string;
  shipping_address?: object;
}

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const t0 = Date.now();
  try {
    const body = await req.json() as TrackingRequest;
    const {
      storeId,
      orderId,
      trackingCode,
      trackingUrl = "",
      carrier = "",
      notifyCustomer = true,
    } = body;

    if (!storeId || !orderId || !trackingCode) {
      return json({ error: "storeId, orderId y trackingCode son requeridos" }, 400);
    }

    const admin = getAdminClient();
    const store = await getStore(admin, storeId);

    // 1) Obtener fulfillment_orders del pedido
    let fulfillmentOrders: FulfillmentOrder[] = [];
    try {
      fulfillmentOrders = await tnFetchJson<FulfillmentOrder[]>(
        store,
        `/orders/${orderId}/fulfillment_orders`,
      );
    } catch (e) {
      console.warn("[tracking] No se pudieron obtener fulfillment_orders:", e);
    }

    const results: Array<{ fulfillment_order_id: number; ok: boolean; error?: string }> = [];

    if (fulfillmentOrders.length > 0) {
      // 2) Actualizar cada fulfillment_order con tracking + status DISPATCHED
      for (const fo of fulfillmentOrders) {
        const body = JSON.stringify({
          status: "DISPATCHED",
          tracking_code: trackingCode,
          tracking_url: trackingUrl || undefined,
          carrier: carrier || undefined,
          notify_customer: notifyCustomer,
        });
        const r = await tnFetch(store, `/orders/${orderId}/fulfillment_orders/${fo.id}`, {
          method: "PUT",
          body,
        });
        const text = await r.text();
        if (r.ok) {
          results.push({ fulfillment_order_id: fo.id, ok: true });
          console.log(`[tracking] FO ${fo.id} → DISPATCHED OK`);
        } else {
          results.push({ fulfillment_order_id: fo.id, ok: false, error: text.slice(0, 200) });
          console.error(`[tracking] FO ${fo.id} error ${r.status}: ${text.slice(0, 200)}`);
        }
      }
    } else {
      // Fallback: actualizar directamente el shipping del pedido (órdenes sin fulfillment_orders)
      const r = await tnFetch(store, `/orders/${orderId}`, {
        method: "PUT",
        body: JSON.stringify({
          shipping_tracking_number: trackingCode,
          shipping_tracking_url: trackingUrl || undefined,
          notify_customer: notifyCustomer,
        }),
      });
      const text = await r.text();
      if (r.ok) {
        results.push({ fulfillment_order_id: 0, ok: true });
      } else {
        results.push({ fulfillment_order_id: 0, ok: false, error: text.slice(0, 200) });
      }
    }

    // 3) Log de la operación
    const allOk = results.every((r) => r.ok);
    await logSync(admin, storeId, {
      operation: "send_tracking",
      status: allOk ? "success" : "error",
      message: `Tracking #${trackingCode} enviado para orden ${orderId} (${results.length} fulfillment_orders)`,
      duration_ms: Date.now() - t0,
      payload: { orderId, trackingCode, trackingUrl, results },
    });

    return json({ ok: allOk, results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error desconocido";
    console.error("[tn-send-tracking] Error:", msg);
    return json({ error: msg }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
