import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { LandingHero } from '@/components/LandingHero';
import { AppShell } from '@/components/AppShell';
import { ConfigurationView } from '@/components/ConfigurationView';
import { DashboardView } from '@/components/DashboardView';
import { SyncProductsView } from '@/components/SyncProductsView';
import { SyncOrdersView } from '@/components/SyncOrdersView';
import { SyncStockView } from '@/components/SyncStockView';
import { SyncCustomersView } from '@/components/SyncCustomersView';
import { SyncLogsView } from '@/components/SyncLogsView';
import { useNexo } from '@/hooks/useNexo';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import {
  HomeIcon,
  TagIcon,
  CashIcon,
  StatsIcon,
  UserGroupIcon,
  CogIcon,
  ClockIcon,
} from '@nimbus-ds/icons';

export default function Index() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { isEmbedded, isConnected, storeInfo, checked: nexoChecked } = useNexo();
  const [storeId, setStoreId] = useState<string | null>(null);
  const [storeName, setStoreName] = useState<string>('Mi Tienda');
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState('configuration');
  const [zohoConnected, setZohoConnected] = useState<boolean | null>(null);
  // Cuando recién detectamos conexión completa, llevamos al usuario al Inicio (una sola vez)
  const [autoNavigatedToDashboard, setAutoNavigatedToDashboard] = useState(false);

  useEffect(() => {
    if (isEmbedded && isConnected && storeInfo) {
      setStoreId(storeInfo.id);
      setStoreName(storeInfo.name || 'Mi Tienda');
      localStorage.setItem('tiendanube_store_id', storeInfo.id);
      localStorage.setItem('tiendanube_store_name', storeInfo.name || 'Mi Tienda');
      setLoading(false);
      return;
    }

    // ?reset=1 → forzar limpieza de sesión local y mostrar landing
    const reset = searchParams.get('reset');
    if (reset) {
      localStorage.removeItem('tiendanube_store_id');
      localStorage.removeItem('tiendanube_store_name');
      localStorage.removeItem('tiendanube_store_handle');
      navigate('/', { replace: true });
      setLoading(false);
      return;
    }

    const id = localStorage.getItem('tiendanube_store_id');
    const name = localStorage.getItem('tiendanube_store_name');

    if (id) {
      // Verificar que la tienda sigue activa en la DB antes de mostrar el dashboard.
      // store_found: false significa que la tienda fue eliminada (ej: app desinstalada desde TN)
      api
        .functions.invoke('zoho-connection-status', { body: { store_id: id } })
        .then(({ data, error }) => {
          const storeGone = error || data?.store_found === false;
          if (storeGone) {
            // La tienda ya no existe en la DB — limpiar estado local y mostrar landing
            localStorage.removeItem('tiendanube_store_id');
            localStorage.removeItem('tiendanube_store_name');
            localStorage.removeItem('tiendanube_store_handle');
            setStoreId(null);
          } else {
            setStoreId(id);
            if (name) setStoreName(name);
          }
          setLoading(false);
        });
    } else {
      setLoading(false);
    }
  }, [searchParams, navigate, isEmbedded, isConnected, storeInfo]);

  // Verificar estado de Zoho una vez que tengamos storeId
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    const check = async () => {
      try {
        const { data } = await api.functions.invoke('zoho-connection-status', {
          body: { store_id: storeId },
        });
        if (!cancelled) {
          const conn = data?.connection;
          setZohoConnected(!!(conn?.status === 'active' && conn?.organization_id));
        }
      } catch {
        if (!cancelled) setZohoConnected(false);
      }
    };
    check();
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [storeId]);

  // Habilitar el resto de los módulos sólo cuando ambos canales estén conectados
  const fullyConnected = zohoConnected === true;

  // Si todavía no está totalmente conectado, sólo mostramos Configuración.
  // Una vez que se conecta, llevamos al Inicio automáticamente (sólo la primera vez).
  useEffect(() => {
    if (!fullyConnected && activeSection !== 'configuration') {
      setActiveSection('configuration');
      return;
    }
    if (fullyConnected && !autoNavigatedToDashboard) {
      setActiveSection('dashboard');
      setAutoNavigatedToDashboard(true);
    }
  }, [fullyConnected, activeSection, autoNavigatedToDashboard]);

  const handleDisconnect = () => {
    localStorage.removeItem('tiendanube_store_id');
    localStorage.removeItem('tiendanube_store_name');
    setStoreId(null);
    setStoreName('Mi Tienda');
  };

  if (!nexoChecked || loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  if (isEmbedded && !storeId) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
          <p className="text-sm text-muted-foreground">Conectando con Tiendanube...</p>
        </div>
      </div>
    );
  }

  if (!storeId) {
    return <LandingHero />;
  }

  const sections = fullyConnected
    ? [
        { id: 'dashboard', label: 'Inicio', icon: <HomeIcon /> },
        { id: 'sync-products', label: 'Productos', icon: <TagIcon /> },
        { id: 'sync-orders', label: 'Órdenes', icon: <CashIcon /> },
        { id: 'sync-stock', label: 'Stock', icon: <StatsIcon /> },
        { id: 'sync-customers', label: 'Clientes', icon: <UserGroupIcon /> },
        { id: 'sync-logs', label: 'Historial', icon: <ClockIcon /> },
        { id: 'configuration', label: 'Configuración', icon: <CogIcon /> },
      ]
    : [
        { id: 'configuration', label: 'Configuración', icon: <CogIcon /> },
      ];

  return (
    <AppShell
      sections={sections}
      activeSection={activeSection}
      onSectionChange={setActiveSection}
    >
      {activeSection === 'dashboard' && fullyConnected && (
        <DashboardView storeId={storeId} onNavigate={setActiveSection} />
      )}
      {activeSection === 'configuration' && (
        <ConfigurationView
          storeId={storeId}
          storeName={storeName}
          storeMeta={isEmbedded && storeInfo ? { country: storeInfo.country, currency: storeInfo.currency } : null}
          onDisconnect={handleDisconnect}
        />
      )}
      {activeSection === 'sync-products' && fullyConnected && <SyncProductsView storeId={storeId} />}
      {activeSection === 'sync-orders' && fullyConnected && <SyncOrdersView storeId={storeId} />}
      {activeSection === 'sync-stock' && fullyConnected && <SyncStockView storeId={storeId} />}
      {activeSection === 'sync-customers' && fullyConnected && <SyncCustomersView storeId={storeId} />}
      {activeSection === 'sync-logs' && fullyConnected && <SyncLogsView storeId={storeId} />}
    </AppShell>
  );
}
