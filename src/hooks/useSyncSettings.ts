import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';

export interface ProductSyncFields {
  name: boolean;
  sku: boolean;
  description: boolean;
  price: boolean;
  stock: boolean;
  images: boolean;
  category: boolean;
  weight: boolean;
  dimensions: boolean;
  barcode: boolean;
  brand: boolean;
  tax: boolean;
}

export interface SyncSettings {
  id?: string;
  store_id: string;
  orders_enabled: boolean;
  orders_create_as_draft: boolean;
  orders_auto_confirm: boolean;
  orders_generate_invoice_on_paid: boolean;
  orders_only_paid: boolean;
  stock_enabled: boolean;
  stock_warehouse_id: string | null;
  customers_auto_sync_on_order: boolean;
  alert_on_error: boolean;
  alert_email: string | null;
  prices_enabled: boolean;
  products_publish_on_import: boolean;
  products_overwrite_existing: boolean;
  products_match_strategy: 'sku' | 'name';
  products_sync_fields: ProductSyncFields;
  stock_direction: 'zoho_to_tn' | 'tn_to_zoho' | 'bidirectional';
  stock_priority: 'zoho' | 'tiendanube';
  stock_schedule: 'disabled' | 'hourly' | 'every6h' | 'daily';
  prices_schedule: 'disabled' | 'hourly' | 'every6h' | 'daily';
  created_at?: string;
  updated_at?: string;
}

export function useSyncSettings(storeId: string | null) {
  const [settings, setSettings] = useState<SyncSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    try {
      const { data, error } = await api.functions.invoke<{ settings: SyncSettings }>('sync-settings', {
        body: { storeId, action: 'get' },
      });
      if (error) throw error;
      if (data) setSettings(data.settings);
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (patch: Partial<SyncSettings>) => {
    if (!storeId || !settings) return;
    setSaving(true);
    try {
      const merged = { ...settings, ...patch };
      const { data, error } = await api.functions.invoke<{ settings: SyncSettings }>('sync-settings', {
        body: { storeId, action: 'save', settings: merged },
      });
      if (error) throw error;
      if (data) setSettings(data.settings);
    } finally {
      setSaving(false);
    }
  }, [storeId, settings]);

  return { settings, loading, saving, save, reload: load };
}
