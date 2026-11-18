// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CustomPagesNav } from '../CustomPagesNav';
import { install, ok, setRoutes, signIn, uninstall } from './harness';

function renderNav() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <nav>
          <CustomPagesNav linkClass={() => 'x'} />
        </nav>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  install();
  signIn('ADMIN');
});
afterEach(() => {
  cleanup();
  uninstall();
});

describe('サイドバーの業務ページ', () => {
  it('サーバの順に並び、下書きには「下書き」', async () => {
    setRoutes({
      'GET /pages': ok([
        { slug: 'inquiries', title: '問い合わせ', icon: 'inbox', status: 'PUBLISHED' },
        { slug: 'daily', title: '日報', icon: 'unknown-icon', status: 'DRAFT' },
      ]),
    });
    renderNav();
    const links = await screen.findAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/p/inquiries', '/p/daily']);
    expect(links[0].textContent).toBe('問い合わせ');
    expect(links[1].textContent).toBe('日報下書き');
  });

  it('0 件なら何も足さない', async () => {
    setRoutes({ 'GET /pages': ok([]) });
    const { container } = renderNav();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('nav')?.children.length).toBe(0);
  });
});
