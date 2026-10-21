// Scopes que MultiCD necesita en el token de Tiendanube.
export const REQUIRED_SCOPES = ["read_products", "write_products", "read_locations", "read_fulfillment_orders"];

/** Scopes requeridos ausentes de `stores.scopes` (lista separada por comas/espacios; distingue mayúsculas). */
export function missingScopes(scopes: string | null | undefined): string[] {
  const granted = new Set((scopes ?? "").split(/[\s,]+/).filter(Boolean));
  return REQUIRED_SCOPES.filter((s) => !granted.has(s));
}
