import { describe, expect, it } from "vitest";
import { buildEvent, parseOrderIds, signBody, validateRates, verdictLine } from "../../scripts/loadtest/webhook-burst.mjs";
import { verifyWebhookSignature } from "../../server/functions/tiendanube-webhook";

describe("loadtest signBody", () => {
  const body = JSON.stringify({ store_id: 123, event: "product/updated", id: 42 });

  it("produce una firma que el receptor acepta", () => {
    expect(verifyWebhookSignature(Buffer.from(body), signBody(body, "s"), "s")).toBe(true);
  });

  it("el receptor la rechaza con otro secreto", () => {
    expect(verifyWebhookSignature(Buffer.from(body), signBody(body, "s"), "otro")).toBe(false);
  });
});

describe("loadtest buildEvent", () => {
  it("sin --order-ids solo envía product/updated (ids enteros)", () => {
    for (let i = 0; i < 200; i++) {
      const e = buildEvent(1, [], i / 200);
      expect(e.event).toBe("product/updated");
      expect(Number.isSafeInteger(e.id)).toBe(true);
    }
  });

  it("con --order-ids mezcla 80 % product/updated y 20 % order/paid con los ids dados", () => {
    const ids = [101, 102];
    const events = Array.from({ length: 1000 }, (_, i) => buildEvent(7, ids, i / 1000));
    expect(events.filter((e) => e.event === "order/paid")).toHaveLength(200);
    for (const e of events.filter((x) => x.event === "order/paid")) expect(ids).toContain(e.id);
    expect(events.every((e) => e.store_id === 7)).toBe(true);
  });

  it("parseOrderIds acepta enteros separados por coma y rechaza basura", () => {
    expect(parseOrderIds(undefined)).toEqual([]);
    expect(parseOrderIds("101, 102,103")).toEqual([101, 102, 103]);
    expect(() => parseOrderIds("101,abc")).toThrow();
  });
});

describe("loadtest validación y veredicto", () => {
  it("validateRates exige rps y duration finitos y > 0", () => {
    expect(validateRates(5, 60)).toBeNull();
    expect(validateRates(0, 60)).toMatch(/rps/);
    expect(validateRates(5, NaN)).toMatch(/duration/);
    expect(validateRates(-1, 60)).toMatch(/rps/);
  });

  it("verdictLine dice explícitamente cuando el drenado no se evaluó", () => {
    expect(verdictLine([], { measured: false })).toBe("RESULTADO: OK (drenado no evaluado)");
    expect(verdictLine([], { measured: true, seconds: 10 })).toBe("RESULTADO: OK");
    expect(verdictLine(["p95 alto"], { measured: false })).toMatch(/^RESULTADO: FALLA/);
  });
});
