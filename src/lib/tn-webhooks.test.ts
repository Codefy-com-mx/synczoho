import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUIRED_EVENTS, syncStoreWebhooks } from "../../server/functions/_shared/webhooks";

const store = { store_id: "123", access_token: "tn-token", store_name: "Demo" };
const appUrl = "https://app.example.com";
const url = `${appUrl}/api/functions/v1/tiendanube-webhook`;

function stubTiendanube(existing: Array<{ id: number; event: string; url: string }>) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(input).pathname.replace("/v1/123", "");
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET") return Response.json(existing);
    if (method === "POST") return Response.json({ id: 900 }, { status: 201 });
    return new Response(null, { status: 200 });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("Tiendanube webhooks", () => {
  it("only asks for events the worker actually processes", () => {
    expect(REQUIRED_EVENTS).not.toContain("customer/created");
    expect(REQUIRED_EVENTS).not.toContain("customer/updated");
    expect(REQUIRED_EVENTS).toEqual(expect.arrayContaining([
      "order/created", "order/updated", "order/paid", "order/cancelled",
      "app/uninstalled", "app/suspended", "app/resumed",
      "product/created", "product/updated", "product/deleted",
      "category/created", "category/updated", "category/deleted",
      "location/created", "location/updated", "location/deleted",
    ]));
  });

  it("registers only the missing events and removes the ones no longer used", async () => {
    const calls = stubTiendanube([
      { id: 1, event: "order/created", url },
      { id: 2, event: "customer/created", url },
      { id: 3, event: "customer/created", url: "https://other-app.example.com/hook" },
    ]);

    const result = await syncStoreWebhooks(store, appUrl);

    const posted = calls.filter((c) => c.method === "POST").map((c) => c.body.event);
    expect(posted).toEqual(REQUIRED_EVENTS.filter((e) => e !== "order/created"));
    expect(calls.filter((c) => c.method === "POST").every((c) => c.body.url === url)).toBe(true);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/webhooks/2"]);
    expect(result.errors).toEqual([]);
  });

  it("makes no writes when every event is already registered", async () => {
    const calls = stubTiendanube(REQUIRED_EVENTS.map((event, id) => ({ id, event, url })));

    await syncStoreWebhooks(store, appUrl);

    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});
