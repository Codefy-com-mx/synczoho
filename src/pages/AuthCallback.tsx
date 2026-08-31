import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { TIENDANUBE_APP_ID, getEmbeddedAdminAppUrl } from '@/lib/tiendanube';
import { RefreshCw, Loader2, CheckCircle, XCircle } from 'lucide-react';

export default function AuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Procesando autorización...');
  const code = searchParams.get('code');
  const oauthError = searchParams.get('error');

  useEffect(() => {
    if (oauthError) {
      setStatus('error');
      setMessage(oauthError);
      return;
    }

    if (!code) {
      setStatus('error');
      setMessage('No se recibió código de autorización');
      return;
    }

    async function exchangeCode() {
      try {
        const { data, error } = await supabase.functions.invoke('tiendanube-auth', {
          body: { code },
        });

        if (error) throw error;

        if (data.success) {
          localStorage.setItem('tiendanube_store_id', data.store_id.toString());
          localStorage.setItem('tiendanube_store_name', data.store_name || 'Mi Tienda');
          if (data.store_handle) {
            localStorage.setItem('tiendanube_store_handle', data.store_handle);
          }

          setStatus('success');
          setMessage(`¡Tienda "${data.store_name}" conectada exitosamente!`);

          setTimeout(() => {
            const storeHandle = data.store_handle || localStorage.getItem('tiendanube_store_handle');
            if (storeHandle) {
              window.location.href = getEmbeddedAdminAppUrl(storeHandle, TIENDANUBE_APP_ID);
            } else {
              navigate('/', { replace: true });
            }
          }, 2000);
        } else {
          throw new Error(data.error || 'Error desconocido');
        }
      } catch (err) {
        console.error('Auth error:', err);
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'Error al conectar la tienda');
      }
    }

    exchangeCode();
  }, [code, oauthError, navigate]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="bg-card rounded-xl p-8 max-w-md w-full text-center border border-border shadow-sm">
        <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center mx-auto mb-6">
          <RefreshCw className="w-6 h-6 text-primary-foreground" />
        </div>

        <div className="mb-6">
          {status === 'loading' && (
            <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto" />
          )}
          {status === 'success' && (
            <CheckCircle className="w-10 h-10 text-green-500 mx-auto" />
          )}
          {status === 'error' && (
            <XCircle className="w-10 h-10 text-destructive mx-auto" />
          )}
        </div>

        <h2 className="text-lg font-bold text-foreground mb-2">
          {status === 'loading' && 'Conectando tu tienda...'}
          {status === 'success' && '¡Conectado!'}
          {status === 'error' && 'Error de conexión'}
        </h2>
        <p className="text-muted-foreground text-sm">{message}</p>

        {status === 'error' && (
          <button
            onClick={() => navigate('/')}
            className="mt-6 px-6 py-2 rounded-lg bg-secondary text-foreground hover:bg-secondary/80 transition-colors text-sm font-medium"
          >
            Volver al inicio
          </button>
        )}
      </div>
    </div>
  );
}
