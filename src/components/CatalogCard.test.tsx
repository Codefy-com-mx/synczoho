import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogCard } from './CatalogCard';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ api: { functions: { invoke } } }));

describe('CatalogCard', () => {
  beforeEach(() => invoke.mockReset());

  it('muestra el estado y encola una resincronización', async () => {
    invoke.mockResolvedValueOnce({ data: { catalog_status: 'ready', catalog_synced_at: '2026-10-21T10:00:00Z' }, error: null });
    invoke.mockResolvedValueOnce({ data: { catalog_status: 'pending', catalog_synced_at: '2026-10-21T10:00:00Z' }, error: null });

    render(<CatalogCard storeId="store-1" />);
    expect(await screen.findByText('Al día')).toBeInTheDocument();
    expect(invoke.mock.calls[0][1]).toMatchObject({ body: { storeId: 'store-1', action: 'status' } });

    fireEvent.click(screen.getByRole('button', { name: /Resincronizar catálogo/ }));

    expect(await screen.findByText('Preparando')).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke.mock.calls[1][1]).toMatchObject({ body: { storeId: 'store-1', action: 'resync' } });
  });
});
