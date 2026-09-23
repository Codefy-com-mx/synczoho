import { createHmac, timingSafeEqual } from "node:crypto";
import { serve } from "../../runtime.js";
import { getPool } from "../../db.js";
import { corsHeaders } from "../_shared/zoho.js";

const privacyEvents: Record<string, string> = {
  "privacy-store-redact": "app/store_redact",
  "privacy-customer-redact": "customer/redact",
  "privacy-data-request": "customers/data_request",
};

export function verifyWebhookSignature(body: Uint8Array, signature: string | null, secret: string): boolean {
  if (!secret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

export default serve(async (req) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const raw = Buffer.from(await req.arrayBuffer());
  if (!verifyWebhookSignature(raw, req.headers.get("x-linkedstore-hmac-sha256"), process.env.TIENDANUBE_CLIENT_SECRET || "")) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }
  const name = new URL(req.url).pathname.replace(/\/$/, "").split("/").pop() || "";
  const event = privacyEvents[name] || payload.event;
  const storeId = String(payload.store_id ?? "");
  if (!/^[0-9]+$/.test(storeId) || typeof event !== "string" ||
      (privacyEvents[name] && payload.event && payload.event !== event) ||
      (event.startsWith("order/") && !Number.isSafeInteger(Number(payload.id)))) {
    return new Response(JSON.stringify({ error: "Invalid event" }), { status: 400 });
  }
  if (event === "customer/redact" || event === "customers/data_request") {
    const customer = payload.customer;
    if (!customer || typeof customer !== "object" ||
        !Number.isSafeInteger(Number((customer as Record<string, unknown>).id))) {
      return new Response(JSON.stringify({ error: "Invalid customer" }), { status: 400 });
    }
  }
  if (name === "privacy-store-redact" &&
      Object.keys(payload).some((key) => key !== "store_id" && key !== "event")) {
    return new Response(JSON.stringify({ error: "Invalid store redact payload" }), { status: 400 });
  }
  if (name === "privacy-customer-redact" &&
      (payload.data_request || (payload.orders_to_redact !== undefined && !Array.isArray(payload.orders_to_redact)))) {
    return new Response(JSON.stringify({ error: "Invalid customer redact payload" }), { status: 400 });
  }
  if (name === "privacy-data-request" && !payload.data_request) {
    return new Response(JSON.stringify({ error: "Invalid data request payload" }), { status: 400 });
  }
  try {
    await getPool().query(
      "INSERT INTO webhook_events (store_id, event_type, payload) VALUES ($1,$2,$3)",
      [storeId, event, JSON.stringify(payload)],
    );
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Webhook persistence failed", error instanceof Error ? error.name : "unknown");
    return new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 });
  }
});
