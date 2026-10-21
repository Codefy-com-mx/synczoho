import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildEvent, parseArgs, parseOrderIds, signBody, validateRates, verdictLine } from "../../scripts/loadtest/webhook-burst.mjs";
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

describe("loadtest --no-drain", () => {
  it("parseArgs trata --no-drain como bandera sin valor y no se come la siguiente opción", () => {
    expect(parseArgs(["--url", "u", "--no-drain", "--rps", "5"])).toEqual({ url: "u", "no-drain": true, rps: "5" });
    expect(parseArgs(["--rps", "5", "--no-drain"])).toEqual({ rps: "5", "no-drain": true });
  });

  // Se ejecuta el CLI real en un proceso Node aparte (el entorno jsdom de vitest no sirve para fetch con AbortSignal).
  it("el CLI con --no-drain no consulta /api/status y termina con drenado no evaluado", async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? "");
      req.resume();
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
      const out = await new Promise<{ code: number; stdout: string }>((resolve) => {
        const child = execFile(
          process.execPath,
          ["scripts/loadtest/webhook-burst.mjs", "--url", url, "--rps", "5", "--duration", "1", "--no-drain"],
          { env: { ...process.env, TIENDANUBE_CLIENT_SECRET: "s" } },
          (err, stdout) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout }),
        );
        child.on("error", () => resolve({ code: 1, stdout: "" }));
      });
      expect(out.stdout).toContain("drenado de cola: omitido (--no-drain)");
      expect(out.stdout).toContain("RESULTADO: OK (drenado no evaluado)");
      expect(out.code).toBe(0);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((p) => p === "/hook")).toBe(true);
    } finally {
      server.close();
    }
  });
});
