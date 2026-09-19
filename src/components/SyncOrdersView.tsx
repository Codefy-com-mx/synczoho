import { useEffect, useState } from 'react';
import {
  Box, Card, Title, Text, Button, Checkbox, Tag, Spinner, Table, Alert, Pagination,
} from '@nimbus-ds/components';
import { RedoIcon, CogIcon, CashIcon, ChatDotsIcon } from '@nimbus-ds/icons';
import { api } from '@/lib/api';
import { useSyncSettings } from '@/hooks/useSyncSettings';
import { FieldHelp } from '@/components/FieldHelp';
import { toast } from 'sonner';

interface Props { storeId: string }

interface OrderRow {
  id: number;
  number: number;
  contact_name: string | null;
  contact_email: string | null;
  status: string;
  payment_status: string;
  total: string;
  currency: string;
  created_at: string;
  sync_status: 'not_synced' | 'pending' | 'success' | 'error';
  zoho_salesorder_id: string | null;
  zoho_invoice_id: string | null;
  last_error: string | null;
  last_synced_at: string | null;
}

const PER_PAGE = 25;
type TabKey = 'config' | 'orders' | 'webhooks';

export function SyncOrdersView({ storeId }: Props) {
  const { settings, saving, save } = useSyncSettings(storeId);
  const [tab, setTab] = useState<TabKey>('config');
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [bulkSyncing, setBulkSyncing] = useState(false);
  const [webhooksStatus, setWebhooksStatus] = useState<{
    all_active: boolean; missing: string[]; registered: any[]; webhook_url: string;
  } | null>(null);
  const [webhooksLoading, setWebhooksLoading] = useState(false);
  const [registeringWebhooks, setRegisteringWebhooks] = useState(false);

  const bulkSyncPending = async () => {
    setBulkSyncing(true);
    try {
      const { data, error } = await api.functions.invoke('sync-orders-bulk', {
        body: { storeId, pages: 2, perPage: 50, onlyMissing: true },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const { success = 0, skipped = 0, errors = 0, attempted = 0 } = data || {};
      if (attempted === 0) toast.success('Todas las órdenes recientes ya estaban sincronizadas');
      else if (errors === 0) toast.success(`${success} órdenes sincronizadas (${skipped} omitidas)`);
      else toast.warning(`${success} OK · ${errors} con error · ${skipped} omitidas`);
      loadOrders(page);
    } catch (e: any) {
      toast.error(e?.message || 'Error al sincronizar órdenes pendientes');
    } finally {
      setBulkSyncing(false);
    }
  };

  const loadWebhooksStatus = async () => {
    setWebhooksLoading(true);
    try {
      const { data, error } = await api.functions.invoke('tiendanube-webhooks-manage', {
        body: { storeId, action: 'list' },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setWebhooksStatus(data);
    } catch (e: any) {
      toast.error(e?.message || 'No se pudo verificar el estado de los webhooks');
    } finally {
      setWebhooksLoading(false);
    }
  };

  const registerWebhooks = async () => {
    setRegisteringWebhooks(true);
    try {
      const { data, error } = await api.functions.invoke('tiendanube-webhooks-manage', {
        body: { storeId, action: 'register' },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const created = data.created?.length || 0;
      const errors = data.errors?.length || 0;
      if (errors === 0) toast.success(`Webhooks activados (${created} registrados)`);
      else toast.warning(`${created} registrados · ${errors} con error`);
      await loadWebhooksStatus();
    } catch (e: any) {
      toast.error(e?.message || 'Error al registrar webhooks');
    } finally {
      setRegisteringWebhooks(false);
    }
  };

  const loadOrders = async (p = page) => {
    setLoading(true);
    try {
      const { data, error } = await api.functions.invoke('sync-orders-list', {
        body: { storeId, page: p, perPage: PER_PAGE },
      });
      if (error) throw error;
      setOrders(data.orders || []);
    } catch (e: any) {
      toast.error(e?.message || 'Error al cargar las órdenes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWebhooksStatus();
    // eslint-disable-next-line
  }, [storeId]);

  useEffect(() => {
    if (tab === 'orders' && orders.length === 0) loadOrders(1);
    // eslint-disable-next-line
  }, [tab]);

  const retryOrder = async (orderId: number) => {
    setRetryingId(orderId);
    try {
      const { data, error } = await api.functions.invoke('zoho-create-salesorder', {
        body: { storeId, orderId, event: 'manual' },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success(`Orden #${orderId} sincronizada`);
      loadOrders(page);
    } catch (e: any) {
      toast.error(e?.message || 'Error al reintentar la sincronización');
    } finally {
      setRetryingId(null);
    }
  };

  const syncStatusTag = (s: OrderRow['sync_status']) => {
    if (s === 'success') return <Tag appearance="success">Sincronizada</Tag>;
    if (s === 'error') return <Tag appearance="danger">Error</Tag>;
    if (s === 'pending') return <Tag appearance="warning">Pendiente</Tag>;
    return <Tag appearance="neutral">Sin sincronizar</Tag>;
  };

  const TabBtn = ({ k, icon, label, badge }: { k: TabKey; icon: React.ReactNode; label: string; badge?: React.ReactNode }) => (
    <button
      onClick={() => setTab(k)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
        background: tab === k ? 'hsl(var(--primary) / 0.1)' : 'transparent',
        color: tab === k ? 'hsl(var(--primary))' : 'hsl(var(--foreground))',
        border: 'none', borderBottom: tab === k ? '2px solid hsl(var(--primary))' : '2px solid transparent',
        cursor: 'pointer', fontWeight: 500, fontSize: 14,
      }}
    >
      {icon}
      <span>{label}</span>
      {badge}
    </button>
  );

  return (
    <Box display="flex" flexDirection="column" gap="4">
      <Box
        display="flex"
        gap="1"
        borderBottomWidth="1"
        borderStyle="solid"
        borderColor="neutral-surfaceHighlight"
      >
        <TabBtn k="config" icon={<CogIcon />} label="Configuración" />
        <TabBtn k="orders" icon={<CashIcon />} label="Órdenes recientes" />
        <TabBtn
          k="webhooks"
          icon={<ChatDotsIcon />}
          label="Webhooks"
          badge={
            webhooksStatus
              ? <Tag appearance={webhooksStatus.all_active ? 'success' : 'danger'}>
                  {webhooksStatus.all_active ? 'OK' : `${webhooksStatus.missing.length}`}
                </Tag>
              : null
          }
        />
      </Box>

      {tab === 'config' && (
        <Card>
          <Card.Header>
            <Title as="h4" fontSize="h5">Configuración de órdenes</Title>
          </Card.Header>
          <Card.Body>
            {!settings ? <Spinner /> : (
              <Box display="flex" flexDirection="column" gap="3">
                <Box display="flex" alignItems="center" gap="2">
                  <Checkbox
                    name="orders_enabled"
                    label="Activar sincronización automática de órdenes (vía webhook)"
                    checked={settings.orders_enabled}
                    onChange={(e) => save({ orders_enabled: e.target.checked })}
                  />
                  <FieldHelp help="Cuando está activo, cada nueva orden creada en Tiendanube se enviará automáticamente a Zoho Inventory en tiempo real. Requiere que los webhooks de Tiendanube estén registrados (pestaña Webhooks). Si lo desactiva, deberá sincronizar las órdenes manualmente desde la pestaña 'Órdenes recientes'." />
                </Box>
                <Box display="flex" alignItems="center" gap="2">
                  <Checkbox
                    name="orders_only_paid"
                    label="Sincronizar solo órdenes con pago confirmado (estado: pagada)"
                    checked={settings.orders_only_paid}
                    onChange={(e) => save({ orders_only_paid: e.target.checked })}
                  />
                  <FieldHelp help="Si está activo, únicamente las órdenes cuyo estado de pago sea 'pagada' se enviarán a Zoho. Las órdenes pendientes, abandonadas o canceladas serán ignoradas. Recomendado para evitar generar documentos en Zoho por ventas que aún no se concretaron." />
                </Box>
                <Box display="flex" alignItems="center" gap="2">
                  <Checkbox
                    name="orders_create_as_draft"
                    label="Crear órdenes en Zoho como borrador (Draft)"
                    checked={settings.orders_create_as_draft}
                    onChange={(e) => save({
                      orders_create_as_draft: e.target.checked,
                      orders_auto_confirm: e.target.checked ? false : settings.orders_auto_confirm,
                    })}
                  />
                  <FieldHelp help="Las órdenes se crearán en estado 'Borrador' en Zoho. Esto permite revisarlas antes de confirmarlas y descontar stock. Útil si necesita validar manualmente cada venta. Es excluyente con la opción de confirmación automática." />
                </Box>
                <Box display="flex" alignItems="center" gap="2">
                  <Checkbox
                    name="orders_auto_confirm"
                    label="Confirmar la orden de venta automáticamente al crearse"
                    checked={settings.orders_auto_confirm}
                    onChange={(e) => save({
                      orders_auto_confirm: e.target.checked,
                      orders_create_as_draft: e.target.checked ? false : settings.orders_create_as_draft,
                    })}
                  />
                  <FieldHelp help="Las órdenes se crearán y confirmarán inmediatamente en Zoho, descontando el stock y dejándolas listas para facturar. Recomendado si confía plenamente en los datos provenientes de Tiendanube. Es excluyente con la opción de borrador." />
                </Box>
                <Box display="flex" alignItems="center" gap="2">
                  <Checkbox
                    name="orders_generate_invoice_on_paid"
                    label="Generar factura automáticamente cuando la orden esté pagada"
                    checked={settings.orders_generate_invoice_on_paid}
                    onChange={(e) => save({ orders_generate_invoice_on_paid: e.target.checked })}
                  />
                  <FieldHelp help="Al recibir la confirmación de pago de Tiendanube, el sistema generará automáticamente la factura asociada a la orden de venta en Zoho Inventory. Esto agiliza la facturación, pero puede no convenir si emite facturas desde otro sistema." />
                </Box>
                <Box display="flex" alignItems="center" gap="2">
                  <Checkbox
                    name="customers_auto_sync_on_order"
                    label="Crear o vincular el cliente en Zoho al recibir la orden"
                    checked={settings.customers_auto_sync_on_order}
                    onChange={(e) => save({ customers_auto_sync_on_order: e.target.checked })}
                  />
                  <FieldHelp help="Antes de crear la orden de venta, el sistema buscará el cliente en Zoho por correo electrónico. Si no existe, lo creará automáticamente con los datos de facturación de la orden. Si lo desactiva, deberá tener todos los clientes ya cargados en Zoho previamente." />
                </Box>
                {saving && <Text fontSize="caption" color="neutral-textLow">Guardando…</Text>}
              </Box>
            )}
          </Card.Body>
        </Card>
      )}

      {tab === 'orders' && (
        <Card>
          <Card.Header>
            <Box display="flex" justifyContent="space-between" alignItems="center" width="100%">
              <Title as="h4" fontSize="h5">Órdenes recientes</Title>
              <Box display="flex" gap="2">
                <Button appearance="primary" onClick={bulkSyncPending} disabled={bulkSyncing}>
                  {bulkSyncing ? <Spinner size="small" /> : <RedoIcon />}
                  Sincronizar pendientes
                </Button>
                <Button appearance="neutral" onClick={() => loadOrders(page)}>
                  <RedoIcon /> Actualizar
                </Button>
              </Box>
            </Box>
          </Card.Header>
          <Card.Body>
            {loading ? (
              <Box display="flex" justifyContent="center" padding="6"><Spinner /></Box>
            ) : orders.length === 0 ? (
              <Alert appearance="neutral">No hay órdenes para mostrar.</Alert>
            ) : (
              <Box display="flex" flexDirection="column" gap="3">
                <Table>
                  <Table.Head>
                    <Table.Row>
                      <Table.Cell as="th">#</Table.Cell>
                      <Table.Cell as="th">Cliente</Table.Cell>
                      <Table.Cell as="th">Estado de pago</Table.Cell>
                      <Table.Cell as="th">Total</Table.Cell>
                      <Table.Cell as="th">Sincronización Zoho</Table.Cell>
                      <Table.Cell as="th">Acción</Table.Cell>
                    </Table.Row>
                  </Table.Head>
                  <Table.Body>
                    {orders.map((o) => (
                      <Table.Row key={o.id}>
                        <Table.Cell>#{o.number}</Table.Cell>
                        <Table.Cell>
                          <Text>{o.contact_name || '—'}</Text>
                          <Text fontSize="caption" color="neutral-textLow">{o.contact_email}</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Tag appearance={o.payment_status === 'paid' ? 'success' : 'warning'}>
                            {o.payment_status}
                          </Tag>
                        </Table.Cell>
                        <Table.Cell>{o.currency} {o.total}</Table.Cell>
                        <Table.Cell>
                          {syncStatusTag(o.sync_status)}
                          {o.last_error && (
                            <Text fontSize="caption" color="danger-textLow">{o.last_error.slice(0, 80)}</Text>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          <Button
                            appearance="neutral"
                            onClick={() => retryOrder(o.id)}
                            disabled={retryingId === o.id}
                          >
                            {retryingId === o.id ? <Spinner size="small" /> : <RedoIcon />}
                            {o.sync_status === 'success' ? 'Re-sincronizar' : 'Sincronizar'}
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
                <Box display="flex" justifyContent="center">
                  <Pagination
                    pageCount={page + 1}
                    activePage={page}
                    onPageChange={(p) => { setPage(p); loadOrders(p); }}
                  />
                </Box>
              </Box>
            )}
          </Card.Body>
        </Card>
      )}

      {tab === 'webhooks' && (
        <Card>
          <Card.Header>
            <Box display="flex" justifyContent="space-between" alignItems="center" width="100%">
              <Title as="h4" fontSize="h5">Webhooks de Tiendanube</Title>
              <Box display="flex" gap="2">
                <Button appearance="neutral" onClick={loadWebhooksStatus} disabled={webhooksLoading}>
                  {webhooksLoading ? <Spinner size="small" /> : <RedoIcon />}
                  Verificar estado
                </Button>
                {webhooksStatus && !webhooksStatus.all_active && (
                  <Button appearance="primary" onClick={registerWebhooks} disabled={registeringWebhooks}>
                    {registeringWebhooks ? <Spinner size="small" /> : null}
                    Activar webhooks
                  </Button>
                )}
              </Box>
            </Box>
          </Card.Header>
          <Card.Body>
            {!webhooksStatus ? <Spinner /> : webhooksStatus.all_active ? (
              <Alert appearance="success" title="Webhooks activos">
                <Text>
                  Todos los eventos requeridos están registrados. Las nuevas órdenes se sincronizarán automáticamente con Zoho Inventory.
                </Text>
                <Box marginTop="2" display="flex" gap="1" flexWrap="wrap">
                  {webhooksStatus.registered.map((w: any) => (
                    <Tag key={w.id} appearance="success">{w.event}</Tag>
                  ))}
                </Box>
              </Alert>
            ) : (
              <Alert appearance="warning" title="Faltan webhooks por registrar">
                <Text>
                  Las órdenes nuevas no se están sincronizando automáticamente. Presione "Activar webhooks" para registrarlos.
                </Text>
                <Box marginTop="2" display="flex" gap="1" flexWrap="wrap">
                  {webhooksStatus.registered.map((w: any) => (
                    <Tag key={w.id} appearance="success">{w.event}</Tag>
                  ))}
                  {webhooksStatus.missing.map((e: string) => (
                    <Tag key={e} appearance="danger">Falta: {e}</Tag>
                  ))}
                </Box>
              </Alert>
            )}
          </Card.Body>
        </Card>
      )}
    </Box>
  );
}
