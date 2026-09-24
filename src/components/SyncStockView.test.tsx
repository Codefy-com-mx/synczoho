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
};

function mockInvoke(runResponse: unknown): void {
  invoke.mockImplementation(async (name: string) => {
    if (name === 'sync-settings') return { data: { settings }, error: null };
    if (name === 'sync-stock-run') return { data: runResponse, error: null };
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
