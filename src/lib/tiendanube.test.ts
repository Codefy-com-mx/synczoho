import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn(() => ({})));

vi.mock('@tiendanube/nexo', () => ({ default: { create } }));

describe('configuración de Tiendanube', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_TIENDANUBE_APP_ID', '40863');
    create.mockClear();
  });

  it('construye las URLs con el App ID 40863', async () => {
    const { TIENDANUBE_APP_ID, getAuthorizationUrl, getEmbeddedAdminAppUrl } = await import('./tiendanube');

    expect(TIENDANUBE_APP_ID).toBe('40863');
    expect(getAuthorizationUrl(TIENDANUBE_APP_ID)).toBe('https://www.tiendanube.com/apps/40863/authorize');
    expect(getEmbeddedAdminAppUrl('https://demo.mitiendanube.com/', TIENDANUBE_APP_ID)).toBe(
      'https://demo.mitiendanube.com/admin/apps/40863',
    );
  });

  it('configura Nexo con la misma constante', async () => {
    await import('./nexoClient');

    expect(create).toHaveBeenCalledWith({ clientId: '40863', log: true });
  });
});
