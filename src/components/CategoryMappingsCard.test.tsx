import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryMappingsCard } from './CategoryMappingsCard';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke } },
}));

describe('CategoryMappingsCard', () => {
  beforeEach(() => invoke.mockReset());

  it('carga, guarda y elimina un mapeo', async () => {
    invoke.mockResolvedValue({ data: { ok: true }, error: null });
    invoke.mockResolvedValueOnce({
      data: {
        zohoCategories: [{ id: 'z1', name: 'Playeras' }],
        tnCategories: [{ id: 10, name: 'Ropa', depth: 0 }],
        mappings: [],
      },
      error: null,
    });

    const { container } = render(<CategoryMappingsCard storeId="store-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cargar categorías' }));

    expect(await screen.findByText('Playeras')).toBeInTheDocument();
    const select = container.querySelector('select[name="tn-cat-z1"]');
    expect(select).not.toBeNull();
    fireEvent.change(select!, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke.mock.calls[1][1]).toMatchObject({
      body: {
        storeId: 'store-1',
        action: 'save',
        zohoCategory: 'Playeras',
        tnCategoryId: 10,
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Eliminar mapeo Playeras' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect(invoke.mock.calls[2][1]).toMatchObject({
      body: { storeId: 'store-1', action: 'delete', zohoCategory: 'Playeras' },
    });
  });
});
