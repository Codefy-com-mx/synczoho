import { expect, test, vi } from 'vitest';

const { tnFetch } = vi.hoisted(() => ({ tnFetch: vi.fn() }));

vi.mock('../../server/functions/_shared/tiendanube.js', () => ({ tnFetchWithRetry: tnFetch }));
vi.mock('../../server/functions/_shared/zoho.js', () => {
  const query: Record<string, any> = {};
  query.select = () => query;
  query.eq = () => query;
  query.maybeSingle = async () => ({ data: { store_id: '1', access_token: 'token' } });
  query.upsert = async () => ({ error: null });
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [] }).then(resolve);
  return {
    corsHeaders: {},
    getAdminClient: () => ({ from: () => query }),
    getZohoConnection: async () => ({}),
    zohoFetch: async () => Response.json({ item: {
      item_id: 'zoho-1', name: 'Test', category_name: 'Categoria one',
      sku: 'TEST-1', rate: 200, stock_on_hand: 20,
    } }),
    logSync: async () => {},
  };
});

import importProducts from '../../server/functions/zoho-sync-import/index';

test('crea una categoría y envía solo su ID numérico al importar el producto', async () => {
  let productPayload: any;
  tnFetch.mockImplementation(async (_store, path: string, init?: RequestInit) => {
    if (path.startsWith('/categories?')) return Response.json([]);
    if (path === '/categories') return Response.json({ id: 123 }, { status: 201 });
    if (path === '/products') {
      productPayload = JSON.parse(String(init?.body));
      return Response.json({ id: 456 }, { status: 201 });
    }
    throw new Error(`Unexpected Tiendanube request: ${path}`);
  });

  const response = await importProducts(new Request('http://localhost/zoho-sync-import', {
    method: 'POST',
    body: JSON.stringify({
      store_id: '1',
      items: [{ zoho_item_id: 'zoho-1', action: 'create' }],
      fields: { category: true },
    }),
  }));

  expect(response.status).toBe(200);
  expect((await response.json()).results[0].status).toBe('success');
  expect(productPayload.categories).toEqual([123]);
  expect(tnFetch.mock.calls.map(([, path]) => path)).toEqual([
    '/categories?per_page=200&page=1&fields=id,name', '/categories', '/products',
  ]);
});
