import { useState } from 'react';
import { Box, Card, Title, Text, Tag, Button, Spinner, Checkbox, Input } from '@nimbus-ds/components';
import { LogOutIcon, NotificationIcon } from '@nimbus-ds/icons';
import { ZohoConnectCard } from '@/components/ZohoConnectCard';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FieldHelp } from '@/components/FieldHelp';
import { CategoryMappingsCard } from '@/components/CategoryMappingsCard';
import { supabase } from '@/integrations/supabase/client';
import { useSyncSettings } from '@/hooks/useSyncSettings';
import { toast } from 'sonner';

interface ConfigurationViewProps {
  storeId: string;
  storeName: string;
  storeMeta?: { country?: string; currency?: string } | null;
  onDisconnect?: () => void;
}

export function ConfigurationView({ storeId, storeName, storeMeta, onDisconnect }: ConfigurationViewProps) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const { settings, saving, save } = useSyncSettings(storeId);
  const [alertEmailInput, setAlertEmailInput] = useState('');

  const handleDisconnect = async () => {
    setConfirmDisconnect(false);
    setDisconnecting(true);
    try {
      const { error } = await supabase.functions.invoke('tiendanube-disconnect', {
        body: { store_id: storeId },
      });
      if (error) throw error;
      toast.success('Tienda desconectada correctamente');
    } catch (e: any) {
      // Si la función falla es posible que el token ya sea inválido (app desinstalada
      // desde TN admin). En ese caso el estado local debe limpiarse igual.
      console.warn('[disconnect] error del servidor, limpiando sesión local:', e.message);
      toast.success('Sesión desconectada');
    } finally {
      setDisconnecting(false);
      // Siempre limpiar estado local al final, independientemente del resultado del servidor
      onDisconnect?.();
    }
  };

  return (
    <Box display="flex" flexDirection="column" gap="4">
      <Box display="grid" gap="4" gridTemplateColumns={{ xs: '1fr', md: '1fr 1fr' }}>
        <Card>
          <Card.Header>
            <Box display="flex" alignItems="center" justifyContent="space-between" width="100%">
              <Box display="flex" alignItems="center" gap="2">
                <img
                  src="/tiendanube-logo.png"
                  alt="Tiendanube"
                  style={{ height: 24, width: 'auto' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
                <Title as="h4" fontSize="h5">Tiendanube</Title>
              </Box>
              <Tag appearance="success">Conectada</Tag>
            </Box>
          </Card.Header>
          <Card.Body>
            <Box display="flex" flexDirection="column" gap="3">
              <Box display="flex" flexDirection="column" gap="1">
                <Text>
                  Tienda: <strong>{storeName}</strong>
                </Text>
                {storeMeta && (storeMeta.country || storeMeta.currency) && (
                  <Text fontSize="caption" color="neutral-textLow">
                    {storeMeta.country && `País: ${storeMeta.country}`}
                    {storeMeta.country && storeMeta.currency && ' · '}
                    {storeMeta.currency && `Moneda: ${storeMeta.currency}`}
                  </Text>
                )}
              </Box>
              {onDisconnect && (
                <Box>
                  <ConfirmDialog
                    open={confirmDisconnect}
                    title="¿Desconectar esta tienda?"
                    description="Se eliminará la conexión con Zoho Inventory y el acceso a la app. Podrás volver a conectarla cuando quieras."
                    confirmLabel="Desconectar"
                    onConfirm={handleDisconnect}
                    onCancel={() => setConfirmDisconnect(false)}
                    destructive
                  />
                  <Button appearance="danger" onClick={() => setConfirmDisconnect(true)} disabled={disconnecting}>
                    {disconnecting ? <Spinner size="small" /> : <LogOutIcon />}
                    {disconnecting ? 'Desconectando...' : 'Desconectar tienda'}
                  </Button>
                </Box>
              )}
            </Box>
          </Card.Body>
        </Card>

        <ZohoConnectCard storeId={storeId} />
      </Box>

      {/* Alertas por email */}
      <Card>
        <Card.Header>
          <Box display="flex" alignItems="center" gap="2">
            <NotificationIcon />
            <Title as="h4" fontSize="h5">Alertas por email</Title>
          </Box>
        </Card.Header>
        <Card.Body>
          {!settings ? (
            <Spinner />
          ) : (
            <Box display="flex" flexDirection="column" gap="3">
              <Box display="flex" alignItems="center" gap="2">
                <Checkbox
                  name="alert_on_error"
                  label="Enviar alerta por email cuando falla una sincronización automática"
                  checked={settings.alert_on_error}
                  onChange={(e) => save({ alert_on_error: e.target.checked })}
                />
                <FieldHelp help="Cuando el scheduler automático (stock o precios) detecta errores, te envía un email con el detalle. Requiere configurar un email de destino y la API key de Resend en los secrets de Supabase (RESEND_API_KEY)." />
              </Box>

              {settings.alert_on_error && (
                <Box display="flex" flexDirection="column" gap="2">
                  <Box display="flex" alignItems="center" gap="2">
                    <Text fontWeight="medium" fontSize="caption">Email de destino</Text>
                    <FieldHelp help="Dirección donde recibirás las alertas de error. Puede ser la del administrador de la tienda o cualquier casilla de monitoreo." />
                  </Box>
                  <Box display="flex" gap="2" alignItems="flex-start">
                    <Input
                      type="email"
                      placeholder="admin@mitienda.com"
                      value={alertEmailInput || settings.alert_email || ''}
                      onChange={(e) => setAlertEmailInput(e.target.value)}
                    />
                    <Button
                      appearance="primary"
                      disabled={saving || !alertEmailInput}
                      onClick={() => {
                        save({ alert_email: alertEmailInput });
                        toast.success('Email guardado');
                      }}
                    >
                      {saving ? <Spinner size="small" /> : 'Guardar'}
                    </Button>
                  </Box>
                  {settings.alert_email && (
                    <Text fontSize="caption" color="neutral-textLow">
                      Email actual: <strong>{settings.alert_email}</strong>
                    </Text>
                  )}
                  <Box
                    backgroundColor="neutral-surface"
                    padding="3"
                    borderRadius="2"
                  >
                    <Text fontSize="caption" color="neutral-textLow">
                      Para que el envío funcione, el secreto <strong>RESEND_API_KEY</strong> debe estar
                      configurado en{' '}
                      <strong>Supabase → Edge Functions → Secrets</strong>.
                      Creá una cuenta gratuita en{' '}
                      <strong>resend.com</strong> para obtener tu API key.
                    </Text>
                  </Box>
                </Box>
              )}

              {saving && <Text fontSize="caption" color="neutral-textLow">Guardando…</Text>}
            </Box>
          )}
        </Card.Body>
      </Card>

      <CategoryMappingsCard storeId={storeId} />
    </Box>
  );
}
