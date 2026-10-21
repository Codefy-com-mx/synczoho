import { useEffect, useState } from 'react';
import { Box, Card, Title, Text, Select, Spinner } from '@nimbus-ds/components';
import { api } from '@/lib/api';
import { toast } from 'sonner';

interface LocationMapping {
  tn_location_id: string;
  tn_location_name: string;
  zoho_location_id: string | null;
  zoho_location_name: string | null;
}
interface LocationsResponse {
  mappings: LocationMapping[]; tn_available: boolean; zoho_available: boolean; zoho_locations: { id: string; name: string }[];
}

// Mismo centinela que server/functions/_shared/locations.ts: esta location recibe el stock total de Zoho.
const ZOHO_TOTAL = '__total__';

interface Props { storeId: string }

export function LocationMappingsCard({ storeId }: Props) {
  const [loading, setLoading] = useState(true);
  const [savingFor, setSavingFor] = useState<string | null>(null);
  const [data, setData] = useState<LocationsResponse>({ mappings: [], tn_available: true, zoho_available: true, zoho_locations: [] });

  const call = async (body: Record<string, unknown>) => {
    const { data: res, error } = await api.functions.invoke('location-mappings', { body: { storeId, ...body } });
    if (error) throw error;
    if (res?.error) throw new Error(res.error);
    setData(res as LocationsResponse);
  };

  useEffect(() => {
    call({ action: 'refresh' })
      .catch((e) => console.error('Error al cargar las ubicaciones', e))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  const change = async (tnId: string, zohoId: string) => {
    setSavingFor(tnId);
    try {
      await call({ action: 'save', mappings: [{ tn_location_id: tnId, zoho_location_id: zohoId || null }] });
      toast.success('Ubicación vinculada guardada');
    } catch (e: any) {
      toast.error(e?.message || 'No se pudo guardar el vínculo');
    } finally {
      setSavingFor(null);
    }
  };

  // Org de Zoho sin locations y tienda con 2+ en Tiendanube: el comerciante elige cuál recibe el total.
  const offerTotal = data.zoho_locations.length === 0 && data.mappings.length >= 2;
  const totalHolder = data.mappings.find((m) => m.zoho_location_id === ZOHO_TOTAL)?.tn_location_id;

  return (
    <Card>
      <Card.Header>
        <Title as="h4" fontSize="h5">Ubicaciones de stock</Title>
      </Card.Header>
      <Card.Body>
        <Box display="flex" flexDirection="column" gap="3">
          <Text>Vincula cada ubicación de Tiendanube con la ubicación de Zoho Inventory de la que sale su stock.</Text>
          {loading && <Spinner />}
          {!loading && !data.tn_available && (
            <Text color="warning-textLow">Reautoriza la app para leer las locations de Tiendanube</Text>
          )}
          {!loading && data.mappings.length === 1 && !data.zoho_available && (
            <Text color="neutral-textLow">Tu organización de Zoho no usa varias ubicaciones: se usa el stock total</Text>
          )}
          {!loading && offerTotal && (
            <Text color="neutral-textLow">
              Zoho no usa varias ubicaciones y tu tienda tiene varias en Tiendanube: elige cuál recibe el stock total de Zoho. Las demás no se modifican.
            </Text>
          )}
          {!loading && data.mappings.map((m) => (
            <Box key={m.tn_location_id} display="grid" gap="2" gridTemplateColumns={{ xs: '1fr', md: '1fr 1fr' }} alignItems="center">
              <Text fontWeight="medium">{m.tn_location_name}</Text>
              <Select
                id={`loc-${m.tn_location_id}`}
                name={`loc-${m.tn_location_id}`}
                value={m.zoho_location_id ?? ''}
                disabled={savingFor === m.tn_location_id}
                onChange={(e) => change(m.tn_location_id, e.target.value)}
              >
                <Select.Option value="" label="Sin vincular" />
                {data.zoho_locations.map((z) => <Select.Option key={z.id} value={z.id} label={z.name} />)}
                {(offerTotal || m.zoho_location_id === ZOHO_TOTAL) && (
                  <Select.Option
                    value={ZOHO_TOTAL}
                    label="Stock total de Zoho (esta ubicación)"
                    disabled={!!totalHolder && totalHolder !== m.tn_location_id}
                  />
                )}
                {m.zoho_location_id && m.zoho_location_id !== ZOHO_TOTAL && !data.zoho_locations.some((z) => z.id === m.zoho_location_id) && (
                  <Select.Option
                    value={m.zoho_location_id}
                    label={`${m.zoho_location_name ?? m.zoho_location_id} (no disponible)`}
                  />
                )}
              </Select>
            </Box>
          ))}
        </Box>
      </Card.Body>
    </Card>
  );
}
