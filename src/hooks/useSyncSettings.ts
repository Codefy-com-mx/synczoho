import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';

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

type SyncSettingsRow = Database['public']['Tables']['sync_settings']['Row'];

export type SyncSettings = Omit<
  SyncSettingsRow,
  | 'products_match_strategy'
  | 'products_sync_fields'
  | 'stock_direction'
  | 'stock_priority'
  | 'stock_schedule'
  | 'prices_schedule'
> & {
  products_match_strategy: 'sku' | 'name';
  products_sync_fields: ProductSyncFields;
  stock_direction: 'zoho_to_tn' | 'tn_to_zoho' | 'bidirectional';
  stock_priority: 'zoho' | 'tiendanube';
  stock_schedule: 'disabled' | 'hourly' | 'every6h' | 'daily';
  prices_schedule: 'disabled' | 'hourly' | 'every6h' | 'daily';
};

export function useSyncSettings(storeId: string | null) {
  const [settings, setSettings] = useState<SyncSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('sync-settings', {
        body: { storeId, action: 'get' },
      });
      if (error) throw error;
      setSettings(data.settings);
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
      const { data, error } = await supabase.functions.invoke('sync-settings', {
        body: { storeId, action: 'save', settings: merged },
      });
      if (error) throw error;
      setSettings(data.settings);
    } finally {
      setSaving(false);
    }
  }, [storeId, settings]);

  return { settings, loading, saving, save, reload: load };
}
