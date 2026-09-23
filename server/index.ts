import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { closeDatabase, getPool } from "./db.js";
import { handlers } from "./handlers.js";
import { runMigrations } from "./migrate.js";
import { createTickGuard } from "./scheduler.js";
import { applySecurityHeaders } from "./security-headers.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const publicDirectory = path.resolve(process.cwd(), "dist");
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 5 * 1024 * 1024);

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  applySecurityHeaders(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function requestBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const protocol = headers.get("x-forwarded-proto") || "http";
  const authority = headers.get("x-forwarded-host") || headers.get("host") || `localhost:${port}`;
  return new Request(`${protocol}://${authority}${request.url || "/"}`, {
    method: request.method,
    headers,
    body: await requestBody(request),
  });
}

async function sendWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  applySecurityHeaders(response);
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  response.statusCode = webResponse.status;
  if (webResponse.body === null) {
    response.end();
    return;
  }
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

async function serveFunction(request: IncomingMessage, response: ServerResponse, name: string): Promise<void> {
  const handler = handlers[name];
  if (!handler) {
    sendJson(response, 404, { error: `Unknown function: ${name}` });
    return;
  }
  try {
    await sendWebResponse(response, await handler(await toWebRequest(request)));
  } catch (error) {
    console.error(`Function ${name} failed`, error);
    sendJson(response, error instanceof Error && error.message.includes("too large") ? 413 : 500, {
      error: "Internal server error",
    });
  }
}

async function serveStatic(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  let relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!relativePath || relativePath.endsWith("/")) relativePath += "index.html";
  let filePath = path.resolve(publicDirectory, relativePath);
  if (!filePath.startsWith(`${publicDirectory}${path.sep}`) && filePath !== publicDirectory) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    if (!(await stat(filePath)).isFile()) throw new Error("not a file");
  } catch {
    filePath = path.join(publicDirectory, "index.html");
  }

  try {
    const body = await readFile(filePath);
    applySecurityHeaders(response);
    response.setHeader("Content-Type", mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream");
    if (path.basename(filePath) === "index.html") {
      response.setHeader("Cache-Control", "no-cache");
    } else {
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
    response.statusCode = 200;
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/health") {
    try {
      await getPool().query("SELECT 1");
      sendJson(response, 200, { status: "ok" });
    } catch (error) {
      console.error("Health check failed", error);
      sendJson(response, 503, { status: "unavailable" });
    }
    return;
  }

  const functionMatch = url.pathname.match(/^\/(?:api\/)?functions\/v1\/([a-z0-9-]+)\/?$/);
  if (functionMatch) {
    await serveFunction(request, response, functionMatch[1]);
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/functions/")) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  await serveStatic(request, response, url.pathname);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received; shutting down`);
  server.close(async () => {
    await closeDatabase().catch((error) => console.error("Database shutdown failed", error));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

await runMigrations();
server.listen(port, host, () => {
  console.log(`ZohoSync listening on http://${host}:${port}`);
});

if (process.env.DISABLE_SCHEDULER !== "true") {
  // A tick that is still running blocks the next one instead of overlapping
  // it. A hanging child keeps the guard busy until it settles.
  const runScheduler = createTickGuard(async () => {
    try {
      const handler = handlers["sync-auto-run"];
      const result = await handler(new Request(`http://127.0.0.1:${port}/api/functions/v1/sync-auto-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }));
      if (!result.ok) console.error("Scheduled sync failed", result.status, await result.text());
    } catch (error) {
      console.error("Scheduled sync failed", error);
    }
  }, () => console.log("Scheduled sync tick skipped: previous tick still running"));
  setTimeout(runScheduler, 30_000).unref();
  setInterval(runScheduler, 15 * 60_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
