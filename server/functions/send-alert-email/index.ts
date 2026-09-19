import { serve } from "../../runtime.js";
// Envía email de alerta cuando ocurre un error crítico en una sincronización.
// Usa Resend API. Requiere RESEND_API_KEY y RESEND_FROM_EMAIL en el entorno.
import { corsHeaders, getAdminClient } from "../_shared/zoho.js";

const OP_LABELS: Record<string, string> = {
  stock_sync_run:  "Sincronización de stock",
  price_sync_run:  "Sincronización de precios",
  order_sync:      "Sincronización de orden",
  zoho_sync_import: "Importación de productos",
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export default serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { storeId, operation, errorMessage, storeName } = await req.json() as {
      storeId: string;
      operation: string;
      errorMessage: string;
      storeName?: string;
    };

    if (!storeId || !operation || !errorMessage) {
      return json({ error: "storeId, operation y errorMessage son requeridos" }, 400);
    }

    const admin = getAdminClient();

    // Verificar que la tienda tenga alertas activas y email configurado
    const { data: settings } = await admin
      .from("sync_settings")
      .select("alert_on_error, alert_email")
      .eq("store_id", storeId)
      .maybeSingle();

    if (!settings?.alert_on_error || !settings?.alert_email) {
      return json({ skipped: true, reason: "Alertas desactivadas o sin email configurado" });
    }

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      return json({ error: "RESEND_API_KEY no está configurado" }, 500);
    }

    const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "alertas@synczoho.app";
    const opLabel = OP_LABELS[operation] ?? operation;
    const now = new Date().toLocaleString("es-AR", {
      dateStyle: "short",
      timeStyle: "short",
    });

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;color:#1a1a2e;background:#f5f5f5;margin:0;padding:20px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
    <div style="background:#e07856;padding:24px 28px">
      <h1 style="margin:0;font-size:18px;color:#fff">⚠️ Error en sincronización</h1>
    </div>
    <div style="padding:28px">
      <p style="margin:0 0 16px;font-size:14px;color:#555">
        Se detectó un error automático en tu integración ZohoSync.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:8px 0;color:#888;width:120px">Tienda</td>
          <td style="padding:8px 0;font-weight:600">${storeName ?? storeId}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:8px 0;color:#888">Operación</td>
          <td style="padding:8px 0;font-weight:600">${opLabel}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:8px 0;color:#888">Fecha</td>
          <td style="padding:8px 0">${now}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#888;vertical-align:top">Error</td>
          <td style="padding:8px 0;color:#c0392b;font-family:monospace;font-size:12px;word-break:break-all">${errorMessage}</td>
        </tr>
      </table>
      <div style="margin-top:24px;padding:16px;background:#fef9f0;border-radius:8px;border-left:3px solid #e07856">
        <p style="margin:0;font-size:13px;color:#555">
          Revisá el <strong>Historial</strong> en tu panel ZohoSync para ver el detalle completo del error.
        </p>
      </div>
    </div>
    <div style="padding:16px 28px;background:#f9f9f9;border-top:1px solid #eee">
      <p style="margin:0;font-size:12px;color:#aaa">
        Este email fue enviado automáticamente por ZohoSync. Para desactivar estas alertas,
        ingresá a Configuración → Alertas.
      </p>
    </div>
  </div>
</body>
</html>`;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: settings.alert_email,
        subject: `[ZohoSync] Error en ${opLabel}`,
        html,
      }),
    });

    const resBody = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error("Resend error", r.status, JSON.stringify(resBody));
      return json({ error: `Resend ${r.status}: ${JSON.stringify(resBody)}` }, 500);
    }

    return json({ sent: true, to: settings.alert_email, resend_id: (resBody as any).id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    console.error("send-alert-email error", msg);
    return json({ error: msg }, 500);
  }
});
