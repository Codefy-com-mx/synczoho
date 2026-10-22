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

  it('carga al montar y guarda el vínculo al cambiar el select', async () => {
    invoke.mockResolvedValueOnce({
      data: { mappings: [row(null), { ...row(null), tn_location_id: 'B', tn_location_name: 'Filial' }], tn_available: true, zoho_available: true, zoho_locations },
      error: null,
    });
    invoke.mockResolvedValueOnce({
      data: { mappings: [row('z2')], tn_available: true, zoho_available: true, zoho_locations }, error: null,
    });
    const { container } = render(<LocationMappingsCard storeId="s1" />);
    expect(await screen.findByText('Central')).toBeInTheDocument();
    expect(invoke.mock.calls[0][1]).toMatchObject({ body: { storeId: 's1', action: 'get' } });

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

  it('muestra un vínculo guardado que Zoho no devuelve como "no disponible", no como Sin vincular', async () => {
    invoke.mockResolvedValueOnce({
      data: { mappings: [row('z9')], tn_available: true, zoho_available: false, zoho_locations: [] }, error: null,
    });
    const { container } = render(<LocationMappingsCard storeId="s1" />);
    await screen.findByText('Central');
    const select = container.querySelector('select[name="loc-A"]') as HTMLSelectElement;
    expect(select.value).toBe('z9');
    expect(screen.getByRole('option', { name: 'Bodega (no disponible)' })).toBeInTheDocument();
  });

  describe('stock total de Zoho', () => {
    const two = (a: string | null, b: string | null, zl = [] as typeof zoho_locations) => ({
      data: {
        mappings: [row(a), { ...row(b), tn_location_id: 'B', tn_location_name: 'Filial' }],
        tn_available: true, zoho_available: zl.length > 0, zoho_locations: zl,
      },
      error: null,
    });
    const TOTAL = 'Stock total de Zoho (esta ubicación)';

    it('ofrece la opción de total solo cuando Zoho no tiene locations y hay 2+ en Tiendanube', async () => {
      invoke.mockResolvedValueOnce(two(null, null));
      const { container, unmount } = render(<LocationMappingsCard storeId="s1" />);
      await screen.findByText('Central');
      expect(container.querySelectorAll(`option[value="__total__"]`)).toHaveLength(2);
      unmount();

      invoke.mockResolvedValueOnce(two(null, null, zoho_locations));
      render(<LocationMappingsCard storeId="s1" />);
      await screen.findByText('Central');
      expect(screen.queryByRole('option', { name: TOTAL })).not.toBeInTheDocument();
    });

    it('un vínculo guardado al total se muestra como esa opción y la deshabilita en las otras filas', async () => {
      invoke.mockResolvedValueOnce(two(null, '__total__'));
      const { container } = render(<LocationMappingsCard storeId="s1" />);
      await screen.findByText('Central');
      const b = container.querySelector('select[name="loc-B"]') as HTMLSelectElement;
      expect(b.value).toBe('__total__');
      expect(screen.queryByText(/no disponible/)).not.toBeInTheDocument();
      const aOpt = container.querySelector('select[name="loc-A"] option[value="__total__"]') as HTMLOptionElement;
      expect(aOpt.disabled).toBe(true);
      expect((b.querySelector('option[value="__total__"]') as HTMLOptionElement).disabled).toBe(false);
    });

    it('un total guardado con Zoho ya con locations tampoco dice "no disponible"', async () => {
      invoke.mockResolvedValueOnce(two('__total__', null, zoho_locations));
      const { container } = render(<LocationMappingsCard storeId="s1" />);
      await screen.findByText('Central');
      expect((container.querySelector('select[name="loc-A"]') as HTMLSelectElement).value).toBe('__total__');
      expect(screen.queryByText(/no disponible/)).not.toBeInTheDocument();
    });
  });
});
