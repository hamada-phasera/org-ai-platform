import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.AI_ENGINE_URL = 'https://ai.test';

const prismaMock = {
  organization: { findUnique: vi.fn() },
  task: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  taskLog: { create: vi.fn() },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));
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

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { snsPostsRoutes } = await import('../../src/routes/sns/posts');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(snsPostsRoutes, { prefix: '/api/sns/posts' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.organization.findUnique.mockResolvedValue({ plan: 'STARTER' });
  prismaMock.task.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'task-1',
    ...data,
  }));
  prismaMock.taskLog.create.mockResolvedValue({ id: 'log-1' });
  prismaMock.task.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'task-1',
    ...data,
  }));
  dispatchMock.mockResolvedValue(undefined);
});

describe('POST /api/sns/posts (下書き生成 N-1・D1: Task/dispatch 化)', () => {
  it('正常系: QUEUED の sns/MARKETING Task を作成して 202 + dispatch に委譲する', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sns/posts',
      payload: { platform: 'twitter', topic: '新サービス告知' },
    });
    expect(res.statusCode).toBe(202);
    const d = res.json().data;
    expect(d.taskId).toBe('task-1');
    expect(d.status).toBe('QUEUED');
    expect(d.platform).toBe('twitter');

    // 保存は QUEUED / taskType=sns / department=MARKETING（PENDING_APPROVAL への遷移は finalize 側）
    const taskData = prismaMock.task.create.mock.calls[0][0].data;
    expect(taskData.status).toBe('QUEUED');
    expect(taskData.taskType).toBe('sns');
    expect(taskData.department).toBe('MARKETING');
    expect(JSON.parse(taskData.input).platform).toBe('twitter');

    // dispatch には json_mode=true / MARKETING 向け spec が渡る
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [task, spec] = dispatchMock.mock.calls[0];
    expect(task.department).toBe('MARKETING');
    expect(spec.taskType).toBe('sns');
    expect(spec.jsonMode).toBe(true);
    expect(spec.systemPrompt).toContain('X (Twitter)');
    expect(spec.userPrompt).toContain('新サービス告知');
    expect(spec.userEmail).toBe('boss@example.com');

    // ルートは直接 LLM/外部を呼ばない
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('エッジ: topic 欠落 → 400（Task も dispatch も作らない）', async () => {
    const app = await build();
    const bad = await app.inject({ method: 'POST', url: '/api/sns/posts', payload: { platform: 'twitter' } });
    expect(bad.statusCode).toBe(400);
    expect(prismaMock.task.create).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /api/sns/posts/queue (N-2 読み取り)', () => {
  it('正常系: PENDING_APPROVAL の sns タスクのみ返す', async () => {
    prismaMock.task.findMany = vi.fn().mockResolvedValue([{ id: 't1', status: 'PENDING_APPROVAL' }]);
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/sns/posts/queue' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    const where = prismaMock.task.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ orgId: 'org-1', taskType: 'sns', status: 'PENDING_APPROVAL' });
    await app.close();
  });
});

describe('POST approve/reject (N-2 状態遷移・自動投稿しない)', () => {
  it('正常系: 承認は APPROVED に遷移し、dispatch/外部呼び出しは一切しない', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      id: 'task-1',
      orgId: 'org-1',
      taskType: 'sns',
      status: 'PENDING_APPROVAL',
    });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/sns/posts/task-1/approve' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('APPROVED');
    // 承認で投稿・実行(dispatch=fetch)が起きないことを保証
    expect(fetchMock).not.toHaveBeenCalled();
    const upd = prismaMock.task.update.mock.calls[0][0].data;
    expect(upd.status).toBe('APPROVED');
    expect(JSON.parse(upd.approvalData).reviewedBy).toBe('user-1');
    await app.close();
  });

  it('正常系: 却下は REJECTED に遷移し reason を保存', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      id: 'task-1',
      orgId: 'org-1',
      taskType: 'sns',
      status: 'PENDING_APPROVAL',
    });
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sns/posts/task-1/reject',
      payload: { reason: 'トーンが合わない' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('REJECTED');
    expect(JSON.parse(prismaMock.task.update.mock.calls[0][0].data.approvalData).reason).toBe('トーンが合わない');
    await app.close();
  });

  it('エッジ: 存在しない/他org/非sns → 404、承認待ちでない → 409', async () => {
    const app = await build();

    prismaMock.task.findUnique.mockResolvedValueOnce(null);
    const nf = await app.inject({ method: 'POST', url: '/api/sns/posts/x/approve' });
    expect(nf.statusCode).toBe(404);

    prismaMock.task.findUnique.mockResolvedValueOnce({
      id: 'task-1',
      orgId: 'org-1',
      taskType: 'sns',
      status: 'APPROVED',
    });
    const conflict = await app.inject({ method: 'POST', url: '/api/sns/posts/task-1/approve' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('INVALID_STATE');

    prismaMock.task.findUnique.mockResolvedValueOnce({
      id: 'task-2',
      orgId: 'org-1',
      taskType: 'proposal',
      status: 'PENDING_APPROVAL',
    });
    const wrongType = await app.inject({ method: 'POST', url: '/api/sns/posts/task-2/approve' });
    expect(wrongType.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /api/sns/posts/calendar (N-3)', () => {
  it('正常系: sns タスクを日付グルーピングして返す', async () => {
    prismaMock.task.findMany.mockResolvedValue([
      { id: 'a', title: 'A', status: 'APPROVED', taskType: 'sns', output: null, createdAt: '2026-07-03T09:00:00+09:00' },
      { id: 'b', title: 'B', status: 'PENDING_APPROVAL', taskType: 'sns', output: null, createdAt: '2026-07-01T09:00:00+09:00' },
    ]);
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/sns/posts/calendar' });
    expect(res.statusCode).toBe(200);
    const days = res.json().data.days;
    expect(days.map((d: { date: string }) => d.date)).toEqual(['2026-07-01', '2026-07-03']);
    // taskType=sns で org スコープ
    expect(prismaMock.task.findMany.mock.calls[0][0].where).toMatchObject({ orgId: 'org-1', taskType: 'sns' });
    await app.close();
  });
});

describe('PATCH /api/sns/posts/:id/schedule (N-3・投稿はしない)', () => {
  it('正常系: scheduledAt カラムに保存し output にも複製する（status は変えない）', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      id: 'task-1',
      orgId: 'org-1',
      taskType: 'sns',
      status: 'APPROVED',
      output: JSON.stringify({ platform: 'twitter', content: '本文', hashtags: [] }),
    });
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sns/posts/task-1/schedule',
      payload: { scheduledAt: '2026-08-01T10:00:00+09:00' },
    });
    expect(res.statusCode).toBe(200);
    const data = prismaMock.task.update.mock.calls[0][0].data;
    expect(data.scheduledAt).toEqual(new Date('2026-08-01T10:00:00+09:00')); // 正式カラム（SNS#S4）
    expect(JSON.parse(data.output).scheduledAt).toBe('2026-08-01T10:00:00+09:00'); // UI 互換の複製
    expect(JSON.parse(data.output).content).toBe('本文'); // 既存フィールドは保持
    expect(data.status).toBeUndefined(); // status は変更しない
    expect(fetchMock).not.toHaveBeenCalled(); // 投稿・実行はしない
    expect(dispatchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('エッジ: 不正な日付 → 400、非sns/不明 → 404', async () => {
    const app = await build();
    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/sns/posts/task-1/schedule',
      payload: { scheduledAt: 'not-a-date' },
    });
    expect(bad.statusCode).toBe(400);

    prismaMock.task.findUnique.mockResolvedValueOnce(null);
    const nf = await app.inject({
      method: 'PATCH',
      url: '/api/sns/posts/x/schedule',
      payload: { scheduledAt: '2026-08-01T10:00:00+09:00' },
    });
    expect(nf.statusCode).toBe(404);
    await app.close();
  });
});
