import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, Link2, CheckCircle2, RefreshCw, Sparkles, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface ZohoConnectCardProps {
  storeId: string;
}

const ZOHO_REDIRECT_PATH = '/zoho/callback';

export function ZohoConnectCard({ storeId }: ZohoConnectCardProps) {
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState<{
    organization_id: string | null;
    organization_name: string | null;
    status: string;
  } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const redirectUri = `${window.location.origin}${ZOHO_REDIRECT_PATH}`;

  // Cargar conexión actual via edge function (evita problemas de RLS sin sesión)
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { data, error } = await api.functions.invoke('zoho-connection-status', {
          body: { store_id: storeId },
        });
        if (error) throw error;
        if (!cancelled) {
          setConnection(data?.connection || null);
          setLoading(false);
        }
      } catch (e) {
        console.error('Error loading Zoho connection status', e);
        if (!cancelled) setLoading(false);
      }
    };
    load();

    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [storeId]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const { data, error } = await api.functions.invoke('zoho-auth-start', {
        body: { store_id: storeId, dc: 'com', redirect_uri: redirectUri },
      });
      if (error) throw error;
      if (data.auth_url) {
        // Zoho bloquea iframes (X-Frame-Options). Romper el iframe o abrir nueva pestaña.
        const isEmbedded = window.top !== window.self;
        if (isEmbedded) {
          try {
            window.top!.location.href = data.auth_url;
          } catch {
            window.open(data.auth_url, '_blank', 'noopener,noreferrer');
          }
        } else {
          window.location.href = data.auth_url;
        }
      }
    } catch (e: any) {
      console.error(e);
      toast.error(e.message || 'No se pudo iniciar la conexión con Zoho');
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setConfirmDisconnect(false);
    try {
      const { error } = await api.functions.invoke('zoho-disconnect', {
        body: { store_id: storeId },
      });
      if (error) throw error;
      setConnection(null);
      toast.success('Zoho desconectado');
    } catch (e: any) {
      toast.error(e.message || 'Error al desconectar');
    }
  };

  const isConnected = connection?.status === 'active' && connection?.organization_id;

  // Estado: aún no conectado y sin orgs pendientes → pantalla hero
  if (!loading && !isConnected) {
    return (
      <Card className="overflow-hidden border-border">
        <CardContent className="p-0">
          <div className="grid md:grid-cols-2 gap-0">
            {/* Ilustración / branding */}
            <div className="bg-muted/40 flex items-center justify-center p-10 border-b md:border-b-0 md:border-r border-border">
              <div className="text-center space-y-4">
                <div className="inline-flex items-center justify-center w-24 h-24 rounded-2xl bg-background shadow-sm border border-border">
                  <img
                    src="/zoho-icon.png"
                    alt="Zoho Inventory"
                    className="w-14 h-14 object-contain"
                  />
                </div>
                <img
                  src="/zoho-inventory-logo.png"
                  alt="Zoho Inventory"
                  className="h-7 w-auto mx-auto"
                />
              </div>
            </div>

            {/* Contenido */}
            <div className="p-8 md:p-10 space-y-6">
              <div>
                <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase mb-2">
                  Zoho Inventory
                </p>
                <h2 className="text-2xl md:text-3xl font-bold text-foreground leading-tight">
                  Sincroniza tu inventario con Zoho
                </h2>
              </div>

              <ul className="space-y-4">
                <li className="flex gap-3">
                  <RefreshCw className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                  <span className="text-sm text-muted-foreground leading-relaxed">
                    Sincroniza automáticamente productos, stock y pedidos entre Tiendanube y Zoho Inventory.
                  </span>
                </li>
                <li className="flex gap-3">
                  <Sparkles className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                  <span className="text-sm text-muted-foreground leading-relaxed">
                    Olvídate de actualizar el stock manualmente. Cada venta se refleja al instante en ambas plataformas.
                  </span>
                </li>
                <li className="flex gap-3">
                  <ShieldCheck className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                  <span className="text-sm text-muted-foreground leading-relaxed">
                    Conexión segura mediante OAuth oficial de Zoho. Tus credenciales nunca se almacenan en nuestros servidores.
                  </span>
                </li>
              </ul>

              <div className="pt-2">
                <Button
                  size="lg"
                  onClick={handleConnect}
                  disabled={connecting}
                  className="w-full md:w-auto"
                >
                  {connecting ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Link2 className="w-4 h-4 mr-2" />
                  )}
                  Conectar Zoho Inventory
                </Button>
                <p className="text-xs text-muted-foreground mt-3">
                  Al conectar, serás redirigido a Zoho para autorizar el acceso. Necesitas una cuenta activa de{' '}
                  <a
                    href="https://www.zoho.com/inventory/signup.html"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    Zoho Inventory
                  </a>
                  .
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={isConnected ? '' : 'border-dashed'}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img
              src="/zoho-inventory-logo.png"
              alt="Zoho Inventory"
              style={{ height: 24, width: 'auto' }}
            />
          </div>
          {loading ? (
            <Badge variant="secondary" className="text-xs">Cargando...</Badge>
          ) : isConnected ? (
            <Badge variant="default" className="bg-green-500 text-white text-xs">Conectada</Badge>
          ) : (
            <Badge variant="secondary" className="text-xs">Pendiente</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Cargando estado...
          </div>
        ) : isConnected ? (
          <>
            <div className="text-sm text-muted-foreground space-y-1">
              <div className="flex items-center gap-1.5 text-foreground">
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                <span className="font-medium">{connection?.organization_name || 'Organización conectada'}</span>
              </div>
              <p className="text-xs">Org ID: {connection?.organization_id}</p>
            </div>
            <ConfirmDialog
              open={confirmDisconnect}
              title="¿Desconectar Zoho Inventory?"
              description="Se eliminará la conexión con Zoho Inventory de esta tienda. Podrás volver a conectarla cuando quieras."
              confirmLabel="Desconectar"
              onConfirm={handleDisconnect}
              onCancel={() => setConfirmDisconnect(false)}
              destructive
            />
            <Button variant="outline" size="sm" onClick={() => setConfirmDisconnect(true)}>
              Desconectar
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
