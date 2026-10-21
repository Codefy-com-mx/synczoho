import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationMappingsCard } from './LocationMappingsCard';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { functions: { invoke } } }));

const row = (zoho: string | null) => ({
  tn_location_id: 'A', tn_location_name: 'Central', zoho_location_id: zoho, zoho_location_name: zoho && 'Bodega',
});
const zoho_locations = [{ id: 'z1', name: 'Bodega' }, { id: 'z2', name: 'Otra' }];

describe('LocationMappingsCard', () => {
  beforeEach(() => invoke.mockReset());

  it('refresca al montar y guarda el vínculo al cambiar el select', async () => {
    invoke.mockResolvedValueOnce({
      data: { mappings: [row(null), { ...row(null), tn_location_id: 'B', tn_location_name: 'Filial' }], tn_available: true, zoho_available: true, zoho_locations },
      error: null,
    });
    invoke.mockResolvedValueOnce({
      data: { mappings: [row('z2')], tn_available: true, zoho_available: true, zoho_locations }, error: null,
    });
    const { container } = render(<LocationMappingsCard storeId="s1" />);
    expect(await screen.findByText('Central')).toBeInTheDocument();
    expect(invoke.mock.calls[0][1]).toMatchObject({ body: { storeId: 's1', action: 'refresh' } });

    fireEvent.change(container.querySelector('select[name="loc-A"]')!, { target: { value: 'z2' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke.mock.calls[1][1]).toMatchObject({
      body: { storeId: 's1', action: 'save', mappings: [{ tn_location_id: 'A', zoho_location_id: 'z2' }] },
    });
  });

  it('avisa cuando falta el scope de Tiendanube', async () => {
    invoke.mockResolvedValueOnce({ data: { mappings: [], tn_available: false, zoho_available: false, zoho_locations: [] }, error: null });
    render(<LocationMappingsCard storeId="s1" />);
    expect(await screen.findByText(/Reautoriza la app para leer las locations de Tiendanube/)).toBeInTheDocument();
  });

  it('informa cuando hay una sola location y Zoho no usa varias', async () => {
    invoke.mockResolvedValueOnce({ data: { mappings: [row(null)], tn_available: true, zoho_available: false, zoho_locations: [] }, error: null });
    render(<LocationMappingsCard storeId="s1" />);
    expect(await screen.findByText(/no usa varias ubicaciones/)).toBeInTheDocument();
  });
});
