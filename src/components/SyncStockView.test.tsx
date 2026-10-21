import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncStockView } from './SyncStockView';

const { invoke, toastSuccess, toastInfo, toastError } = vi.hoisted(() => ({
  invoke: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: { functions: { invoke } },
}));

vi.mock('sonner', () => ({
  toast: { success: toastSuccess, info: toastInfo, error: toastError },
}));

const settings = {
  store_id: 'store-1',
  stock_enabled: true,
  stock_direction: 'zoho_to_tn',
  stock_priority: 'zoho',
  stock_schedule: 'disabled',
  prices_enabled: false,
  prices_schedule: 'disabled',
};

function mockInvoke(runResponse: unknown, current: Record<string, unknown> = settings): void {
  invoke.mockImplementation(async (name: string, { body }: any) => {
    if (name === 'sync-settings') {
      return { data: { settings: body.action === 'save' ? body.settings : current }, error: null };
    }
    if (name === 'sync-stock-run' || name === 'sync-prices-run') return { data: runResponse, error: null };
    throw new Error(`Unexpected function: ${name}`);
  });
}

async function startSync(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Sincronizar ahora/ }));
  const confirm = await screen.findByRole('button', { name: 'Sí, sincronizar' });
  await act(async () => {
    fireEvent.click(confirm);
  });
}

beforeEach(() => {
  invoke.mockReset();
  toastSuccess.mockReset();
  toastInfo.mockReset();
  toastError.mockReset();
  // The component clears its progress bar with an 800ms timer; fake timers
  // keep that update inside the test instead of leaking an act() warning.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('SyncStockView manual run', () => {
  it('reports an already-running run as informational instead of success', async () => {
    mockInvoke({ skipped: true, reason: 'already_running' });

    const { container } = render(<SyncStockView storeId="store-1" />);
    await act(async () => {});
    await startSync();

    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    expect(toastInfo).toHaveBeenCalledWith(expect.stringContaining('en curso'));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Actualizados:');
    expect(invoke).toHaveBeenCalledWith('sync-stock-run', { body: { storeId: 'store-1' } });
  });

  it('explains a pending catalog on the stock run instead of claiming a run is in progress', async () => {
    mockInvoke({ skipped: true, reason: 'catalog_not_ready' });

    render(<SyncStockView storeId="store-1" />);
    await act(async () => {});
    await startSync();

    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    expect(toastInfo).toHaveBeenCalledWith(expect.stringContaining('catálogo de Tiendanube'));
    expect(toastInfo).not.toHaveBeenCalledWith(expect.stringContaining('en curso'));
  });

  it('keeps the completed result for a real run', async () => {
    mockInvoke({ dry_run: false, total: 3, updated: 2, inSync: 1, errors: 0, unmatched: 0, details: [] });

    const { container } = render(<SyncStockView storeId="store-1" />);
    await act(async () => {});
    await startSync();

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastInfo).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Actualizados: 2');
  });
});

describe('SyncStockView automatic sync and prices', () => {
  const savedSettings = () => invoke.mock.calls
    .filter(([name, { body }]) => name === 'sync-settings' && body.action === 'save')
    .map(([, { body }]) => body.settings);

  it('lets the merchant schedule the stock sync', async () => {
    mockInvoke({});
    render(<SyncStockView storeId="store-1" />);
    await act(async () => {});

    const schedule = await screen.findByLabelText('Sincronización automática de stock');
    await act(async () => {
      fireEvent.change(schedule, { target: { value: 'every6h' } });
    });

    expect(savedSettings().at(-1)).toMatchObject({ stock_schedule: 'every6h' });
  });

  it('lets the merchant turn on and schedule the price sync', async () => {
    mockInvoke({});
    render(<SyncStockView storeId="store-1" />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(await screen.findByLabelText('Actualizar precios desde Zoho'));
    });
    expect(savedSettings().at(-1)).toMatchObject({ prices_enabled: true });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Sincronización automática de precios'), { target: { value: 'daily' } });
    });
    expect(savedSettings().at(-1)).toMatchObject({ prices_enabled: true, prices_schedule: 'daily' });
  });

  it('lets the merchant choose the price direction and blocks the manual Zoho → Tiendanube run otherwise', async () => {
    mockInvoke({}, { ...settings, prices_enabled: true, prices_direction: 'zoho_to_tn' });
    render(<SyncStockView storeId="store-1" />);
    await act(async () => {});

    expect(screen.getByRole('button', { name: /Sincronizar precios/ })).not.toBeDisabled();
    await act(async () => {
      fireEvent.change(await screen.findByLabelText('Dirección de precios'), { target: { value: 'tn_to_zoho' } });
    });

    expect(savedSettings().at(-1)).toMatchObject({ prices_direction: 'tn_to_zoho' });
    expect(screen.getByRole('button', { name: /Sincronizar precios/ })).toBeDisabled();
    expect(screen.getByLabelText('Sincronización automática de precios')).toBeDisabled();
  });

  const clickPrices = async () => {
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Sincronizar precios/ }));
    });
  };

  it('explains a pending catalog on the price run instead of claiming a run is in progress', async () => {
    mockInvoke({ skipped: true, reason: 'catalog_not_ready' }, { ...settings, prices_enabled: true });
    render(<SyncStockView storeId="store-1" />);
    await act(async () => {});
    await clickPrices();

    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    expect(toastInfo).toHaveBeenCalledWith(expect.stringContaining('catálogo de Tiendanube'));
    expect(toastInfo).not.toHaveBeenCalledWith(expect.stringContaining('en curso'));
  });

  it('keeps the in-progress message when the price run is already running', async () => {
    mockInvoke({ skipped: true, reason: 'already_running' }, { ...settings, prices_enabled: true });
    render(<SyncStockView storeId="store-1" />);
    await act(async () => {});
    await clickPrices();

    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith(expect.stringContaining('en curso')));
  });

  it('runs the price sync on demand when prices are enabled', async () => {
    mockInvoke({ dry_run: false, total: 2, updated: 1, in_sync: 1, errors: 0 }, { ...settings, prices_enabled: true });
    render(<SyncStockView storeId="store-1" />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Sincronizar precios/ }));
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sync-prices-run', { body: { storeId: 'store-1' } }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('1 actualizados')));
  });
});
