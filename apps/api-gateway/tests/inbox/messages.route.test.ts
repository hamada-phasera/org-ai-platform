import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// 承認送信で使う LINE 接続が同じ組織のものかを照合する（docs/design/multi-tenancy.md E7）。

const prismaMock = {
  inboundMessage: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  channelConnection: { findUnique: vi.fn(), update: vi.fn() },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));
vi.mock('../../src/middleware/auth', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-A', sub: 'u-a', role: 'OWNER' };
  },
}));
const sendReply = vi.fn();
vi.mock('../../src/services/inbox/adapter', () => ({ getChannelAdapter: () => ({ sendReply }) }));
vi.mock('../../src/services/inbox/draft-generator', () => ({ generateInboxDraft: vi.fn() }));

const { inboxMessagesRoutes } = await import('../../src/routes/inbox/messages');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(inboxMessagesRoutes, { prefix: '/api/inbox/messages' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.inboundMessage.findUnique.mockResolvedValue({
    id: 'm-1', orgId: 'org-A', status: 'DRAFTED', connectionId: 'c-1', provider: 'line',
  });
});

describe('POST /api/inbox/messages/:id/approve', () => {
  it('⚠️ 接続が別組織のものなら送信しない（E7）', async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValue({ id: 'c-1', orgId: 'org-B' });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/inbox/messages/m-1/approve', payload: { replyText: 'はい' } });
    expect(res.statusCode).toBe(409);
    expect(sendReply).not.toHaveBeenCalled();
    expect(prismaMock.channelConnection.findUnique.mock.calls[0][0].where).toEqual({ id: 'c-1', orgId: 'org-A' });
    await app.close();
  });

  it('同じ組織の接続なら送信する', async () => {
    prismaMock.channelConnection.findUnique.mockResolvedValue({ id: 'c-1', orgId: 'org-A', pushCountMonth: null });
    sendReply.mockResolvedValue({ ok: true });
    prismaMock.inboundMessage.update.mockResolvedValue({ id: 'm-1', status: 'SENT' });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/inbox/messages/m-1/approve', payload: { replyText: 'はい' } });
    expect(res.statusCode).toBe(200);
    expect(sendReply).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
