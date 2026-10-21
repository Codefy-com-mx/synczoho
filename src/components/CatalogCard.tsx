import { useEffect, useState } from 'react';
import { Box, Card, Title, Text, Tag, Button, Spinner } from '@nimbus-ds/components';
import { RedoIcon } from '@nimbus-ds/icons';
import { api } from '@/lib/api';
import { toast } from 'sonner';

type CatalogStatus = 'pending' | 'ready' | 'stale';

const STATUS_TAG: Record<CatalogStatus, { label: string; appearance: 'primary' | 'success' | 'warning' }> = {
  pending: { label: 'Preparando', appearance: 'primary' },
  ready: { label: 'Al día', appearance: 'success' },
  stale: { label: 'Desactualizado', appearance: 'warning' },
};

interface Props { storeId: string }

export function CatalogCard({ storeId }: Props) {
  const [loading, setLoading] = useState(true);
  const [resyncing, setResyncing] = useState(false);
  const [status, setStatus] = useState<CatalogStatus>('pending');
  const [syncedAt, setSyncedAt] = useState<string | null>(null);

  const call = async (action: 'status' | 'resync') => {
    const { data, error } = await api.functions.invoke('catalog-resync', { body: { storeId, action } });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    setStatus(data.catalog_status);
    setSyncedAt(data.catalog_synced_at ?? null);
  };

  useEffect(() => {
    call('status')
      .catch((e) => console.error('Error al cargar el estado del catálogo', e))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  const resync = async () => {
    setResyncing(true);
    try {
      await call('resync');
      toast.success('Resincronización iniciada. El catálogo se actualizará en unos minutos.');
    } catch (e: any) {
      toast.error(e?.message || 'No se pudo iniciar la resincronización');
    } finally {
      setResyncing(false);
    }
  };

  const tag = STATUS_TAG[status] ?? STATUS_TAG.pending;

  return (
    <Card>
      <Card.Header>
        <Box display="flex" alignItems="center" justifyContent="space-between" width="100%">
          <Title as="h4" fontSize="h5">Catálogo de Tiendanube</Title>
          {!loading && <Tag appearance={tag.appearance}>{tag.label}</Tag>}
        </Box>
      </Card.Header>
      <Card.Body>
        {loading ? (
          <Spinner />
        ) : (
          <Box display="flex" flexDirection="column" gap="3">
            <Text fontSize="caption" color="neutral-textLow">
              Guardamos una copia de tus productos para sincronizar stock y precios sin consultar Tiendanube cada vez.
              {syncedAt
                ? ` Última sincronización: ${new Date(syncedAt).toLocaleString('es-AR')}.`
                : ' Todavía no se sincronizó.'}
            </Text>
            <Box>
              <Button appearance="neutral" onClick={resync} disabled={resyncing}>
                {resyncing ? <Spinner size="small" /> : <RedoIcon />}
                Resincronizar catálogo
              </Button>
            </Box>
          </Box>
        )}
      </Card.Body>
    </Card>
  );
}
