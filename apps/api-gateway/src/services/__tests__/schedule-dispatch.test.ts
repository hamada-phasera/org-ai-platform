import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = {
  scheduledTask: { updateMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
  agent: { findUnique: vi.fn() },
  task: { create: vi.fn() },
  taskLog: { create: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const dispatchQueuedTaskMock = vi.fn();
const dispatchAgentTaskMock = vi.fn();
vi.mock('../task-executor', () => ({
  dispatchQueuedTask: dispatchQueuedTaskMock,
  dispatchAgentTask: dispatchAgentTaskMock,
}));

const runAgentTaskMock = vi.fn();
vi.mock('../step-runner', () => ({ runAgentTask: runAgentTaskMock }));

const { startOfCurrentHourUtc, matchesSchedule, claimAndEnqueueScheduledTask, enqueueDueScheduledTasks } =
  await import('../schedule-dispatcher');

const ST = {
  id: 'st1',
  orgId: 'org-1',
  title: '日報',
  department: 'ANALYTICS',
  taskType: 'report',
  input: '今日の売上をまとめて',
  frequency: 'daily',
  hourUtc: 0,
  dayOfWeek: null,
  dayOfMonth: null,
  enabled: true,
  agentId: null as string | null,
};

const AGENT = {
  id: 'A1',
  orgId: 'org-1',
  name: '日報エージェント',
  instructions: 'まとめて',
  department: 'ANALYTICS',
  createdBy: 'u1',
  enabled: true,
  steps: null as unknown,
  webhookPath: 'agent-A1',
  n8nStatus: 'ACTIVE',
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.task.create.mockResolvedValue({ id: 't1', orgId: 'org-1', title: 'T', input: 'i', department: 'ANALYTICS' });
  prismaMock.taskLog.create.mockResolvedValue({ id: 'l' });
});

describe('startOfCurrentHourUtc', () => {
  it('分・秒・ミリ秒を切り捨てる', () => {
    const d = startOfCurrentHourUtc(new Date('2026-09-10T05:37:21.123Z'));
    expect(d.toISOString()).toBe('2026-09-10T05:00:00.000Z');
  });
});

describe('matchesSchedule', () => {
  const wed = new Date('2026-09-09T00:00:00Z'); // 水曜 (getUTCDay=3), 9日
  it('daily は常に一致', () => {
    expect(matchesSchedule({ frequency: 'daily', dayOfWeek: null, dayOfMonth: null }, wed)).toBe(true);
  });
  it('weekly は曜日一致のときだけ', () => {
    expect(matchesSchedule({ frequency: 'weekly', dayOfWeek: 3, dayOfMonth: null }, wed)).toBe(true);
    expect(matchesSchedule({ frequency: 'weekly', dayOfWeek: 4, dayOfMonth: null }, wed)).toBe(false);
  });
  it('monthly は日付一致のときだけ', () => {
    expect(matchesSchedule({ frequency: 'monthly', dayOfWeek: null, dayOfMonth: 9 }, wed)).toBe(true);
    expect(matchesSchedule({ frequency: 'monthly', dayOfWeek: null, dayOfMonth: 10 }, wed)).toBe(false);
  });
  it('未知の frequency は実行しない', () => {
    expect(matchesSchedule({ frequency: 'hourly', dayOfWeek: null, dayOfMonth: null }, wed)).toBe(false);
  });
});

describe('claimAndEnqueueScheduledTask（二重発火防止）', () => {
  it('claim できなければ Task を作らず skip（同一時間帯の2回目）', async () => {
    prismaMock.scheduledTask.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.scheduledTask.findUnique.mockResolvedValue({ id: 'st1' });

    const r = await claimAndEnqueueScheduledTask('st1');

    expect(r).toEqual({ enqueued: false, reason: 'already_ran' });
    expect(prismaMock.task.create).not.toHaveBeenCalled();
  });

  it('claim の where に lastRunAt 条件が入っている（原子性の担保）', async () => {
    prismaMock.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.scheduledTask.findUnique.mockResolvedValue(ST);

    await claimAndEnqueueScheduledTask('st1', new Date('2026-09-10T05:30:00Z'));

    const where = prismaMock.scheduledTask.updateMany.mock.calls[0][0].where;
    expect(where.enabled).toBe(true);
    expect(where.OR).toEqual([
      { lastRunAt: null },
      { lastRunAt: { lt: new Date('2026-09-10T05:00:00.000Z') } },
    ]);
  });

  it('agentId 無し → 従来の部署ワークフロー実行', async () => {
    prismaMock.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.scheduledTask.findUnique.mockResolvedValue(ST);

    const r = await claimAndEnqueueScheduledTask('st1');

    expect(r.enqueued).toBe(true);
    expect(dispatchQueuedTaskMock).toHaveBeenCalledTimes(1);
    expect(runAgentTaskMock).not.toHaveBeenCalled();
  });

  it('agentId あり + steps あり → step-runner で実行', async () => {
    prismaMock.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.scheduledTask.findUnique.mockResolvedValue({ ...ST, agentId: 'A1' });
    prismaMock.agent.findUnique.mockResolvedValue({
      ...AGENT,
      steps: [{ capabilityName: 'create_google_doc', argTemplate: { title: 'T', content: '{{input}}' } }],
    });

    await claimAndEnqueueScheduledTask('st1');

    expect(runAgentTaskMock).toHaveBeenCalledTimes(1);
    expect(runAgentTaskMock.mock.calls[0][1].steps).toHaveLength(1);
    expect(dispatchQueuedTaskMock).not.toHaveBeenCalled();
  });

  it('agentId あり + steps 無し → instructions を効かせた単発実行（従来のギャップ修正）', async () => {
    prismaMock.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.scheduledTask.findUnique.mockResolvedValue({ ...ST, agentId: 'A1' });
    prismaMock.agent.findUnique.mockResolvedValue(AGENT);

    await claimAndEnqueueScheduledTask('st1');

    expect(dispatchAgentTaskMock).toHaveBeenCalledTimes(1);
    expect(dispatchAgentTaskMock.mock.calls[0][1].instructions).toBe('まとめて');
    expect(dispatchQueuedTaskMock).not.toHaveBeenCalled();
  });

  it('エージェントが削除済み/無効なら Task を作らない', async () => {
    prismaMock.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.scheduledTask.findUnique.mockResolvedValue({ ...ST, agentId: 'A1' });
    prismaMock.agent.findUnique.mockResolvedValue(null);

    const r = await claimAndEnqueueScheduledTask('st1');

    expect(r).toEqual({ enqueued: false, reason: 'agent_gone' });
    expect(prismaMock.task.create).not.toHaveBeenCalled();
  });
});

describe('enqueueDueScheduledTasks', () => {
  it('曜日が合わない weekly は claim すらしない', async () => {
    // 2026-09-09 は水曜 (3)
    prismaMock.scheduledTask.findMany.mockResolvedValue([
      { id: 'st-w', frequency: 'weekly', dayOfWeek: 5, dayOfMonth: null },
      { id: 'st-d', frequency: 'daily', dayOfWeek: null, dayOfMonth: null },
    ]);
    prismaMock.scheduledTask.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.scheduledTask.findUnique.mockResolvedValue(ST);

    const n = await enqueueDueScheduledTasks(new Date('2026-09-09T00:00:00Z'));

    expect(n).toBe(1);
    expect(prismaMock.scheduledTask.updateMany).toHaveBeenCalledTimes(1);
  });
});
