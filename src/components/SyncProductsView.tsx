import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Card,
  Text,
  Button,
  Input,
  Select,
  Checkbox,
  Tag,
  Spinner,
  Table,
  Pagination,
  Alert,
  Modal,
  IconButton,
  Tooltip,
  Sidebar,
  Title,
} from '@nimbus-ds/components';
import {
  SearchIcon,
  RedoIcon,
  ExternalLinkIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  DownloadIcon,
  CogIcon,
} from '@nimbus-ds/icons';
import { supabase } from '@/integrations/supabase/client';
import { useSyncSettings, type ProductSyncFields } from '@/hooks/useSyncSettings';
import { ProgressButton } from '@/components/ProgressButton';
import { FieldHelp } from '@/components/FieldHelp';
import { toast } from 'sonner';

interface ZohoVariant {
  item_id: string;
  name: string;
  sku: string | null;
  status: string;
  rate: number;
  stock_on_hand: number;
  attributes: Record<string, string>;
}

interface ZohoItem {
  row_id: string; // "group:{gid}" o "item:{id}"
  is_group: boolean;
  group_id: string | null;
  item_id: string;
  name: string;
  sku: string | null;
  status: string;
  rate: number;
  stock_on_hand: number;
  description: string;
  category_name: string | null;
  variants: ZohoVariant[];
  match_status: 'new' | 'linked' | 'imported' | 'conflict' | 'error' | 'ignored';
  tiendanube_product_id: number | null;
  last_synced_at: string | null;
  last_error: string | null;
}

interface ImportResult {
  zoho_item_id: string;
  status: 'success' | 'error' | 'skipped';
  message?: string;
  tiendanube_product_id?: number | null;
  action: string;
  variants_count?: number;
}

interface SyncProductsViewProps {
  storeId: string;
}

const PER_PAGE = 25;

const matchStatusTag: Record<
  string,
  { label: string; appearance: 'primary' | 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  new: { label: 'Nuevo', appearance: 'primary' },
  linked: { label: 'Vinculado', appearance: 'success' },
  imported: { label: 'Importado', appearance: 'success' },
  conflict: { label: 'Conflicto', appearance: 'warning' },
  error: { label: 'Error', appearance: 'danger' },
  ignored: { label: 'Ignorado', appearance: 'neutral' },
};

export function SyncProductsView({ storeId }: SyncProductsViewProps) {
  const { settings, save } = useSyncSettings(storeId);
  const [items, setItems] = useState<ZohoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [stockFilter, setStockFilter] = useState<string>('');
  const [matchFilter, setMatchFilter] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionData, setSelectionData] = useState<Map<string, ZohoItem>>(new Map());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [publishOnImport, setPublishOnImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [detail, setDetail] = useState<ZohoItem | null>(null);

  // Sync default publish con la configuración guardada
  useEffect(() => {
    if (settings) setPublishOnImport(settings.products_publish_on_import);
  }, [settings]);

  const load = async (overridePage?: number) => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: e } = await supabase.functions.invoke('zoho-list-items', {
        body: {
          store_id: storeId,
          page: overridePage ?? page,
          per_page: PER_PAGE,
          search: search || undefined,
          status: statusFilter || undefined,
          stock: stockFilter || undefined,
          match: matchFilter || undefined,
        },
      });
      if (e) throw e;
      if (data?.error) throw new Error(data.error);
      const newItems: ZohoItem[] = data.items || [];
      setItems(newItems);
      setHasMore(!!data.page_context?.has_more_page);
      // Actualizar cache con datos frescos de items ya seleccionados
      setSelectionData(prev => {
        const next = new Map(prev);
        newItems.forEach(item => {
          if (next.has(item.row_id)) next.set(item.row_id, item);
        });
        return next;
      });
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Error al cargar items de Zoho');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPage(1);
    // Limpiar selección al cambiar filtros/búsqueda
    setSelected(new Set());
    setSelectionData(new Map());
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, search, statusFilter, stockFilter, matchFilter]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const toggle = (id: string) => {
    const nextSelected = new Set(selected);
    const nextData = new Map(selectionData);
    if (nextSelected.has(id)) {
      nextSelected.delete(id);
      nextData.delete(id);
    } else {
      nextSelected.add(id);
      const item = items.find((i) => i.row_id === id);
      if (item) nextData.set(id, item);
    }
    setSelected(nextSelected);
    setSelectionData(nextData);
  };

  const toggleAll = () => {
    const allCurrentSelected = items.every((i) => selected.has(i.row_id));
    const nextSelected = new Set(selected);
    const nextData = new Map(selectionData);
    if (allCurrentSelected) {
      items.forEach((i) => { nextSelected.delete(i.row_id); nextData.delete(i.row_id); });
    } else {
      items.forEach((i) => { nextSelected.add(i.row_id); nextData.set(i.row_id, i); });
    }
    setSelected(nextSelected);
    setSelectionData(nextData);
  };

  // selectedItems incluye items de todas las páginas (usando el cache)
  const selectedItems = useMemo(
    () => Array.from(selectionData.values()),
    [selectionData],
  );

  const summary = useMemo(() => {
    const s = { create: 0, update: 0, link: 0, conflict: 0, variants: 0 };
    selectedItems.forEach((i) => {
      if (i.match_status === 'linked' || i.match_status === 'imported') s.update++;
      else if (i.match_status === 'conflict' && i.tiendanube_product_id) s.conflict++;
      else s.create++;
      s.variants += Math.max(1, i.variants?.length || 0);
    });
    return s;
  }, [selectedItems]);

  const runImport = async (retryItems?: ImportResult[]) => {
    setImporting(true);
    setConfirmOpen(false);
    try {
      const target = retryItems
        ? (retryItems
            .map((r) => items.find((i) => i.row_id === r.zoho_item_id))
            .filter(Boolean) as ZohoItem[])
        : selectedItems;

      // Modo shimmer indeterminado mientras la edge function procesa (total: 0)
      setImportProgress({ current: 0, total: 0 });

      const payload = target.map((it) => {
        let action: 'create' | 'update' | 'link';
        if (it.match_status === 'linked' || it.match_status === 'imported')
          action = 'update';
        else if (it.match_status === 'conflict' && it.tiendanube_product_id) action = 'link';
        else action = 'create';
        return {
          zoho_item_id: it.row_id,
          action,
          tiendanube_product_id: it.tiendanube_product_id,
        };
      });

      const { data, error: e } = await supabase.functions.invoke('zoho-sync-import', {
        body: {
          store_id: storeId,
          items: payload,
          publish: publishOnImport,
          fields: settings?.products_sync_fields,
          overwrite: settings?.products_overwrite_existing,
        },
      });
      if (e) throw e;
      if (data?.error) throw new Error(data.error);
      // Mostrar 100% brevemente al terminar
      setImportProgress({ current: target.length, total: target.length });
      setResults(data.results || []);
      const okCount = (data.results || []).filter((r: ImportResult) => r.status === 'success').length;
      const errCount = (data.results || []).filter((r: ImportResult) => r.status === 'error').length;
      if (errCount === 0) toast.success(`${okCount} producto(s) sincronizado(s)`);
      else toast.warning(`${okCount} correctos · ${errCount} con error`);
      setSelected(new Set());
      setSelectionData(new Map());
      load();
    } catch (err: any) {
      toast.error(err.message || 'Error en la importación');
    } finally {
      setImporting(false);
      setTimeout(() => setImportProgress(null), 800);
    }
  };

  const FIELD_LABELS: Record<keyof ProductSyncFields, string> = {
    name: 'Nombre',
    sku: 'SKU',
    description: 'Descripción',
    price: 'Precio',
    stock: 'Stock inicial',
    images: 'Imágenes',
    category: 'Categoría',
    weight: 'Peso',
    dimensions: 'Dimensiones',
    barcode: 'Código de barras',
    brand: 'Marca',
    tax: 'Impuestos',
  };

  const FIELD_HELP: Record<keyof ProductSyncFields, string> = {
    name: 'Nombre comercial del producto que se mostrará en Tiendanube. Si lo desactiva, se conservará el nombre actual en Tiendanube al re-sincronizar.',
    sku: 'Código único de identificación del producto. Es la clave principal para vincular productos entre Zoho y Tiendanube. Se recomienda mantenerlo activo.',
    description: 'Descripción larga del producto (acepta HTML). Útil si redacta las descripciones en Zoho. Desactívelo si prefiere editarlas directamente en Tiendanube.',
    price: 'Precio de venta del producto. Si lo activa, los cambios de precio en Zoho se reflejarán en Tiendanube. Cuidado: puede sobrescribir promociones definidas en Tiendanube.',
    stock: 'Cantidad inicial de unidades disponibles al crear el producto. Para mantener el inventario sincronizado en el tiempo, use además el módulo de Stock.',
    images: 'Galería de imágenes del producto. Se descargarán desde Zoho y se subirán a Tiendanube. Aumenta significativamente el tiempo de importación.',
    category: 'Categoría asignada al producto. Si la categoría no existe en Tiendanube, se creará automáticamente.',
    weight: 'Peso del producto en gramos. Se utiliza para calcular costos de envío en Tiendanube.',
    dimensions: 'Alto, ancho y profundidad del producto. Se utilizan para calcular costos de envío con transportistas.',
    barcode: 'Código de barras (EAN, UPC, etc.) que identifica el producto físicamente. Útil para integraciones con lectores y depósitos.',
    brand: 'Marca o fabricante del producto. Aparece como filtro en la tienda online y ayuda al SEO.',
    tax: 'Configuración de impuestos del producto (IVA, etc.). Si está activo, se intentará mapear el impuesto de Zoho al equivalente en Tiendanube.',
  };

  const toggleField = (key: keyof ProductSyncFields, value: boolean) => {
    if (!settings) return;
    save({ products_sync_fields: { ...settings.products_sync_fields, [key]: value } });
  };

  return (
    <Box display="flex" flexDirection="column" gap="4">
      {/* Configuración del módulo */}
      <Card>
        <Card.Header>
          <Box display="flex" alignItems="center" gap="2">
            <CogIcon />
            <Title as="h4" fontSize="h5">Configuración de productos</Title>
          </Box>
        </Card.Header>
        <Card.Body>
          {!settings ? (
            <Spinner />
          ) : (
            <Box display="flex" flexDirection="column" gap="4">
              <Box display="flex" flexDirection="column" gap="2">
                <Box display="flex" alignItems="center" gap="2">
                  <Checkbox
                    name="products_publish_on_import"
                    label="Publicar productos al importar (por defecto se crean como borrador)"
                    checked={settings.products_publish_on_import}
                    onChange={(e) => save({ products_publish_on_import: e.target.checked })}
                  />
                  <FieldHelp help="Si está activo, los productos importados desde Zoho se crearán visibles y a la venta en Tiendanube. Si lo deja desactivado, se crearán como borrador para que pueda revisarlos (precios, fotos, descripciones) antes de publicarlos manualmente." />
                </Box>
                <Box display="flex" alignItems="center" gap="2">
                  <Checkbox
                    name="products_overwrite_existing"
                    label="Sobrescribir datos en productos ya vinculados al re-sincronizar"
                    checked={settings.products_overwrite_existing}
                    onChange={(e) => save({ products_overwrite_existing: e.target.checked })}
                  />
                  <FieldHelp help="Cuando re-sincroniza un producto que ya está vinculado, esta opción decide si los datos de Zoho reemplazan a los de Tiendanube. Actívelo si Zoho es su fuente de verdad. Desactívelo para preservar las ediciones manuales hechas en Tiendanube (descripciones personalizadas, fotos retocadas, etc.)." />
                </Box>
              </Box>

              <Box display="flex" flexDirection="column" gap="1">
                <Box display="flex" alignItems="center" gap="2">
                  <Text fontWeight="medium">Estrategia de coincidencia</Text>
                  <FieldHelp help="Define cómo el sistema detecta si un producto de Zoho ya existe en Tiendanube para vincularlos automáticamente. 'Por SKU' es el más confiable porque el SKU es único. 'Por nombre' puede ser útil si no usa SKU, pero puede generar falsos positivos con productos de nombre similar." />
                </Box>
                <Text fontSize="caption" color="neutral-textLow">
                  Cómo se detecta si un producto de Zoho ya existe en Tiendanube.
                </Text>
                <Select
                  id="products_match_strategy"
                  name="products_match_strategy"
                  value={settings.products_match_strategy}
                  onChange={(e) => save({ products_match_strategy: e.target.value as any })}
                >
                  <Select.Option value="sku" label="Por SKU (recomendado)" />
                  <Select.Option value="name" label="Por nombre del producto" />
                </Select>
              </Box>

              <Box display="flex" flexDirection="column" gap="2">
                <Box display="flex" alignItems="center" gap="2">
                  <Text fontWeight="medium">Campos a sincronizar desde Zoho</Text>
                  <FieldHelp help="Marque solo los campos que quiere traer o actualizar desde Zoho. Los campos no marcados serán ignorados durante la sincronización, preservando los valores existentes en Tiendanube. Útil cuando, por ejemplo, gestiona los precios en Zoho pero las imágenes y descripciones se editan en Tiendanube." />
                </Box>
                <Text fontSize="caption" color="neutral-textLow">
                  Selecciona qué información de cada producto debe traerse o actualizarse.
                </Text>
                <Box display="grid" gap="2" gridTemplateColumns={{ xs: '1fr', md: '1fr 1fr', lg: 'repeat(3, 1fr)' }}>
                  {(Object.keys(FIELD_LABELS) as Array<keyof ProductSyncFields>).map((key) => (
                    <Box key={key} display="flex" alignItems="center" gap="1">
                      <Checkbox
                        name={`field_${key}`}
                        label={FIELD_LABELS[key]}
                        checked={!!settings.products_sync_fields?.[key]}
                        onChange={(e) => toggleField(key, e.target.checked)}
                      />
                      <FieldHelp help={FIELD_HELP[key]} />
                    </Box>
                  ))}
                </Box>
              </Box>
            </Box>
          )}
        </Card.Body>
      </Card>

      {/* Filtros */}
      <Card>
        <Card.Body>
          <Box
            display="flex"
            flexDirection={{ xs: 'column', md: 'row' }}
            gap="3"
            flexWrap="wrap"
            alignItems="flex-end"
          >
            <Box flex="1" minWidth="220px" display="flex" flexDirection="column" gap="1">
              <Text fontSize="caption" color="neutral-textLow">
                Buscar
              </Text>
              <Input
                placeholder="Nombre o SKU..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setSearch(searchInput);
                }}
                append={<SearchIcon />}
              />
            </Box>

            <Box display="flex" flexDirection="column" gap="1" minWidth="160px">
              <Text fontSize="caption" color="neutral-textLow">
                Estado en Zoho
              </Text>
              <Select
                id="zoho-status"
                name="zoho-status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <Select.Option label="Todos" value="" />
                <Select.Option label="Activos" value="active" />
                <Select.Option label="Inactivos" value="inactive" />
              </Select>
            </Box>

            <Box display="flex" flexDirection="column" gap="1" minWidth="160px">
              <Text fontSize="caption" color="neutral-textLow">
                Stock
              </Text>
              <Select
                id="stock-filter"
                name="stock-filter"
                value={stockFilter}
                onChange={(e) => setStockFilter(e.target.value)}
              >
                <Select.Option label="Todos" value="" />
                <Select.Option label="Con stock" value="in" />
                <Select.Option label="Sin stock" value="out" />
              </Select>
            </Box>

            <Box display="flex" flexDirection="column" gap="1" minWidth="180px">
              <Text fontSize="caption" color="neutral-textLow">
                Estado de sync
              </Text>
              <Select
                id="match-filter"
                name="match-filter"
                value={matchFilter}
                onChange={(e) => setMatchFilter(e.target.value)}
              >
                <Select.Option label="Todos" value="" />
                <Select.Option label="Nuevos" value="new" />
                <Select.Option label="Vinculados" value="linked" />
                <Select.Option label="Importados" value="imported" />
                <Select.Option label="Conflictos" value="conflict" />
                <Select.Option label="Con errores" value="error" />
              </Select>
            </Box>

            <Button appearance="neutral" onClick={() => setSearch(searchInput)}>
              Aplicar
            </Button>
            <Button
              appearance="transparent"
              onClick={() => {
                setSearchInput('');
                setSearch('');
                setStatusFilter('');
                setStockFilter('');
                setMatchFilter('');
              }}
            >
              Limpiar
            </Button>
          </Box>
        </Card.Body>
      </Card>

      {/* Acciones bulk */}
      {selected.size > 0 && (
        <Alert appearance="primary" title={`${selected.size} item(s) seleccionado(s)`}>
          <Box display="flex" gap="2" alignItems="center" flexWrap="wrap">
            <ProgressButton
              appearance="primary"
              onClick={() => setConfirmOpen(true)}
              loading={importing}
              progress={importProgress}
              icon={<DownloadIcon />}
              loadingLabel="Sincronizando"
            >
              Sincronizar seleccionados
            </ProgressButton>
            <Button appearance="transparent" onClick={() => setSelected(new Set())}>
              Cancelar
            </Button>
          </Box>
        </Alert>
      )}

      {error && (
        <Alert appearance="danger" title="Error">
          {error}
        </Alert>
      )}

      {/* Tabla */}
      <Card padding="none">
        {loading ? (
          <Box padding="8" display="flex" justifyContent="center">
            <Spinner size="large" />
          </Box>
        ) : items.length === 0 ? (
          <Box
            padding="8"
            display="flex"
            flexDirection="column"
            alignItems="center"
            gap="2"
          >
            <SearchIcon size="large" />
            <Text fontWeight="medium">Sin items</Text>
            <Text fontSize="caption" color="neutral-textLow">
              No hay productos en Zoho con estos filtros.
            </Text>
          </Box>
        ) : (
          <Box overflow="auto">
            <Table>
              <Table.Head>
                <Table.Row>
                  <Table.Cell as="th" width="40px">
                    <Checkbox
                      name="all"
                      checked={selected.size === items.length && items.length > 0}
                      onChange={toggleAll}
                    />
                  </Table.Cell>
                  <Table.Cell as="th">Producto</Table.Cell>
                  <Table.Cell as="th">SKU</Table.Cell>
                  <Table.Cell as="th">Variantes</Table.Cell>
                  <Table.Cell as="th">Precio</Table.Cell>
                  <Table.Cell as="th">Stock</Table.Cell>
                  <Table.Cell as="th">Estado</Table.Cell>
                  <Table.Cell as="th">Último sync</Table.Cell>
                  <Table.Cell as="th" width="80px">
                    Detalle
                  </Table.Cell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {items.map((it) => {
                  const tag = matchStatusTag[it.match_status] || matchStatusTag.new;
                  const variantCount = it.is_group ? it.variants.length : 1;
                  return (
                    <Table.Row key={it.row_id}>
                      <Table.Cell>
                        <Checkbox
                          name={it.row_id}
                          checked={selected.has(it.row_id)}
                          onChange={() => toggle(it.row_id)}
                        />
                      </Table.Cell>
                      <Table.Cell>
                        <Box display="flex" flexDirection="column" gap="1">
                          <Text fontWeight="medium" color="neutral-textHigh">
                            {it.name}
                          </Text>
                          {it.category_name && (
                            <Text fontSize="caption" color="neutral-textLow">
                              {it.category_name}
                            </Text>
                          )}
                        </Box>
                      </Table.Cell>
                      <Table.Cell>
                        <Text fontSize="caption">
                          {it.is_group ? `${variantCount} SKUs` : (it.sku || '—')}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        {it.is_group ? (
                          <Tag appearance="primary">{variantCount} variantes</Tag>
                        ) : (
                          <Text fontSize="caption" color="neutral-textLow">Simple</Text>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Text>${Number(it.rate ?? 0).toLocaleString('es-AR')}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Text color={it.stock_on_hand > 0 ? 'success-textLow' : 'danger-textLow'}>
                          {it.stock_on_hand}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Box display="inline-flex" alignItems="center" gap="1">
                          <Tag appearance={tag.appearance}>{tag.label}</Tag>
                          {it.last_error && (
                            <Tooltip content={it.last_error}>
                              <ExclamationTriangleIcon />
                            </Tooltip>
                          )}
                        </Box>
                      </Table.Cell>
                      <Table.Cell>
                        <Text fontSize="caption" color="neutral-textLow">
                          {it.last_synced_at
                            ? new Date(it.last_synced_at).toLocaleString('es-AR')
                            : '—'}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <IconButton
                          source={<ExternalLinkIcon />}
                          size="2rem"
                          onClick={() => setDetail(it)}
                        />
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </Box>
        )}

        <Box padding="4" display="flex" justifyContent="space-between" alignItems="center">
          <Text fontSize="caption" color="neutral-textLow">
            Página {page}
          </Text>
          <Pagination
            pageCount={hasMore ? page + 1 : page}
            activePage={page}
            onPageChange={(p) => setPage(p)}
          />
        </Box>
      </Card>

      {/* Modal de confirmación */}
      <Modal open={confirmOpen} onDismiss={() => setConfirmOpen(false)}>
        <Modal.Header title="Confirmar sincronización" />
        <Modal.Body padding="base">
          <Box display="flex" flexDirection="column" gap="3">
            <Text>
              Se van a sincronizar <strong>{selectedItems.length}</strong> producto(s) de Zoho a
              Tiendanube (<strong>{summary.variants}</strong> variante/s en total):
            </Text>
            <Box
              display="flex"
              flexDirection="column"
              gap="1"
              backgroundColor="neutral-surface"
              padding="3"
              borderRadius="2"
            >
              <Text fontSize="caption">
                • <strong>{summary.create}</strong> nuevo(s) → se crean en Tiendanube
              </Text>
              <Text fontSize="caption">
                • <strong>{summary.update}</strong> ya vinculado(s) → se actualizan
              </Text>
              <Text fontSize="caption">
                • <strong>{summary.conflict}</strong> conflicto(s) por nombre → se vinculan
              </Text>
            </Box>
            <Checkbox
              name="publish"
              label="Publicar productos al importar (por defecto se crean como borrador)"
              checked={publishOnImport}
              onChange={(e: any) => setPublishOnImport(!!e.target.checked)}
            />
          </Box>
        </Modal.Body>
        <Modal.Footer>
          <Button appearance="transparent" onClick={() => setConfirmOpen(false)}>
            Cancelar
          </Button>
          <ProgressButton
            appearance="primary"
            onClick={() => runImport()}
            loading={importing}
            progress={importProgress}
            loadingLabel="Sincronizando"
          >
            Confirmar y sincronizar
          </ProgressButton>
        </Modal.Footer>
      </Modal>

      {/* Modal de resultados */}
      <Modal open={!!results} onDismiss={() => setResults(null)} maxWidth="700px">
        <Modal.Header title="Resultado de la sincronización" />
        <Modal.Body padding="base">
          <Box
            display="flex"
            flexDirection="column"
            gap="2"
            maxHeight="400px"
            overflow="auto"
          >
            {(results || []).map((r) => {
              const it = items.find((i) => i.row_id === r.zoho_item_id);
              return (
                <Box
                  key={r.zoho_item_id}
                  display="flex"
                  alignItems="center"
                  justifyContent="space-between"
                  padding="2"
                  backgroundColor="neutral-surface"
                  borderRadius="2"
                  gap="2"
                >
                  <Box display="flex" alignItems="center" gap="2" flex="1">
                    {r.status === 'success' ? (
                      <CheckCircleIcon color="success-interactive" />
                    ) : (
                      <ExclamationTriangleIcon color="danger-interactive" />
                    )}
                    <Box display="flex" flexDirection="column">
                      <Text fontSize="caption" fontWeight="medium">
                        {it?.name || r.zoho_item_id}
                        {r.variants_count && r.variants_count > 1
                          ? ` · ${r.variants_count} variantes`
                          : ''}
                      </Text>
                      {r.message && (
                        <Text fontSize="caption" color="danger-textLow">
                          {r.message}
                        </Text>
                      )}
                    </Box>
                  </Box>
                  <Tag appearance={r.status === 'success' ? 'success' : 'danger'}>
                    {r.action}
                  </Tag>
                </Box>
              );
            })}
          </Box>
        </Modal.Body>
        <Modal.Footer>
          {(results || []).some((r) => r.status === 'error') && (
            <Button
              appearance="neutral"
              onClick={() =>
                runImport((results || []).filter((r) => r.status === 'error'))
              }
            >
              <RedoIcon /> Reintentar errores
            </Button>
          )}
          <Button appearance="primary" onClick={() => setResults(null)}>
            Cerrar
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Sidebar de detalle */}
      <Sidebar open={!!detail} onRemove={() => setDetail(null)} position="right">
        <Sidebar.Header title={detail?.name || ''} />
        <Sidebar.Body>
          {detail && (
            <Box display="flex" flexDirection="column" gap="3">
              <DetailRow
                label="Tipo"
                value={detail.is_group ? `Grupo · ${detail.variants.length} variantes` : 'Producto simple'}
              />
              <DetailRow label="ID Zoho" value={detail.is_group ? `group:${detail.group_id}` : detail.item_id} />
              <DetailRow label="SKU(s)" value={detail.sku || '—'} />
              <DetailRow
                label="Precio (desde)"
                value={`$${Number(detail.rate).toLocaleString('es')}`}
              />
              <DetailRow label="Stock total" value={String(detail.stock_on_hand)} />
              <DetailRow label="Estado en Zoho" value={detail.status} />
              <DetailRow label="Categoría" value={detail.category_name || '—'} />
              <DetailRow
                label="Producto en Tiendanube"
                value={
                  detail.tiendanube_product_id
                    ? `#${detail.tiendanube_product_id}`
                    : 'No vinculado'
                }
              />

              {detail.is_group && detail.variants.length > 0 && (
                <Box display="flex" flexDirection="column" gap="2">
                  <Text fontWeight="medium">Variantes</Text>
                  <Box display="flex" flexDirection="column" gap="1">
                    {detail.variants.map((v) => (
                      <Box
                        key={v.item_id}
                        display="flex"
                        justifyContent="space-between"
                        gap="2"
                        padding="2"
                        backgroundColor="neutral-surface"
                        borderRadius="2"
                      >
                        <Box display="flex" flexDirection="column" gap="1" flex="1">
                          <Text fontSize="caption" fontWeight="medium">
                            {Object.entries(v.attributes)
                              .map(([k, val]) => `${k}: ${val}`)
                              .join(' · ') || v.name}
                          </Text>
                          <Text fontSize="caption" color="neutral-textLow">
                            SKU: {v.sku || '—'}
                          </Text>
                        </Box>
                        <Box display="flex" flexDirection="column" alignItems="flex-end" gap="1">
                          <Text fontSize="caption">${Number(v.rate).toLocaleString('es-AR')}</Text>
                          <Text
                            fontSize="caption"
                            color={v.stock_on_hand > 0 ? 'success-textLow' : 'danger-textLow'}
                          >
                            Stock: {v.stock_on_hand}
                          </Text>
                        </Box>
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}

              {detail.description && (
                <Box display="flex" flexDirection="column" gap="1">
                  <Text fontSize="caption" color="neutral-textLow">
                    Descripción
                  </Text>
                  <Text fontSize="caption">{detail.description}</Text>
                </Box>
              )}
              {detail.last_error && (
                <Alert appearance="danger" title="Último error">
                  {detail.last_error}
                </Alert>
              )}
            </Box>
          )}
        </Sidebar.Body>
      </Sidebar>
    </Box>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Box display="flex" justifyContent="space-between" gap="2">
      <Text fontSize="caption" color="neutral-textLow">
        {label}
      </Text>
      <Text fontSize="caption" fontWeight="medium">
        {value}
      </Text>
    </Box>
  );
}
