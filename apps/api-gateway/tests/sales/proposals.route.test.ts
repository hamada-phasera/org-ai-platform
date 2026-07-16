import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.AI_ENGINE_URL = 'https://ai.test';

// prisma は import 時に DATABASE_URL を要求するためモックする。
const prismaMock = {
  task: { create: vi.fn() },
  taskLog: { create: vi.fn() },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

// 認証はモックして request.user を注入。
vi.mock('../../src/middleware/auth', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER', email: 'boss@example.com' };
  },
  requireOwner: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER', email: 'boss@example.com' };
  },
}));

// D1: 生成は dispatchGenerationTask（n8n加速+AI Engineフォールバック）に委譲される。
const dispatchMock = vi.fn();
vi.mock('../../src/services/generation-dispatch', () => ({
  dispatchGenerationTask: dispatchMock,
}));

const { salesProposalsRoutes } = await import('../../src/routes/sales/proposals');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(salesProposalsRoutes, { prefix: '/api/sales/proposals' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.task.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'task-1',
    ...data,
  }));
  prismaMock.taskLog.create.mockResolvedValue({ id: 'log-1' });
  dispatchMock.mockResolvedValue(undefined);
});

describe('POST /api/sales/proposals (D1: Task/dispatch 化)', () => {
  it('正常系: QUEUED Task を作成して 202 + dispatch に委譲する', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales/proposals',
      payload: { customerName: '株式会社Acme', background: '紙業務が多い', requirements: '自動化したい' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.taskId).toBe('task-1');
    expect(body.data.status).toBe('QUEUED');
    expect(body.data.templateId).toBe('standard');

    // Task は QUEUED / SALES / taskType=proposal で作成される
    const taskData = prismaMock.task.create.mock.calls[0][0].data;
    expect(taskData.status).toBe('QUEUED');
    expect(taskData.department).toBe('SALES');
    expect(taskData.taskType).toBe('proposal');
    expect(JSON.parse(taskData.input).customerName).toBe('株式会社Acme');
    expect(JSON.parse(taskData.input).templateId).toBe('standard');

    // dispatch には system/user プロンプトと松竹梅ルーティング用 email が渡る
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [task, spec] = dispatchMock.mock.calls[0];
    expect(task.id).toBe('task-1');
    expect(spec.taskType).toBe('proposal');
    expect(spec.jsonMode).toBe(false);
    expect(spec.systemPrompt).toContain('株式会社Acme');
    expect(spec.userPrompt).toContain('紙業務が多い');
    expect(spec.userEmail).toBe('boss@example.com');
    await app.close();
  });

  it('エッジ: customerName 欠落 → 400 VALIDATION_ERROR(Task も dispatch も作らない)', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/sales/proposals', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(prismaMock.task.create).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('エッジ: 未知の templateId → 400(Task も dispatch も作らない)', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales/proposals',
      payload: { customerName: 'A社', templateId: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(prismaMock.task.create).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('エッジ: dispatch が失敗しても 202 は返る（実行系のエラーは Task/TaskLog 側で記録）', async () => {
    dispatchMock.mockRejectedValue(new Error('n8n down'));
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales/proposals',
      payload: { customerName: 'A社' },
    });
    expect(res.statusCode).toBe(202);
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
