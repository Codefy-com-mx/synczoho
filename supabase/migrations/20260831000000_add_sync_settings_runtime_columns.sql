ALTER TABLE public.sync_settings
  ADD COLUMN IF NOT EXISTS alert_on_error boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS alert_email text,
  ADD COLUMN IF NOT EXISTS stock_schedule text NOT NULL DEFAULT 'disabled',
  ADD COLUMN IF NOT EXISTS prices_schedule text NOT NULL DEFAULT 'disabled';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sync_settings_stock_schedule_check'
      AND conrelid = 'public.sync_settings'::regclass
  ) THEN
    ALTER TABLE public.sync_settings
      ADD CONSTRAINT sync_settings_stock_schedule_check
      CHECK (stock_schedule IN ('disabled', 'hourly', 'every6h', 'daily'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sync_settings_prices_schedule_check'
      AND conrelid = 'public.sync_settings'::regclass
  ) THEN
    ALTER TABLE public.sync_settings
      ADD CONSTRAINT sync_settings_prices_schedule_check
      CHECK (prices_schedule IN ('disabled', 'hourly', 'every6h', 'daily'));
  END IF;
END $$;
