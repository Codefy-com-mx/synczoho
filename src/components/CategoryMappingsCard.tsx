import { useState } from 'react';
import {
  Box, Card, Title, Text, Button, Select, Spinner, Tag, Alert,
} from '@nimbus-ds/components';
import { CogIcon, TrashIcon, PlusCircleIcon } from '@nimbus-ds/icons';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface ZohoCat { id: string; name: string }
interface TNCat { id: number; name: string; depth: number }
interface Mapping { zoho_category: string; tn_category_id: number; tn_category_name: string }

interface Props { storeId: string }

export function CategoryMappingsCard({ storeId }: Props) {
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [zohoCategories, setZohoCategories] = useState<ZohoCat[]>([]);
  const [tnCategories, setTNCategories] = useState<TNCat[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [savingFor, setSavingFor] = useState<string | null>(null);
  const [deletingFor, setDeletingFor] = useState<string | null>(null);

  // Draft: zohoCategory → selected tn_category_id (null = sin mapeo)
  const [draft, setDraft] = useState<Record<string, number | ''>>({});

  const loadData = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('category-mappings', {
        body: { storeId, action: 'list' },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setZohoCategories(data.zohoCategories || []);
      setTNCategories(data.tnCategories || []);
      setMappings(data.mappings || []);

      // Inicializar draft con los valores actuales
      const initialDraft: Record<string, number | ''> = {};
      for (const m of (data.mappings || []) as Mapping[]) {
        initialDraft[m.zoho_category] = m.tn_category_id;
      }
      setDraft(initialDraft);
      setLoaded(true);
    } catch (e: any) {
      toast.error(e?.message || 'Error al cargar categorías');
    } finally {
      setLoading(false);
    }
  };

  const saveMapping = async (zohoCategory: string) => {
    const tnId = draft[zohoCategory];
    if (!tnId) return;
    const tnCat = tnCategories.find((c) => c.id === Number(tnId));
    if (!tnCat) return;
    setSavingFor(zohoCategory);
    try {
      const { data, error } = await supabase.functions.invoke('category-mappings', {
        body: {
          storeId,
          action: 'save',
          zohoCategory,
          tnCategoryId: tnCat.id,
          tnCategoryName: tnCat.name,
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setMappings((prev) => {
        const filtered = prev.filter((m) => m.zoho_category !== zohoCategory);
        return [...filtered, { zoho_category: zohoCategory, tn_category_id: tnCat.id, tn_category_name: tnCat.name }];
      });
      toast.success(`Mapeo guardado: ${zohoCategory} → ${tnCat.name}`);
    } catch (e: any) {
      toast.error(e?.message || 'Error al guardar mapeo');
    } finally {
      setSavingFor(null);
    }
  };

  const deleteMapping = async (zohoCategory: string) => {
    setDeletingFor(zohoCategory);
    try {
      const { data, error } = await supabase.functions.invoke('category-mappings', {
        body: { storeId, action: 'delete', zohoCategory },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setMappings((prev) => prev.filter((m) => m.zoho_category !== zohoCategory));
      setDraft((prev) => { const next = { ...prev }; delete next[zohoCategory]; return next; });
      toast.success(`Mapeo eliminado: ${zohoCategory}`);
    } catch (e: any) {
      toast.error(e?.message || 'Error al eliminar mapeo');
    } finally {
      setDeletingFor(null);
    }
  };

  const mappingFor = (zohoCategory: string) =>
    mappings.find((m) => m.zoho_category === zohoCategory);

  const isDirty = (zohoCategory: string) => {
    const current = mappingFor(zohoCategory);
    const draftVal = draft[zohoCategory];
    if (!current && !draftVal) return false;
    if (!current && draftVal) return true;
    if (current && !draftVal) return false;
    return current!.tn_category_id !== Number(draftVal);
  };

  const prefix = (depth: number, name: string) => ' '.repeat(depth * 3) + name;

  return (
    <Card>
      <Card.Header>
        <Box display="flex" justifyContent="space-between" alignItems="center" width="100%">
          <Box display="flex" alignItems="center" gap="2">
            <CogIcon />
            <Title as="h4" fontSize="h5">Mapeo de categorías</Title>
          </Box>
          <Button onClick={loadData} disabled={loading}>
            {loading ? <Spinner size="small" /> : <PlusCircleIcon />}
            {loaded ? 'Recargar' : 'Cargar categorías'}
          </Button>
        </Box>
      </Card.Header>
      <Card.Body>
        <Box display="flex" flexDirection="column" gap="3">
          <Text>
            Relaciona cada categoría de Zoho Inventory con una categoría de Tiendanube.
            Al importar productos, se usará el ID exacto de TN en vez de crear categorías nuevas por nombre.
          </Text>

          {!loaded && !loading && (
            <Alert appearance="neutral" title="Sin cargar">
              <Text fontSize="caption">Hacé click en "Cargar categorías" para ver y editar los mapeos.</Text>
            </Alert>
          )}

          {loading && (
            <Box display="flex" justifyContent="center" padding="4">
              <Spinner />
            </Box>
          )}

          {loaded && !loading && (
            <Box display="flex" flexDirection="column" gap="2">
              {/* Resumen */}
              <Box display="flex" gap="2" flexWrap="wrap">
                <Tag appearance="neutral">Categorías Zoho: {zohoCategories.length}</Tag>
                <Tag appearance="neutral">Categorías TN: {tnCategories.length}</Tag>
                <Tag appearance={mappings.length > 0 ? 'success' : 'warning'}>
                  Mapeos activos: {mappings.length}
                </Tag>
              </Box>

              {zohoCategories.length === 0 ? (
                <Alert appearance="neutral" title="Sin categorías en Zoho">
                  <Text fontSize="caption">No se encontraron categorías en tu cuenta de Zoho Inventory.</Text>
                </Alert>
              ) : (
                <Box display="flex" flexDirection="column" gap="none">
                  {/* Header */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr auto',
                    gap: '12px',
                    padding: '8px 0',
                    borderBottom: '1px solid var(--nimbus-color-neutral-surface-highlight, #eee)',
                  }}>
                    <Text fontSize="caption" fontWeight="bold">Categoría en Zoho</Text>
                    <Text fontSize="caption" fontWeight="bold">Categoría en Tiendanube</Text>
                    <Text fontSize="caption" fontWeight="bold">Acción</Text>
                  </div>

                  {zohoCategories.map((zcat) => {
                    const currentMap = mappingFor(zcat.name);
                    const dirty = isDirty(zcat.name);
                    const saving = savingFor === zcat.name;
                    const deleting = deletingFor === zcat.name;

                    return (
                      <div
                        key={zcat.id}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 1fr auto',
                          gap: '12px',
                          padding: '10px 0',
                          alignItems: 'center',
                          borderBottom: '1px solid var(--nimbus-color-neutral-surface-highlight, #eee)',
                        }}
                      >
                        {/* Zoho category */}
                        <Box display="flex" alignItems="center" gap="1">
                          <Text fontSize="caption" fontWeight="medium">{zcat.name}</Text>
                          {currentMap && (
                            <Tag appearance="success">✓</Tag>
                          )}
                        </Box>

                        {/* TN category selector */}
                        <Select
                          id={`tn-cat-${zcat.id}`}
                          name={`tn-cat-${zcat.id}`}
                          value={draft[zcat.name] ?? ''}
                          onChange={(e) =>
                            setDraft((prev) => ({
                              ...prev,
                              [zcat.name]: e.target.value ? Number(e.target.value) : '',
                            }))
                          }
                        >
                          <Select.Option value="" label="— Sin mapeo —" />
                          {tnCategories.map((tc) => (
                            <Select.Option
                              key={tc.id}
                              value={String(tc.id)}
                              label={prefix(tc.depth, tc.name)}
                            />
                          ))}
                        </Select>

                        {/* Actions */}
                        <Box display="flex" gap="1" alignItems="center">
                          {dirty && (
                            <Button
                              appearance="primary"
                              onClick={() => saveMapping(zcat.name)}
                              disabled={saving || !draft[zcat.name]}
                            >
                              {saving ? <Spinner size="small" /> : 'Guardar'}
                            </Button>
                          )}
                          {currentMap && !dirty && (
                            <Button
                              appearance="danger"
                              aria-label={`Eliminar mapeo ${zcat.name}`}
                              onClick={() => deleteMapping(zcat.name)}
                              disabled={deleting}
                            >
                              {deleting ? <Spinner size="small" /> : <TrashIcon />}
                            </Button>
                          )}
                        </Box>
                      </div>
                    );
                  })}
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Card.Body>
    </Card>
  );
}
