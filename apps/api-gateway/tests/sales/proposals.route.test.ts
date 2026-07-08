import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.AI_ENGINE_URL = 'https://ai.test';

// prisma は import 時に DATABASE_URL を要求するためモックする。
const prismaMock = {
  organization: { findUnique: vi.fn() },
  aILog: { create: vi.fn() },
  task: { create: vi.fn() },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

// 認証はモックして request.user を注入。
vi.mock('../../src/middleware/auth', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
  requireOwner: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { salesProposalsRoutes } = await import('../../src/routes/sales/proposals');

function llmOk(content = '## エグゼクティブサマリー\n提案です。'): { ok: boolean; status: number; text: () => Promise<string> } {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ content, model: 'claude-sonnet-5', tokens_used: 321, latency_ms: 654, pii_detected: false }),
  };
}

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(salesProposalsRoutes, { prefix: '/api/sales/proposals' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.organization.findUnique.mockResolvedValue({ plan: 'PRO' });
  prismaMock.aILog.create.mockResolvedValue({ id: 'log-1' });
  prismaMock.task.create.mockResolvedValue({ id: 'task-1' });
});

describe('POST /api/sales/proposals', () => {
  it('正常系: 生成→ドラフト返却、AILog記録・Task保存が呼ばれる', async () => {
    fetchMock.mockResolvedValue(llmOk());
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales/proposals',
      payload: { customerName: '株式会社Acme', background: '紙業務が多い', requirements: '自動化したい' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.proposal).toContain('提案です');
    expect(body.data.model).toBe('claude-sonnet-5');
    expect(body.data.taskId).toBe('task-1');

    // /llm/chat 経由で department=SALES を送っている
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/llm/chat');
    expect(JSON.parse(opts.body).department).toBe('SALES');
    expect(JSON.parse(opts.body).json_mode).toBe(false);

    // AILog(必須) と Task(既定保存) が記録される
    expect(prismaMock.aILog.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.aILog.create.mock.calls[0][0].data.department).toBe('SALES');
    expect(prismaMock.task.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.task.create.mock.calls[0][0].data.taskType).toBe('proposal');
    await app.close();
  });

  it('正常系: persist=false なら Task は保存せず AILog は記録する', async () => {
    fetchMock.mockResolvedValue(llmOk());
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales/proposals',
      payload: { customerName: 'A社', persist: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.taskId).toBeNull();
    expect(prismaMock.task.create).not.toHaveBeenCalled();
    expect(prismaMock.aILog.create).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('正常系: AILog記録が失敗しても生成結果は返す(best-effort)', async () => {
    fetchMock.mockResolvedValue(llmOk());
    prismaMock.aILog.create.mockRejectedValue(new Error('db down'));
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales/proposals',
      payload: { customerName: 'A社' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.proposal).toContain('提案です');
    await app.close();
  });

  it('エッジ: customerName 欠落 → 400 VALIDATION_ERROR(LLMは呼ばない)', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/sales/proposals', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('エッジ: 未知の templateId → 400(LLMは呼ばない)', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales/proposals',
      payload: { customerName: 'A社', templateId: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('エッジ: AI Engine 到達不可 → 502 AI_ENGINE_UNAVAILABLE', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales/proposals',
      payload: { customerName: 'A社' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('AI_ENGINE_UNAVAILABLE');
    await app.close();
  });

  it('エッジ: 上流エラー(500) → 502 LLM_UPSTREAM_ERROR', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales/proposals',
      payload: { customerName: 'A社' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('LLM_UPSTREAM_ERROR');
    await app.close();
  });
});

describe('GET /api/sales/proposals/templates', () => {
  it('正常系: 組み込みテンプレート一覧を返す', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/sales/proposals/templates' });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((t: { id: string }) => t.id);
    expect(ids).toContain('standard');
    expect(ids).toContain('short');
    await app.close();
  });
});
