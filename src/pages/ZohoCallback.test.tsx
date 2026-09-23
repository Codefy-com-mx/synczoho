import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ZohoCallback from './ZohoCallback';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  api: { functions: { invoke } },
}));

function renderCallback(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ZohoCallback />
    </MemoryRouter>,
  );
}

describe('ZohoCallback', () => {
  beforeEach(() => {
    invoke.mockReset();
    localStorage.clear();
  });

  it('acepta una conexión directa', async () => {
    invoke.mockResolvedValue({ data: { step: 'connected' }, error: null });

    renderCallback('/zoho/callback?code=code-1&state=state-1');

    expect(await screen.findByText('¡Zoho conectado!')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('guarda la organización seleccionada', async () => {
    invoke
      .mockResolvedValueOnce({
        data: {
          step: 'select_organization',
          organizations: [{ organization_id: 'org-1', name: 'Organización Demo' }],
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { step: 'connected' }, error: null });

    renderCallback('/zoho/callback?code=code-1&state=state-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar organización' }));

    expect(await screen.findByText('¡Zoho conectado!')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toMatchObject({
      body: {
        state: 'state-1',
        organization_id: 'org-1',
      },
    });
  });

  it('muestra errores OAuth sin invocar la función', async () => {
    renderCallback('/zoho/callback?error=access_denied');

    expect(await screen.findByText('access_denied')).toBeInTheDocument();
    await waitFor(() => expect(invoke).not.toHaveBeenCalled());
  });
});
