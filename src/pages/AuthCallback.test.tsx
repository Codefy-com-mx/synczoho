import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuthCallback from './AuthCallback';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke } },
}));

function renderCallback(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/" element={<div>Inicio</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthCallback', () => {
  beforeEach(() => {
    invoke.mockReset();
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('intercambia un código válido una sola vez', async () => {
    invoke.mockResolvedValue({
      data: { success: true, store_id: 123, store_name: 'Demo', store_handle: null },
      error: null,
    });

    renderCallback('/auth/callback?code=valid-code');

    expect(await screen.findByText('¡Conectado!')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('tiendanube-auth', { body: { code: 'valid-code' } });
    expect(localStorage.getItem('tiendanube_store_id')).toBe('123');
  });

  it('rechaza el callback sin código', async () => {
    renderCallback('/auth/callback');

    expect(await screen.findByText('No se recibió código de autorización')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('muestra el error del intercambio', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('Código inválido') });

    renderCallback('/auth/callback?code=bad-code');

    expect(await screen.findByText('Código inválido')).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  });
});
