import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryDelayMs, tnFetchWithRetry } from "../../server/functions/_shared/tiendanube.js";

const store = { store_id: "1", access_token: "tok", store_name: null };
const r0 = () => 0;

describe("retryDelayMs", () => {
  it("429 usa Retry-After en segundos", () => {
    expect(retryDelayMs(429, 0, "3", r0)).toBe(3000);
  });
  it("429 sin Retry-After: 2000*2^attempt con tope 30000", () => {
    expect(retryDelayMs(429, 2, null, r0)).toBe(8000);
    expect(retryDelayMs(429, 10, null, r0)).toBe(30000);
  });
  it("5xx y red: 500*2^attempt con tope 8000", () => {
    expect(retryDelayMs(503, 1, null, r0)).toBe(1000);
    expect(retryDelayMs(0, 0, null, r0)).toBe(500);
    expect(retryDelayMs(503, 10, null, r0)).toBe(8000);
  });
  it("500, 502, 503, 504 son reintentables", () => {
    for (const s of [500, 502, 503, 504]) expect(retryDelayMs(s, 0, null)).not.toBeNull();
  });
  it("404, 422, 200, 501 no se reintentan", () => {
    for (const s of [404, 422, 200, 501]) expect(retryDelayMs(s, 0, null)).toBeNull();
  });
  it("jitter máximo suma 25%", () => {
    expect(retryDelayMs(429, 0, null, () => 1)).toBe(2500);
    expect(retryDelayMs(503, 0, null, () => 1)).toBe(625);
  });
});

describe("tnFetchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const run = async (p: Promise<Response>) => {
    const settled = p.then((v) => v, (e) => { throw e; });
    settled.catch(() => {});
    await vi.runAllTimersAsync();
    return settled;
  };

  it("503, 503, 200 → 3 llamadas y devuelve 200", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", f);
    const resp = await run(tnFetchWithRetry(store, "/x"));
    expect(resp.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("error de red y luego 200 → reintenta", async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", f);
    const resp = await run(tnFetchWithRetry(store, "/x"));
    expect(resp.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("error de red persistente → relanza y avisa al observer", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", f);
    const onExhausted = vi.fn();
    await expect(run(tnFetchWithRetry(store, "/x", {}, 2, { onExhausted }))).rejects.toThrow("fetch failed");
    expect(f).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledWith({ status: 0, path: "/x" });
  });

  it("429 x5 → devuelve el último 429 y llama onExhausted una vez", async () => {
    const f = vi.fn().mockImplementation(async () => new Response("", { status: 429 }));
    vi.stubGlobal("fetch", f);
    const onExhausted = vi.fn();
    const resp = await run(tnFetchWithRetry(store, "/p", {}, 4, { onExhausted }));
    expect(resp.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(5);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledWith({ status: 429, path: "/p" });
  });

  it("404 → 1 llamada, sin observer", async () => {
    const f = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", f);
    const onExhausted = vi.fn();
    const resp = await run(tnFetchWithRetry(store, "/x", {}, 4, { onExhausted }));
    expect(resp.status).toBe(404);
    expect(f).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled();
  });
});
