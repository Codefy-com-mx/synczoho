import { useCallback, useEffect, useState } from 'react';
import {
  Box, Card, Title, Text, Tag, Select, Button, Spinner, Alert, Table,
} from '@nimbus-ds/components';
import { RedoIcon } from '@nimbus-ds/icons';
import { api } from '@/lib/api';

interface Props { storeId: string }

interface LogEntry {
  id: string;
  operation: string;
  status: 'success' | 'error';
  message: string;
  duration_ms: number | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

const OPERATION_LABELS: Record<string, string> = {
  zoho_sync_import:       'Importación de productos',
  import_update:          'Actualización de producto',
  order_zoho_create:      'Sincronización de orden',
  order_sync:             'Sincronización de orden',
  customer_sync_bulk:     'Sincronización de clientes',
  stock_sync_run:         'Sincronización de stock',
  tiendanube_webhook:     'Webhook recibido',
  dashboard_metrics:      'Métricas del dashboard',
};

const OPERATION_OPTIONS = [
  { value: '', label: 'Todas las operaciones' },
  { value: 'zoho_sync_import', label: 'Importación de productos' },
  { value: 'order_zoho_create', label: 'Órdenes' },
  { value: 'customer_sync_bulk', label: 'Clientes' },
  { value: 'stock_sync_run', label: 'Stock' },
];

function formatOp(op: string) {
  return OPERATION_LABELS[op] ?? op;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('es', { dateStyle: 'short', timeStyle: 'medium' });
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Ahora mismo';
  if (mins < 60) return `Hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Hace ${hrs} h`;
  return `Hace ${Math.floor(hrs / 24)} d`;
}

export function SyncLogsView({ storeId }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterOp, setFilterOp] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [limit, setLimit] = useState(50);

  const load = useCallback(async (op: string, status: string, lim: number) => {
    setLoading(true);
    try {
      const body: Record<string, unknown> = { store_id: storeId, limit: lim };
      if (op) body.operation = op;
      if (status) body.status = status;
      const { data, error } = await api.functions.invoke('sync-logs-list', { body });
      if (error) throw error;
      setLogs(data?.logs ?? []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    load(filterOp, filterStatus, limit);
  }, [load, filterOp, filterStatus, limit]);

  const refresh = () => load(filterOp, filterStatus, limit);

  const successCount = logs.filter((l) => l.status === 'success').length;
  const errCount = logs.filter((l) => l.status === 'error').length;

  return (
    <Box display="flex" flexDirection="column" gap="4">
      {/* Resumen numérico */}
      <Box display="grid" gap="4" gridTemplateColumns={{ xs: '1fr 1fr', md: 'repeat(3, 1fr)' }}>
        <Card>
          <Card.Body>
            <Box display="flex" flexDirection="column" gap="1">
              <Text fontSize="caption" color="neutral-textLow">Registros mostrados</Text>
              <Title as="h3" fontSize="h3">{loading ? '—' : String(logs.length)}</Title>
            </Box>
          </Card.Body>
        </Card>
        <Card>
          <Card.Body>
            <Box display="flex" flexDirection="column" gap="1">
              <Text fontSize="caption" color="neutral-textLow">Exitosos</Text>
              <Title as="h3" fontSize="h3">{loading ? '—' : String(successCount)}</Title>
            </Box>
          </Card.Body>
        </Card>
        <Card>
          <Card.Body>
            <Box display="flex" flexDirection="column" gap="1">
              <Text fontSize="caption" color="neutral-textLow">Con error</Text>
              <Title as="h3" fontSize="h3">{loading ? '—' : String(errCount)}</Title>
              {!loading && errCount > 0 && (
                <Text fontSize="caption" color="danger-textLow">Requieren atención</Text>
              )}
            </Box>
          </Card.Body>
        </Card>
      </Box>

      {/* Tabla de logs */}
      <Card>
        <Card.Header>
          <Box display="flex" justifyContent="space-between" alignItems="center" width="100%">
            <Title as="h4" fontSize="h5">Historial de operaciones</Title>
            <Button onClick={refresh} disabled={loading}>
              {loading ? <Spinner size="small" /> : <RedoIcon />}
              Actualizar
            </Button>
          </Box>
        </Card.Header>
        <Card.Body>
          {/* Filtros */}
          <Box display="flex" gap="3" flexWrap="wrap" marginBottom="4">
            <Box>
              <Select
                id="filter-op"
                name="filter-op"
                value={filterOp}
                onChange={(e) => { setLimit(50); setFilterOp(e.target.value); }}
              >
                {OPERATION_OPTIONS.map((o) => (
                  <Select.Option key={o.value} value={o.value} label={o.label} />
                ))}
              </Select>
            </Box>
            <Box>
              <Select
                id="filter-status"
                name="filter-status"
                value={filterStatus}
                onChange={(e) => { setLimit(50); setFilterStatus(e.target.value); }}
              >
                <Select.Option value="" label="Todos los estados" />
                <Select.Option value="success" label="Exitosos" />
                <Select.Option value="error" label="Con error" />
              </Select>
            </Box>
          </Box>

          {loading ? (
            <Box display="flex" justifyContent="center" padding="6">
              <Spinner />
            </Box>
          ) : logs.length === 0 ? (
            <Alert appearance="neutral">
              No hay registros con los filtros seleccionados.
            </Alert>
          ) : (
            <>
              <Table>
                <Table.Head>
                  <Table.Row>
                    <Table.Cell as="th">Operación</Table.Cell>
                    <Table.Cell as="th">Estado</Table.Cell>
                    <Table.Cell as="th">Mensaje</Table.Cell>
                    <Table.Cell as="th">Duración</Table.Cell>
                    <Table.Cell as="th">Fecha</Table.Cell>
                  </Table.Row>
                </Table.Head>
                <Table.Body>
                  {logs.map((log) => (
                    <Table.Row key={log.id}>
                      <Table.Cell>
                        <Text fontWeight="medium" fontSize="caption">
                          {formatOp(log.operation)}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Tag appearance={log.status === 'success' ? 'success' : 'danger'}>
                          {log.status === 'success' ? 'Exitoso' : 'Error'}
                        </Tag>
                      </Table.Cell>
                      <Table.Cell>
                        <Text
                          fontSize="caption"
                          color={log.status === 'error' ? 'danger-textLow' : 'neutral-textLow'}
                        >
                          {log.message?.slice(0, 120) || '—'}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Text fontSize="caption" color="neutral-textLow">
                          {log.duration_ms != null ? `${log.duration_ms} ms` : '—'}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Text fontSize="caption" color="neutral-textLow">
                          <span title={formatDate(log.created_at)}>
                            {relativeTime(log.created_at)}
                          </span>
                        </Text>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>

              {logs.length >= limit && (
                <Box display="flex" justifyContent="center" marginTop="4">
                  <Button
                    appearance="neutral"
                    onClick={() => setLimit((l) => l + 50)}
                  >
                    Cargar más registros
                  </Button>
                </Box>
              )}
            </>
          )}
        </Card.Body>
      </Card>
    </Box>
  );
}
