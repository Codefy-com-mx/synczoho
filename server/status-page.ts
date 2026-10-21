// HTML autocontenido: sin recursos externos, sin datos de tiendas. Consulta /api/status cada 30 s.
// El script es inline; el CSP actual solo define frame-ancestors, así que no lo bloquea.
export function renderStatusPage(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Estado del servicio</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
  .badge { display: inline-block; padding: .25rem .75rem; border-radius: 999px; font-weight: 600; background: #ddd; }
  .ok { background: #d1f2d9; color: #0b5a1f; } .degraded { background: #fdf0c4; color: #7a5a00; } .down { background: #f9d3d3; color: #8a1111; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: .25rem 1rem; } dt { color: #555; } dd { margin: 0; text-align: right; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } dt { color: #aaa; } }
</style>
</head>
<body>
<h1>Estado del servicio</h1>
<p><span id="status" class="badge">Consultando...</span></p>
<dl id="details"></dl>
<p id="checked"></p>
<script>
  var labels = { ok: "Operativo", degraded: "Degradado", down: "Caído" };
  function row(name, value) {
    var dt = document.createElement("dt"); dt.textContent = name;
    var dd = document.createElement("dd"); dd.textContent = value;
    return [dt, dd];
  }
  function show(data) {
    var badge = document.getElementById("status");
    badge.textContent = labels[data.status] || data.status;
    badge.className = "badge " + data.status;
    var details = document.getElementById("details");
    details.textContent = "";
    [
      ["Versión", data.version || "unknown"],
      ["Base de datos", data.database === "ok" ? "Operativa" : "Caída"],
      ["Eventos pendientes", data.queue.pending],
      ["Antigüedad del más viejo (s)", data.queue.oldest_pending_seconds],
      ["Eventos fallidos", data.queue.failed],
      ["Catálogos desactualizados", data.stale_catalogs],
      ["Última sincronización de stock", data.scheduler.stock_last_success || "—"],
      ["Última sincronización de precios", data.scheduler.prices_last_success || "—"]
    ].forEach(function (r) { row(r[0], r[1]).forEach(function (n) { details.appendChild(n); }); });
    document.getElementById("checked").textContent = "Actualizado: " + data.checked_at;
  }
  function load() {
    fetch("/api/status", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(show)
      .catch(function () { show({ status: "down", version: "unknown", database: "down", queue: { pending: 0, oldest_pending_seconds: 0, failed: 0 }, stale_catalogs: 0, scheduler: {}, checked_at: new Date().toISOString() }); });
  }
  load();
  setInterval(load, 30000);
</script>
</body>
</html>`;
}
