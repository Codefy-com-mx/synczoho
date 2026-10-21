import { beforeEach, expect, test, vi } from 'vitest';

const { tnFetch, logSync, locs } = vi.hoisted(() => ({
  tnFetch: vi.fn(),
  logSync: vi.fn(async () => {}),
  locs: { mappings: [] as any[], tn: null as any[] | null },
}));

vi.mock('../../server/functions/_shared/tiendanube.js', () => ({ tnFetchWithRetry: tnFetch }));
vi.mock('../../server/functions/_shared/locations.js', () => ({
  ZOHO_TOTAL: '__total__',
  loadLocationMappings: async () => locs.mappings,
  fetchTnLocations: async () => locs.tn,
}));
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
    getValidAccessToken: async () => 'tok',
    INVENTORY_DOMAINS: { com: 'https://inv' },
    zohoFetch: async (_a: unknown, _c: unknown, path: string) => path.includes('/itemgroups/')
      ? Response.json({ item_group: {
          group_name: 'Grupo', image_name: 'g.jpg', attribute_name1: 'Talle',
          items: [
            { item_id: 'c1', name: 'C1', sku: 'C-1', rate: 10, stock_on_hand: 5, attribute_option_name1: 'S' },
            { item_id: 'c2', name: 'C2', sku: 'C-2', rate: 10, stock_on_hand: 6, attribute_option_name1: 'M' },
          ],
        } })
      : Response.json({ item: {
          item_id: 'zoho-1', name: 'Test', category_name: 'Categoria one',
          sku: 'TEST-1', rate: 200, stock_on_hand: 20,
          locations: [{ location_id: 'ZL1', location_stock_on_hand: 8 }, { location_id: 'ZL2', location_stock_on_hand: 12 }],
        } }),
    logSync,
  };
});

import importProducts from '../../server/functions/zoho-sync-import/index';

beforeEach(() => {
  tnFetch.mockReset();
  logSync.mockClear();
  locs.mappings = [];
  locs.tn = null;
  vi.unstubAllGlobals();
});

const run = async (body: Record<string, unknown>) => {
  const response = await importProducts(new Request('http://localhost/zoho-sync-import', {
    method: 'POST', body: JSON.stringify({ store_id: '1', ...body }),
  }));
  expect(response.status).toBe(200);
  return (await response.json()).results[0];
};
const calls = () => tnFetch.mock.calls.map(([, path, init]) => ({
  path: path as string, method: (init as RequestInit | undefined)?.method ?? 'GET',
  body: (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined,
}));
const stubImage = (ok = true) => vi.stubGlobal('fetch', async () => ok ? new Response(new Uint8Array([1, 2, 3])) : new Response('x', { status: 404 }));
const tnProducts = (imageStatus = 201) => tnFetch.mockImplementation(async (_s, path: string) => {
  if (path === '/products') return Response.json({ id: 456 }, { status: 201 });
  if (path === '/products/456/images') return Response.json(imageStatus === 201 ? { id: 1 } : { message: 'bad' }, { status: imageStatus });
  if (path === '/products/456/variants') return Response.json([{ id: 9, sku: 'test-1' }]);
  if (path === '/products/456') return Response.json({ id: 456 });
  if (path === '/products/stock-price') return Response.json({}, { status: 200 });
  throw new Error(`Unexpected Tiendanube request: ${path}`);
});

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

test('POST /products no lleva images ni stock y la variante lleva inventory_levels por location mapeada', async () => {
  tnProducts();
  locs.tn = [{ id: 'L1' }, { id: 'L2' }, { id: 'L3' }];
  locs.mappings = [
    { tn_location_id: 'L1', zoho_location_id: 'ZL2' }, { tn_location_id: 'L2', zoho_location_id: null },
    { tn_location_id: 'L3', zoho_location_id: 'ZL1' },
  ];
  const result = await run({ items: [{ zoho_item_id: 'zoho-1', action: 'create' }] });
  expect(result.status).toBe('success');
  const post = calls().find((c) => c.path === '/products')!;
  expect(post.body).not.toHaveProperty('images');
  expect(post.body.variants[0]).not.toHaveProperty('stock');
  expect(post.body.variants[0]).not.toHaveProperty('stock_management');
  expect(post.body.variants[0].inventory_levels).toEqual([
    { location_id: 'L1', stock: 12 }, { location_id: 'L3', stock: 8 },
  ]);
});

test('camino legado: una sola location envía inventory_levels sin location_id', async () => {
  tnProducts();
  locs.tn = [{ id: 'L1' }];
  await run({ items: [{ zoho_item_id: 'zoho-1', action: 'create' }] });
  expect(calls().find((c) => c.path === '/products')!.body.variants[0].inventory_levels).toEqual([{ stock: 20 }]);
});

test('2 locations de Tiendanube sin mapear: no se envía inventory_levels y el resultado lo avisa', async () => {
  tnProducts();
  locs.tn = [{ id: 'L1' }, { id: 'L2' }];
  const result = await run({ items: [{ zoho_item_id: 'zoho-1', action: 'create' }] });
  expect(result.status).toBe('success');
  expect(result.message).toContain('locations sin mapear: el stock no se envió');
  const variant = calls().find((c) => c.path === '/products')!.body.variants[0];
  expect(variant).not.toHaveProperty('inventory_levels');
  expect(variant).not.toHaveProperty('stock');
});

test('tras crear sube una imagen por POST /products/{id}/images con {attachment, filename, position}', async () => {
  tnProducts();
  stubImage();
  const result = await run({ items: [{ zoho_item_id: 'group:g1', action: 'create' }], fields: { images: true } });
  expect(result.status).toBe('success');
  const all = calls();
  expect(all.find((c) => c.path === '/products')!.body).not.toHaveProperty('images');
  const images = all.filter((c) => c.path === '/products/456/images');
  expect(images).toHaveLength(2);
  expect(images[0].method).toBe('POST');
  expect(images[0].body).toEqual({ attachment: expect.any(String), filename: 'g.jpg', position: 1 });
  expect(images[1].body.position).toBe(2);
  expect(all.findIndex((c) => c.path === '/products')).toBeLessThan(all.findIndex((c) => c.path === '/products/456/images'));
});

test('una imagen que falla se registra en sync_logs y cuenta como aviso, sin romper la creación', async () => {
  tnProducts(422);
  stubImage();
  const result = await run({ items: [{ zoho_item_id: 'zoho-1', action: 'create' }], fields: { images: true } });
  expect(result.status).toBe('success');
  expect(result.tiendanube_product_id).toBe(456);
  expect(result.message).toContain('1 imagen');
  expect(logSync).toHaveBeenCalledWith(expect.anything(), '1', expect.objectContaining({
    operation: 'import_image', status: 'error', tiendanube_product_id: 456, message: expect.stringContaining('422'),
  }));
});

test('update: no hace PUT de variante con stock; envía PATCH /products/stock-price con precio y levels', async () => {
  tnProducts();
  locs.tn = [{ id: 'L1' }];
  const result = await run({ items: [{ zoho_item_id: 'zoho-1', action: 'update', tiendanube_product_id: 456 }] });
  expect(result.status).toBe('success');
  const all = calls();
  expect(all.some((c) => c.method === 'PUT' && c.path.includes('/variants/'))).toBe(false);
  const patch = all.find((c) => c.path === '/products/stock-price')!;
  expect(patch.method).toBe('PATCH');
  expect(patch.body).toEqual([{ id: 456, variants: [{ id: 9, price: '200', inventory_levels: [{ stock: 20 }] }] }]);
});

test('update con stock=false o price=false omite la parte correspondiente', async () => {
  tnProducts();
  await run({ items: [{ zoho_item_id: 'zoho-1', action: 'update', tiendanube_product_id: 456 }], fields: { stock: false } });
  expect(calls().find((c) => c.path === '/products/stock-price')!.body[0].variants[0]).toEqual({ id: 9, price: '200' });
  tnFetch.mockClear();
  tnProducts();
  await run({ items: [{ zoho_item_id: 'zoho-1', action: 'update', tiendanube_product_id: 456 }], fields: { price: false } });
  expect(calls().find((c) => c.path === '/products/stock-price')!.body[0].variants[0]).toEqual({ id: 9, inventory_levels: [{ stock: 20 }] });
});

test('update con 2 locations sin mapear: manda solo el precio y avisa', async () => {
  tnProducts();
  locs.tn = [{ id: 'L1' }, { id: 'L2' }];
  const result = await run({ items: [{ zoho_item_id: 'zoho-1', action: 'update', tiendanube_product_id: 456 }] });
  expect(result.message).toContain('locations sin mapear');
  expect(calls().find((c) => c.path === '/products/stock-price')!.body[0].variants[0]).toEqual({ id: 9, price: '200' });
});
