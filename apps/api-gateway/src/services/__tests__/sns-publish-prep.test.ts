import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const prismaMock = {
  task: { findMany: vi.fn(), update: vi.fn() },
  taskLog: { create: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const { prepDueSnsPosts } = await import('../sns-publish-prep');

const NOW = new Date('2026-07-16T10:00:00Z');

function approvedTask(id: string, output: Record<string, unknown> | null) {
  return {
    id,
    orgId: 'org-1',
    taskType: 'sns',
    status: 'APPROVED',
    scheduledAt: new Date('2026-07-16T09:00:00Z'),
    output: output ? JSON.stringify(output) : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.task.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: where.id,
    ...data,
  }));
  prismaMock.taskLog.create.mockResolvedValue({ id: 'log-1' });
});

afterEach(() => {
  delete process.env.SNS_LIVE_POST;
});

describe('prepDueSnsPosts (D2 段階1)', () => {
  it('正常系: APPROVED + scheduledAt 到来の下書きに publishPrep を付与する（実投稿はしない）', async () => {
    prismaMock.task.findMany.mockResolvedValue([
      approvedTask('t1', { platform: 'twitter', content: '本文', hashtags: ['ai'] }),
    ]);
    const result = await prepDueSnsPosts(NOW);

    // 対象クエリ: taskType=sns / APPROVED / scheduledAt <= now
    const where = prismaMock.task.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ taskType: 'sns', status: 'APPROVED' });
    expect(where.scheduledAt.lte).toEqual(NOW);

    expect(result.prepared).toEqual(['t1']);
    const out = JSON.parse(prismaMock.task.update.mock.calls[0][0].data.output);
    expect(out.publishPrep.queued).toBe(true);
    expect(out.publishPrep.livePosted).toBe(false); // 実投稿はしない
    expect(out.publishPrep.preview).toBe('本文\n\n#ai');
    expect(out.content).toBe('本文'); // 既存ドラフトは保持

    // status は書き換えない（APPROVED のまま）・外部 API 呼び出し無し
    expect(prismaMock.task.update.mock.calls[0][0].data.status).toBeUndefined();
  });

  it('冪等: 既に publishPrep 済みの下書きはスキップする', async () => {
    prismaMock.task.findMany.mockResolvedValue([
      approvedTask('t1', { platform: 'twitter', content: 'x', hashtags: [], publishPrep: { queued: true } }),
    ]);
    const result = await prepDueSnsPosts(NOW);
    expect(result.prepared).toEqual([]);
    expect(result.alreadyPrepared).toEqual(['t1']);
    expect(prismaMock.task.update).not.toHaveBeenCalled();
  });

  it('SNS_LIVE_POST=true でも投稿せず WARN ログを残す（段階2は未解放）', async () => {
    process.env.SNS_LIVE_POST = 'true';
    prismaMock.task.findMany.mockResolvedValue([
      approvedTask('t1', { platform: 'twitter', content: 'x', hashtags: [] }),
    ]);
    const result = await prepDueSnsPosts(NOW);
    expect(result.prepared).toEqual(['t1']);
    const warns = prismaMock.taskLog.create.mock.calls.filter((c) => c[0].data.level === 'WARN');
    expect(warns).toHaveLength(1);
    expect(warns[0][0].data.message).toContain('シミュレーション');
    const out = JSON.parse(prismaMock.task.update.mock.calls[0][0].data.output);
    expect(out.publishPrep.livePosted).toBe(false);
  });

  it('エッジ: output が壊れていても落ちずに publishPrep を付与する', async () => {
    prismaMock.task.findMany.mockResolvedValue([{ ...approvedTask('t1', null), output: '{{not json' }]);
    const result = await prepDueSnsPosts(NOW);
    expect(result.prepared).toEqual(['t1']);
    const out = JSON.parse(prismaMock.task.update.mock.calls[0][0].data.output);
    expect(out.publishPrep.queued).toBe(true);
    expect(out.publishPrep.preview).toBe('');
  });
});
