import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { setTenant } from '../helpers/tenant';

// Google 連携の途中で組織を切り替えた場合に、別の組織へ保存しない（docs/design/multi-tenancy.md §10.2）。

process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csecret';
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.CHANNEL_CREDENTIAL_ENC_KEY = Buffer.alloc(32, 7).toString('hex');

const prismaMock = {
  providerConnection: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
  requiredCredential: { updateMany: vi.fn(async () => ({ count: 0 })) },
  capability: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));
vi.mock('../../src/services/integration-sync', () => ({ syncRequiredCredentialStatus: vi.fn(async () => {}) }));

let currentOrg = 'org-A';
vi.mock('../../src/middleware/auth', () => ({
  requireAdmin: async (req: { user?: unknown }) => {
    await setTenant(req as never, { orgId: currentOrg, sub: 'u-1', role: 'OWNER' } as never);
  },
}));
vi.stubGlobal(
  'fetch',
  vi.fn(async () => new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 })),
);

const { oauthGoogleRoutes } = await import('../../src/routes/oauth-google');

let app: FastifyInstance;
beforeEach(async () => {
  vi.clearAllMocks();
  currentOrg = 'org-A';
  if (!app) {
    app = Fastify();
    await app.register(oauthGoogleRoutes, { prefix: '/api/oauth/google' });
    await app.ready();
  }
});

async function startAndCallback(): Promise<string> {
  const start = await app.inject({ method: 'POST', url: '/api/oauth/google/start' });
  const state = new URL(start.json().data.authUrl).searchParams.get('state')!;
  const cb = await app.inject({ method: 'GET', url: `/api/oauth/google/callback?code=c&state=${encodeURIComponent(state)}` });
  return new URL(cb.headers.location as string).searchParams.get('googleLink')!;
}

describe('POST /api/oauth/google/confirm', () => {
  it('⚠️ 接続を始めた組織と違う組織では確定しない（409 ORG_SWITCHED、どこにも保存しない）', async () => {
    const linkId = await startAndCallback();
    currentOrg = 'org-B';
    const res = await app.inject({ method: 'POST', url: '/api/oauth/google/confirm', payload: { linkId } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORG_SWITCHED');
    expect(prismaMock.providerConnection.upsert).not.toHaveBeenCalled();

    // 元の組織に戻せば同じリンクで確定できる（消費していない）
    currentOrg = 'org-A';
    const ok = await app.inject({ method: 'POST', url: '/api/oauth/google/confirm', payload: { linkId } });
    expect(ok.statusCode).toBe(200);
    const upsert = (prismaMock.providerConnection.upsert.mock.calls[0] as unknown as [{ create: { orgId: string } }])[0];
    expect(upsert.create.orgId).toBe('org-A');
  });
});
