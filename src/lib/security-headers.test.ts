import type { ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import { applySecurityHeaders } from "../../server/security-headers";

it("permite embeber la app en el admin de Tiendanube sin abrirla a otros sitios", () => {
  const setHeader = vi.fn();
  applySecurityHeaders({ setHeader } as unknown as ServerResponse);

  expect(setHeader).toHaveBeenCalledWith(
    "Content-Security-Policy",
    "frame-ancestors 'self' https://*.mitiendanube.com",
  );
  expect(setHeader).not.toHaveBeenCalledWith("X-Frame-Options", expect.anything());
});
