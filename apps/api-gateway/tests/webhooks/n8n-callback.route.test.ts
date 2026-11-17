import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// n8n コールバックの組織照合（docs/design/multi-tenancy.md §2.4 E1 / E2、§11.6 SY3）。

const prismaMock = {
  task: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  taskLog: { create: vi.fn() },
  scheduledTask: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));
vi.mock('../../src/services/schedule-dispatcher', () => ({
  claimAndEnqueueScheduledTask: vi.fn(),
  startOfCurrentHourUtc: () => new Date(),
}));

const { webhookRoutes } = await import('../../src/routes/webhooks');

const TOKEN = 'org-ai-n8n-secret-token';

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(webhookRoutes, { prefix: '/api/webhooks' });
  await app.ready();
  return app;
}

function post(app: FastifyInstance, url: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url, headers: { 'x-webhook-token': TOKEN }, payload });
}

const TASK_B = { id: 't-B', orgId: 'org-B', status: 'RUNNING' };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.N8N_CALLBACK_ORG_REQUIRED;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  prismaMock.task.findUnique.mockResolvedValue(TASK_B);
  prismaMock.task.update.mockResolvedValue({ ...TASK_B, status: 'DONE' });
  prismaMock.taskLog.create.mockResolvedValue({ id: 'log-1' });
});
afterEach(() => {
  delete process.env.N8N_CALLBACK_ORG_REQUIRED;
});

describe('POST /n8n/task-complete', () => {
  it('orgId が一致すれば更新する（書き込みにも org 条件が付く）', async () => {
    const app = await build();
    const res = await post(app, '/api/webhooks/n8n/task-complete', { taskId: 't-B', orgId: 'org-B', status: 'DONE' });
    expect(res.statusCode).toBe(200);
    expect(prismaMock.task.update.mock.calls[0][0].where).toEqual({ id: 't-B', orgId: 'org-B' });
    await app.close();
  });

  it('⚠️ orgId が食い違えば 404 で、何も書かない（E1）', async () => {
    const app = await build();
    const res = await post(app, '/api/webhooks/n8n/task-complete', { taskId: 't-B', orgId: 'org-A', status: 'DONE' });
    expect(res.statusCode).toBe(404);
    expect(prismaMock.task.update).not.toHaveBeenCalled();
    expect(prismaMock.taskLog.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('移行期間（既定）: orgId が無ければ警告して通す', async () => {
    const app = await build();
    const res = await post(app, '/api/webhooks/n8n/task-complete', { taskId: 't-B', status: 'DONE' });
    expect(res.statusCode).toBe(200);
    expect(console.warn).toHaveBeenCalled();
    await app.close();
  });

  it('N8N_CALLBACK_ORG_REQUIRED=true: orgId が無ければ 400', async () => {
    process.env.N8N_CALLBACK_ORG_REQUIRED = 'true';
    const app = await build();
    const res = await post(app, '/api/webhooks/n8n/task-complete', { taskId: 't-B', status: 'DONE' });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.task.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('トークンが違えば 401', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/webhooks/n8n/task-complete',
      headers: { 'x-webhook-token': 'nope' }, payload: { taskId: 't-B', orgId: 'org-B', status: 'DONE' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /n8n/task-log', () => {
  it('⚠️ 他組織の Task にはログを足せない', async () => {
    const app = await build();
    const res = await post(app, '/api/webhooks/n8n/task-log', { taskId: 't-B', orgId: 'org-A', message: 'x' });
    expect(res.statusCode).toBe(404);
    expect(prismaMock.taskLog.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('存在しない Task は 404', async () => {
    prismaMock.task.findUnique.mockResolvedValue(null);
    const app = await build();
    const res = await post(app, '/api/webhooks/n8n/task-log', { taskId: 'nope', orgId: 'org-B', message: 'x' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('一致すれば 201', async () => {
    const app = await build();
    const res = await post(app, '/api/webhooks/n8n/task-log', { taskId: 't-B', orgId: 'org-B', message: 'x' });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

describe('GET /n8n/queued-tasks', () => {
  it('⚠️ 全テナント横断なので input を返さない（E2）', async () => {
    prismaMock.task.findMany.mockResolvedValue([{ id: 't-1', orgId: 'org-A', status: 'QUEUED', createdAt: new Date() }]);
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/webhooks/n8n/queued-tasks', headers: { 'x-webhook-token': TOKEN } });
    expect(res.statusCode).toBe(200);
    const select = prismaMock.task.findMany.mock.calls[0][0].select;
    expect(select.input).toBeUndefined();
    expect(Object.keys(select).sort()).toEqual(['createdAt', 'id', 'orgId', 'status']);
    await app.close();
  });
});

describe('POST /n8n/scheduled-job-complete', () => {
  it('⚠️ 他組織の定期タスクは 404 で更新しない', async () => {
    prismaMock.scheduledTask.findUnique.mockResolvedValue({ id: 'st-B', orgId: 'org-B' });
    const app = await build();
    const res = await post(app, '/api/webhooks/n8n/scheduled-job-complete', { scheduledTaskId: 'st-B', orgId: 'org-A', status: 'DONE' });
    expect(res.statusCode).toBe(404);
    expect(prismaMock.scheduledTask.update).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('閲覧のみ（期限切れ・解約済み）の組織の定期ジョブ（saas-review #1）', () => {
  const KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_STARTER_MONTHLY', 'STRIPE_WEBHOOK_SECRET'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_s_m';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const job = (id: string, org: Record<string, unknown>) => ({
    id,
    orgId: `org-${id}`,
    title: 'T',
    department: 'ANALYTICS',
    taskType: 'report',
    input: 'i',
    frequency: 'daily',
    dayOfWeek: null,
    dayOfMonth: null,
    recipientEmail: null,
    org: { plan: 'STARTER', billingEmail: null, ...org },
  });

  it('GET /n8n/scheduled-jobs は閲覧のみの組織のジョブを返さない（n8n が ai-engine を直接呼ばないように）', async () => {
    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 86_400_000);
    prismaMock.scheduledTask.findMany.mockResolvedValue([
      job('ok-legacy', { subscriptionStatus: null, trialEndsAt: null }),
      job('ok-trial', { subscriptionStatus: null, trialEndsAt: future }),
      job('ok-active', { subscriptionStatus: 'active', trialEndsAt: null }),
      job('ng-expired', { subscriptionStatus: null, trialEndsAt: past }),
      job('ng-canceled', { subscriptionStatus: 'canceled', trialEndsAt: null }),
    ]);
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/webhooks/n8n/scheduled-jobs',
      headers: { 'x-webhook-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data as Array<{ id: string }>).map((j) => j.id);
    expect(ids).toEqual(['ok-legacy', 'ok-trial', 'ok-active']);
    await app.close();
  });

  it('POST /n8n/enqueue-scheduled-task は read_only の skip を 200 で返す（n8n に再送させない）', async () => {
    const { claimAndEnqueueScheduledTask } = await import('../../src/services/schedule-dispatcher');
    vi.mocked(claimAndEnqueueScheduledTask).mockResolvedValue({ enqueued: false, reason: 'read_only' });
    const app = await build();
    const res = await post(app, '/api/webhooks/n8n/enqueue-scheduled-task', { scheduledTaskId: 'st-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ skipped: true, reason: 'read_only', scheduledTaskId: 'st-1' });
    await app.close();
  });
});
