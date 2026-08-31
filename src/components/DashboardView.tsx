import { useEffect, useState } from 'react';
import { Box, Card, Title, Text, Tag, Button, Spinner } from '@nimbus-ds/components';
import {
  TagIcon,
  CashIcon,
  StatsIcon,
  UserGroupIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ChevronRightIcon,
  ClockIcon,
} from '@nimbus-ds/icons';
import { supabase } from '@/integrations/supabase/client';
import { useSyncSettings } from '@/hooks/useSyncSettings';

interface DashboardViewProps {
  storeId: string;
  onNavigate: (section: string) => void;
}

interface Metrics {
  productsSynced: number;
  productsPending: number;
  ordersSynced: number;
  ordersError: number;
  customersSynced: number;
  stockSynced: number;
  lastActivity: string | null;
}

interface LogEntry {
  id: string;
  operation: string;
  status: 'success' | 'error';
  message: string;
  duration_ms: number | null;
  created_at: string;
}

const OP_LABEL: Record<string, string> = {
  zoho_sync_import:   'Importación de productos',
  order_zoho_create:  'Orden sincronizada',
  order_sync:         'Orden sincronizada',
  customer_sync_bulk: 'Clientes sincronizados',
  stock_sync_run:     'Sincronización de stock',
  tiendanube_webhook: 'Webhook recibido',
};

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Ahora mismo';
  if (mins < 60) return `Hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Hace ${hrs} h`;
  return `Hace ${Math.floor(hrs / 24)} d`;
}

const moduleDefs = [
  {
    id: 'sync-products',
    title: 'Productos',
    icon: TagIcon,
    description:
      'Importa tu catálogo desde Zoho Inventory hacia Tiendanube. El sistema detecta coincidencias por SKU para que decidas si crear, vincular o ignorar cada producto. Soporta importación masiva, filtros y reintentos individuales.',
    settingKey: null as keyof ReturnType<typeof useSyncSettings>['settings'] | null,
    alwaysOn: true,
  },
  {
    id: 'sync-orders',
    title: 'Órdenes',
    icon: CashIcon,
    description:
      'Envía automáticamente las órdenes de Tiendanube a Zoho Inventory mediante webhooks. Configura si se crean como borrador, se confirman al instante o generan factura cuando la orden se paga.',
    settingKey: 'orders_enabled' as const,
  },
  {
    id: 'sync-stock',
    title: 'Stock',
    icon: StatsIcon,
    description:
      'Mantén el inventario alineado entre Zoho y Tiendanube. Sincronización bidireccional con prioridad configurable para evitar conflictos cuando hay cambios simultáneos.',
    settingKey: 'stock_enabled' as const,
  },
  {
    id: 'sync-customers',
    title: 'Clientes',
    icon: UserGroupIcon,
    description:
      'Lleva los clientes de Tiendanube a Zoho como contactos. Sincronización masiva manual y vinculación automática por correo electrónico cuando se procesan órdenes nuevas.',
    settingKey: 'customers_auto_sync_on_order' as const,
  },
];

export function DashboardView({ storeId, onNavigate }: DashboardViewProps) {
  const { settings, loading: loadingSettings } = useSyncSettings(storeId);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [recentLogs, setRecentLogs] = useState<LogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);

  useEffect(() => {
    async function loadMetrics() {
      setLoading(true);
      try {
        const { data, error } = await supabase.functions.invoke('dashboard-metrics', {
          body: { store_id: storeId },
        });
        if (error) throw error;
        setMetrics(data.metrics);
      } finally {
        setLoading(false);
      }
    }
    loadMetrics();
  }, [storeId]);

  useEffect(() => {
    async function loadLogs() {
      setLogsLoading(true);
      try {
        const { data } = await supabase.functions.invoke('sync-logs-list', {
          body: { store_id: storeId, limit: 5 },
        });
        setRecentLogs(data?.logs ?? []);
      } finally {
        setLogsLoading(false);
      }
    }
    loadLogs();
  }, [storeId]);

  const isEnabled = (key: string | null): boolean => {
    if (!key) return true;
    if (!settings) return false;
    return Boolean((settings as any)[key]);
  };

  return (
    <Box display="flex" flexDirection="column" gap="6">
      {/* Métricas */}
      <Box display="grid" gap="4" gridTemplateColumns={{ xs: '1fr', md: '1fr 1fr', lg: 'repeat(4, 1fr)' }}>
        <MetricCard
          icon={<TagIcon size="medium" />}
          label="Productos sincronizados"
          value={loading ? '—' : String(metrics?.productsSynced ?? 0)}
          hint={metrics?.productsPending ? `${metrics.productsPending} pendientes` : undefined}
        />
        <MetricCard
          icon={<CashIcon size="medium" />}
          label="Órdenes enviadas a Zoho"
          value={loading ? '—' : String(metrics?.ordersSynced ?? 0)}
          hint={metrics?.ordersError ? `${metrics.ordersError} con error` : undefined}
          hintAppearance={metrics?.ordersError ? 'danger' : 'neutral'}
        />
        <MetricCard
          icon={<StatsIcon size="medium" />}
          label="SKUs con stock sincronizado"
          value={loading ? '—' : String(metrics?.stockSynced ?? 0)}
        />
        <MetricCard
          icon={<UserGroupIcon size="medium" />}
          label="Clientes sincronizados"
          value={loading ? '—' : String(metrics?.customersSynced ?? 0)}
        />
      </Box>

      {/* Mini-feed de actividad reciente */}
      <Card>
        <Card.Header>
          <Box display="flex" justifyContent="space-between" alignItems="center" width="100%">
            <Box display="flex" alignItems="center" gap="2">
              <ClockIcon size="medium" />
              <Title as="h4" fontSize="h5">Actividad reciente</Title>
            </Box>
            <Button appearance="neutral" onClick={() => onNavigate('sync-logs')}>
              Ver historial completo <ChevronRightIcon />
            </Button>
          </Box>
        </Card.Header>
        <Card.Body>
          {logsLoading ? (
            <Box display="flex" justifyContent="center" padding="4"><Spinner /></Box>
          ) : recentLogs.length === 0 ? (
            <Text color="neutral-textLow">Sin actividad registrada aún.</Text>
          ) : (
            <Box display="flex" flexDirection="column" gap="none">
              {recentLogs.map((log, i) => (
                <div
                  key={log.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: '12px',
                    padding: '10px 0',
                    borderBottom: i < recentLogs.length - 1
                      ? '1px solid var(--nimbus-color-neutral-surface-highlight, #eee)'
                      : 'none',
                  }}
                >
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <Box display="flex" alignItems="center" gap="2">
                      <Tag appearance={log.status === 'success' ? 'success' : 'danger'}>
                        {log.status === 'success' ? 'OK' : 'Error'}
                      </Tag>
                      <Text fontWeight="medium" fontSize="caption">
                        {OP_LABEL[log.operation] ?? log.operation}
                      </Text>
                    </Box>
                    <Text fontSize="caption" color="neutral-textLow">
                      {log.message?.slice(0, 100) || '—'}
                    </Text>
                  </div>
                  <Text fontSize="caption" color="neutral-textLow">
                    {relTime(log.created_at)}
                  </Text>
                </div>
              ))}
            </Box>
          )}
        </Card.Body>
      </Card>

      {/* Módulos */}
      <Box display="flex" flexDirection="column" gap="3">
        <Title as="h3" fontSize="h4">Módulos de sincronización</Title>
        <Box display="grid" gap="4" gridTemplateColumns={{ xs: '1fr', md: '1fr 1fr' }}>
          {moduleDefs.map((m) => {
            const enabled = m.alwaysOn || isEnabled(m.settingKey);
            const Icon = m.icon;
            return (
              <Card key={m.id}>
                <Card.Header>
                  <Box display="flex" alignItems="center" justifyContent="space-between" width="100%" gap="2">
                    <Box display="flex" alignItems="center" gap="2">
                      <Icon size="medium" />
                      <Title as="h4" fontSize="h5">{m.title}</Title>
                    </Box>
                    {loadingSettings && !m.alwaysOn ? (
                      <Spinner size="small" />
                    ) : enabled ? (
                      <Tag appearance="success">
                        <CheckCircleIcon size="small" /> Activo
                      </Tag>
                    ) : (
                      <Tag appearance="warning">
                        <ExclamationTriangleIcon size="small" /> Inactivo
                      </Tag>
                    )}
                  </Box>
                </Card.Header>
                <Card.Body>
                  <Box display="flex" flexDirection="column" gap="3">
                    <Text>{m.description}</Text>
                    <Box>
                      <Button appearance="neutral" onClick={() => onNavigate(m.id)}>
                        {enabled ? 'Abrir módulo' : 'Configurar'} <ChevronRightIcon />
                      </Button>
                    </Box>
                  </Box>
                </Card.Body>
              </Card>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

function MetricCard({
  icon,
  label,
  value,
  hint,
  hintAppearance = 'neutral',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  hintAppearance?: 'neutral' | 'danger';
}) {
  return (
    <Card>
      <Card.Body>
        <Box display="flex" flexDirection="column" gap="2">
          <Box display="flex" alignItems="center" gap="2" color="neutral-textLow">
            {icon}
            <Text fontSize="caption" color="neutral-textLow">{label}</Text>
          </Box>
          <Title as="h3" fontSize="h2">{value}</Title>
          {hint && (
            <Text fontSize="caption" color={hintAppearance === 'danger' ? 'danger-textLow' : 'neutral-textLow'}>
              {hint}
            </Text>
          )}
        </Box>
      </Card.Body>
    </Card>
  );
}
