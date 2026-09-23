import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../server/db", () => ({ getPool: () => ({ query }) }));
import handler from "../../server/functions/tiendanube-webhook";

const secret = "webhook-secret";
function request(name: string, payload: unknown, valid = true): Request {
  const raw = JSON.stringify(payload);
  return new Request(`https://app.example.com/api/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "x-linkedstore-hmac-sha256": valid
        ? createHmac("sha256", secret).update(raw).digest("hex")
        : "0".repeat(64),
    },
    body: raw,
  });
}

beforeEach(() => {
  process.env.TIENDANUBE_CLIENT_SECRET = secret;
  query.mockReset().mockResolvedValue({ rowCount: 1 });
});

describe("Tiendanube webhook receiver", () => {
  it("persists only a signed event and returns 503 when persistence fails", async () => {
    const payload = { store_id: 123, event: "order/paid", id: 45 };
    expect((await handler(request("tiendanube-webhook", payload, false))).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect((await handler(request("tiendanube-webhook", payload))).status).toBe(200);
    expect(query).toHaveBeenCalledOnce();
    query.mockRejectedValueOnce(new Error("db down"));
    expect((await handler(request("tiendanube-webhook", payload))).status).toBe(503);
  });

  it("accepts store redact only on its dedicated URL with the expected payload", async () => {
    expect((await handler(request("privacy-store-redact", { store_id: 123 }))).status).toBe(200);
    expect((await handler(request("privacy-store-redact", {
      store_id: 123, event: "app/store_redact",
    }))).status).toBe(200);
    expect((await handler(request("privacy-store-redact", {
      store_id: 123, event: "order/paid", id: 45,
    }))).status).toBe(400);
  });
});
