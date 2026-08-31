import { useCallback, useEffect, useState } from 'react';
import {
  Box, Card, Title, Text, Spinner, Alert, Tag, Table, Checkbox,
} from '@nimbus-ds/components';
import { RedoIcon } from '@nimbus-ds/icons';
import { supabase } from '@/integrations/supabase/client';
import { useSyncSettings } from '@/hooks/useSyncSettings';
import { ProgressButton } from '@/components/ProgressButton';
import { FieldHelp } from '@/components/FieldHelp';
import { toast } from 'sonner';

interface Props { storeId: string }

interface CustomerRow {
  id: string;
  email: string | null;
  zoho_contact_id: string | null;
  status: string;
  last_error: string | null;
  last_synced_at: string | null;
}

const PAGE_SIZE = 50;

const parseErrorMsg = (err: string | null): string | null => {
  if (!err) return null;
  try {
    const parsed = JSON.parse(err);
    return parsed.message || err;
  } catch {
    return err;
  }
};

export function SyncCustomersView({ storeId }: Props) {
  const { settings, save } = useSyncSettings(storeId);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [skipExisting, setSkipExisting] = useState(true);
  const [history, setHistory] = useState<CustomerRow[]>([]);
  const [lastResult, setLastResult] = useState<{
    created: number; linked: number; skipped: number; errors: number; total: number; totalCount: number;
  } | null>(null);

  const loadHistory = useCallback(async () => {
    const { data } = await supabase.functions.invoke('customers-history', {
      body: { store_id: storeId, limit: 50 },
    });
    setHistory((data?.customers as CustomerRow[]) || []);
  }, [storeId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const runBulk = async () => {
    setRunning(true);
    setLastResult(null);
    let totalCreated = 0;
    let totalLinked = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalProcessed = 0;
    let page = 1;
    let knownTotal = 0;
    setProgress({ current: 0, total: 0 });
    try {
      while (true) {
        const { data, error } = await supabase.functions.invoke('sync-customers-bulk', {
          body: { storeId, page, limit: PAGE_SIZE, skipExisting },
        });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);

        // En la primera página obtenemos el total real desde el header de TN
        if (page === 1 && data.total_count > 0) {
          knownTotal = data.total_count;
        }

        totalCreated += data.created || 0;
        totalLinked += data.linked || 0;
        totalSkipped += data.skipped || 0;
        totalErrors += data.errors || 0;
        totalProcessed += data.total || 0;

        setProgress({
          current: totalProcessed,
          total: knownTotal || totalProcessed,
        });

        if (!data.total || data.total < PAGE_SIZE) break;
        page++;
      }
      setLastResult({
        created: totalCreated,
        linked: totalLinked,
        skipped: totalSkipped,
        errors: totalErrors,
        total: totalProcessed,
        totalCount: knownTotal,
      });
      toast.success(
        `Clientes: ${totalCreated} creados · ${totalLinked} vinculados · ${totalSkipped} omitidos · ${totalErrors} errores`,
      );
      await loadHistory();
    } catch (e: any) {
      toast.error(e?.message || 'Error en la sincronización de clientes');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  return (
    <Box display="flex" flexDirection="column" gap="4">
      <Card>
        <Card.Header>
          <Title as="h4" fontSize="h5">Configuración de clientes</Title>
        </Card.Header>
        <Card.Body>
          {!settings ? <Spinner /> : (
            <Box display="flex" flexDirection="column" gap="3">
              <Box display="flex" alignItems="center" gap="2">
                <Checkbox
                  name="customers_auto_sync_on_order"
                  label="Crear o vincular automáticamente el cliente en Zoho al recibir una orden"
                  checked={settings.customers_auto_sync_on_order}
                  onChange={(e) => save({ customers_auto_sync_on_order: e.target.checked })}
                />
                <FieldHelp help="Cuando llega una nueva orden desde Tiendanube, el sistema busca al cliente en Zoho por su correo. Si no existe, lo crea automáticamente con sus datos de facturación. Si ya existe, solo lo vincula. Esto evita tener que cargar contactos manualmente." />
              </Box>
              <Box display="flex" alignItems="center" gap="2">
                <Checkbox
                  name="skipExisting"
                  label="Omitir clientes ya sincronizados (recomendado para ahorrar recursos)"
                  checked={skipExisting}
                  onChange={(e) => setSkipExisting(e.target.checked)}
                />
                <FieldHelp help="Si está activo, los clientes que ya tienen un contacto vinculado en Zoho serán saltados durante la sincronización masiva. Esto reduce el tiempo de procesamiento y evita consumir cupos de la API innecesariamente. Desactívelo solo si necesita re-sincronizar datos actualizados." />
              </Box>
            </Box>
          )}
        </Card.Body>
      </Card>

      <Card>
        <Card.Header>
          <Box display="flex" justifyContent="space-between" alignItems="center" width="100%">
            <Title as="h4" fontSize="h5">Sincronización masiva</Title>
            <ProgressButton
              onClick={runBulk}
              loading={running}
              progress={progress}
              icon={<RedoIcon />}
              loadingLabel="Sincronizando"
            >
              Sincronizar clientes ahora
            </ProgressButton>
          </Box>
        </Card.Header>
        <Card.Body>
          <Text>
            Trae los clientes desde Tiendanube y los crea o vincula en Zoho Inventory utilizando el correo electrónico como identificador.
            {skipExisting && ' Los clientes ya sincronizados se omiten automáticamente.'}
          </Text>
          {lastResult && (
            <Box marginTop="3" display="flex" gap="2" flexWrap="wrap">
              <Tag appearance="primary">Procesados: {lastResult.total} de {lastResult.totalCount || lastResult.total}</Tag>
              <Tag appearance="success">Creados: {lastResult.created}</Tag>
              <Tag appearance="primary">Vinculados: {lastResult.linked}</Tag>
              <Tag appearance="neutral">Omitidos: {lastResult.skipped}</Tag>
              <Tag appearance={lastResult.errors > 0 ? 'danger' : 'neutral'}>Errores: {lastResult.errors}</Tag>
            </Box>
          )}
        </Card.Body>
      </Card>

      <Card>
        <Card.Header>
          <Title as="h4" fontSize="h5">Historial de clientes sincronizados</Title>
        </Card.Header>
        <Card.Body>
          {history.length === 0 ? (
            <Alert appearance="neutral">Aún no hay clientes sincronizados.</Alert>
          ) : (
            <Table>
              <Table.Head>
                <Table.Row>
                  <Table.Cell as="th">Correo</Table.Cell>
                  <Table.Cell as="th">Estado</Table.Cell>
                  <Table.Cell as="th">ID de contacto en Zoho</Table.Cell>
                  <Table.Cell as="th">Última sincronización</Table.Cell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {history.map((c) => (
                  <Table.Row key={c.id}>
                    <Table.Cell>{c.email || '—'}</Table.Cell>
                    <Table.Cell>
                      <Tag appearance={c.status === 'success' ? 'success' : c.status === 'error' ? 'danger' : 'neutral'}>
                        {c.status}
                      </Tag>
                      {c.last_error && <Text fontSize="caption" color="danger-textLow">{(parseErrorMsg(c.last_error) ?? '').slice(0, 80)}</Text>}
                    </Table.Cell>
                    <Table.Cell>{c.zoho_contact_id || '—'}</Table.Cell>
                    <Table.Cell>
                      {c.last_synced_at ? new Date(c.last_synced_at).toLocaleString() : '—'}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
        </Card.Body>
      </Card>
    </Box>
  );
}
