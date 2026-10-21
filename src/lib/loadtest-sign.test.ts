import { describe, expect, it } from "vitest";
import { signBody } from "../../scripts/loadtest/webhook-burst.mjs";
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
