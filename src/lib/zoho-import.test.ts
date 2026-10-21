import { beforeEach, expect, test, vi } from 'vitest';

const { tnFetch, logSync, locs, zoho, cache } = vi.hoisted(() => ({
  cache: { catalog: [] as any[], loads: 0 },
  tnFetch: vi.fn(),
  logSync: vi.fn(async () => {}),
  locs: { mappings: [] as any[], tn: null as any[] | null },
  zoho: { groupItems: null as any[] | null, child: {} as Record<string, () => Response>, childCalls: [] as string[] },
}));

vi.mock('../../server/functions/_shared/tiendanube.js', () => ({ tnFetchWithRetry: tnFetch }));
vi.mock('../../server/functions/_shared/tn-catalog.js', () => ({
  loadCatalog: async () => { cache.loads++; return cache.catalog; },
}));
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
          items: zoho.groupItems ?? [
            { item_id: 'c1', name: 'C1', sku: 'C-1', rate: 10, stock_on_hand: 5, attribute_option_name1: 'S' },
            { item_id: 'c2', name: 'C2', sku: 'C-2', rate: 10, stock_on_hand: 6, attribute_option_name1: 'M' },
          ],
        } })
      : (zoho.childCalls.push(path), zoho.child[path]?.()) ?? Response.json({ item: {
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
  zoho.groupItems = null;
  zoho.child = {};
  zoho.childCalls = [];
  cache.catalog = [];
  cache.loads = 0;
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
let tnVariants: any[] = [{ id: 9, sku: 'test-1' }];
let stockPriceStatus = 200;
beforeEach(() => { tnVariants = [{ id: 9, sku: 'test-1' }]; stockPriceStatus = 200; });
const tnProducts = (imageStatus = 201) => tnFetch.mockImplementation(async (_s, path: string) => {
  if (path === '/products') return Response.json({ id: 456 }, { status: 201 });
  if (path === '/products/456/images') return Response.json(imageStatus === 201 ? { id: 1 } : { message: 'bad' }, { status: imageStatus });
  if (path === '/products/456/variants') return Response.json(tnVariants);
  if (path === '/products/456') return Response.json({ id: 456 });
  if (path === '/products/stock-price') return Response.json({ message: 'boom' }, { status: stockPriceStatus });
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

const link = { tn_location_id: 'L1', zoho_location_id: 'ZL1' };
const updateEntry = { zoho_item_id: 'zoho-1', action: 'update', tiendanube_product_id: 456 };
const stockPatches = () => calls().filter((c) => c.path === '/products/stock-price');

test('update con vínculo real: inventory_levels con location_id explícito por location vinculada', async () => {
  tnProducts();
  locs.tn = [{ id: 'L1' }, { id: 'L2' }];
  locs.mappings = [link, { tn_location_id: 'L2', zoho_location_id: 'ZL2' }];
  await run({ items: [updateEntry] });
  expect(stockPatches()[0].body).toEqual([{ id: 456, variants: [{
    id: 9, price: '200', inventory_levels: [{ location_id: 'L1', stock: 8 }, { location_id: 'L2', stock: 12 }],
  }] }]);
});

test('vínculo real y Zoho sin locations (item simple): no se envía stock (ni 0) pero sí el precio', async () => {
  tnProducts();
  zoho.child['/inventory/v1/items/zoho-1'] = () => Response.json({ item: { item_id: 'zoho-1', name: 'T', sku: 'TEST-1', rate: 200, stock_on_hand: 20 } });
  locs.tn = [{ id: 'L1' }];
  locs.mappings = [link];
  const result = await run({ items: [updateEntry] });
  expect(result.message).toContain('stock por almacén no disponible: el stock no se envió');
  expect(stockPatches()[0].body[0].variants[0]).toEqual({ id: 9, price: '200' });
});

test('vínculo real y locations vacío: no se envía inventory_levels', async () => {
  tnProducts();
  zoho.child['/inventory/v1/items/zoho-1'] = () => Response.json({ item: { item_id: 'zoho-1', name: 'T', sku: 'TEST-1', rate: 200, locations: [] } });
  locs.tn = [{ id: 'L1' }];
  locs.mappings = [link];
  await run({ items: [updateEntry] });
  expect(JSON.stringify(stockPatches())).not.toContain('inventory_levels');
});

test('grupo con vínculo real: un GET por hijo; el hijo con 429 no manda stock y no aborta el grupo', async () => {
  tnProducts();
  tnVariants = [{ id: 9, sku: 'c-1' }, { id: 10, sku: 'c-2' }];
  zoho.child['/inventory/v1/items/c1'] = () => Response.json({ item: { locations: [{ location_id: 'ZL1', location_stock_on_hand: 3 }] } });
  zoho.child['/inventory/v1/items/c2'] = () => Response.json({ message: 'rate' }, { status: 429 });
  locs.tn = [{ id: 'L1' }];
  locs.mappings = [link];
  const result = await run({ items: [{ ...updateEntry, zoho_item_id: 'group:g1' }] });
  expect(result.status).toBe('success');
  expect(zoho.childCalls).toEqual(['/inventory/v1/items/c1', '/inventory/v1/items/c2']);
  expect(stockPatches()[0].body[0].variants).toEqual([
    { id: 9, price: '10', inventory_levels: [{ location_id: 'L1', stock: 3 }] },
    { id: 10, price: '10' },
  ]);
  expect(JSON.stringify(stockPatches())).not.toContain('"stock":0');
});

test('grupo sin vínculo real: no se consulta el detalle de los hijos', async () => {
  tnProducts();
  tnVariants = [{ id: 9, sku: 'c-1' }, { id: 10, sku: 'c-2' }];
  locs.tn = [{ id: 'L1' }];
  await run({ items: [{ ...updateEntry, zoho_item_id: 'group:g1' }] });
  expect(zoho.childCalls).toEqual([]);
});

test('update: falla /locations pero las variantes de TN muestran 2 locations -> locations sin mapear, sin legado', async () => {
  tnProducts();
  locs.tn = null;
  tnVariants = [{ id: 9, sku: 'test-1', inventory_levels: [{ location_id: 'L1', stock: 1 }, { location_id: 'L2', stock: 2 }] }];
  const result = await run({ items: [updateEntry] });
  expect(result.message).toContain('locations sin mapear: el stock no se envió');
  expect(stockPatches()[0].body[0].variants[0]).toEqual({ id: 9, price: '200' });
});

test('PATCH con más de 50 variantes se reparte en varios requests', async () => {
  tnProducts();
  zoho.groupItems = Array.from({ length: 60 }, (_, i) => ({ item_id: `c${i}`, name: `C${i}`, sku: `S-${i}`, rate: 10, stock_on_hand: 1 }));
  tnVariants = zoho.groupItems.map((it, i) => ({ id: 1000 + i, sku: it.sku.toLowerCase() }));
  locs.tn = [{ id: 'L1' }];
  await run({ items: [{ ...updateEntry, zoho_item_id: 'group:g1' }] });
  const patches = stockPatches();
  expect(patches).toHaveLength(2);
  expect(patches.map((c) => c.body.reduce((n: number, p: any) => n + p.variants.length, 0))).toEqual([50, 10]);
});

test('dos ítems de Zoho sobre la misma variante de TN: un solo id por request (la última gana)', async () => {
  tnProducts();
  zoho.groupItems = [
    { item_id: 'c1', name: 'C1', sku: 'TEST-1', rate: 10, stock_on_hand: 1 },
    { item_id: 'c2', name: 'C2', sku: 'test-1', rate: 99, stock_on_hand: 2 },
  ];
  locs.tn = [{ id: 'L1' }];
  await run({ items: [{ ...updateEntry, zoho_item_id: 'group:g1' }] });
  expect(stockPatches()[0].body[0].variants).toEqual([{ id: 9, price: '99', inventory_levels: [{ stock: 2 }] }]);
});

test('SKU duplicado en TN: se actualiza una sola y se avisa una vez en sync_logs', async () => {
  tnProducts();
  tnVariants = [{ id: 9, sku: 'test-1' }, { id: 11, sku: 'TEST-1' }];
  locs.tn = [{ id: 'L1' }];
  await run({ items: [updateEntry] });
  expect(stockPatches()[0].body[0].variants.map((v: any) => v.id)).toEqual([11]);
  expect(logSync.mock.calls.filter(([, , f]: any) => String(f.message).startsWith('SKU duplicado'))).toHaveLength(1);
});

test('PATCH stock-price falla: el ítem es error con lo aplicado y las imágenes ya se subieron', async () => {
  tnProducts();
  stubImage();
  stockPriceStatus = 422;
  locs.tn = [{ id: 'L1' }];
  const result = await run({ items: [updateEntry], fields: { images: true } });
  expect(result.status).toBe('error');
  expect(result.message).toContain('nombre/descripción e imágenes actualizados; falló stock/precio: HTTP 422');
  const all = calls();
  expect(all.filter((c) => c.path === '/products/456/images')).toHaveLength(1);
  expect(all.findIndex((c) => c.path === '/products/456/images')).toBeLessThan(all.findIndex((c) => c.path === '/products/stock-price'));
});

const noStockItem = () => Response.json({ item: { item_id: 'zoho-1', name: 'Servicio', sku: 'TEST-1', rate: 200 } });

test('alta sin stock en Zoho (servicio): no envía inventory_levels, avisa y sí envía el precio', async () => {
  tnProducts();
  locs.tn = [{ id: 'L1' }];
  zoho.child['/inventory/v1/items/zoho-1'] = noStockItem;
  const result = await run({ items: [{ zoho_item_id: 'zoho-1', action: 'create' }] });
  expect(result.status).toBe('success');
  const variant = calls().find((c) => c.path === '/products')!.body.variants[0];
  expect(variant).not.toHaveProperty('inventory_levels');
  expect(variant.price).toBe('200');
  expect(result.message).toContain('stock no disponible: el stock no se envió');
});

test('update sin stock en Zoho: el PATCH lleva solo el precio, nunca stock 0', async () => {
  tnProducts();
  locs.tn = [{ id: 'L1' }];
  zoho.child['/inventory/v1/items/zoho-1'] = () => Response.json({ item: { item_id: 'zoho-1', name: 'S', sku: 'TEST-1', rate: 200, stock_on_hand: '' } });
  const result = await run({ items: [{ zoho_item_id: 'zoho-1', action: 'update', tiendanube_product_id: 456 }] });
  expect(calls().find((c) => c.path === '/products/stock-price')!.body[0].variants[0]).toEqual({ id: 9, price: '200' });
  expect(result.message).toContain('stock no disponible');
});

test('alta con /locations caído y sin mapeos: la caché revela 2 locations y no se envía stock sin location_id', async () => {
  tnProducts();
  locs.tn = null;
  cache.catalog = [
    { product_id: 1, variant_id: 1, sku: 'X', price: 1, promotional_price: null, inventory_levels: [{ location_id: 'L1', stock: 1 }] },
    { product_id: 2, variant_id: 2, sku: 'Y', price: 1, promotional_price: null, inventory_levels: [{ location_id: 'L2', stock: 1 }] },
  ];
  const result = await run({ items: [{ zoho_item_id: 'zoho-1', action: 'create' }] });
  expect(calls().find((c) => c.path === '/products')!.body.variants[0]).not.toHaveProperty('inventory_levels');
  expect(result.message).toContain('locations sin mapear: el stock no se envió');
  expect(cache.loads).toBe(1);
});

test('con /locations disponible no se lee la caché', async () => {
  tnProducts();
  locs.tn = [{ id: 'L1' }];
  await run({ items: [{ zoho_item_id: 'zoho-1', action: 'create' }] });
  expect(cache.loads).toBe(0);
});
