import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../../utils/prisma', () => ({ prisma: {} }));

// データノードのタイムアウト（レビュー指摘 7）。読み取りだけ打ち切り、書き込みは結果を待つ
// （Promise.race では DB の書き込みは止まらないので、遅れて成功したのに FAILED にしない）。DB は使わない。

const runDataRequest = vi.fn();
vi.mock('../data-resources', async (orig) => ({ ...(await orig<typeof import('../data-resources')>()), runDataRequest }));

const { runDataNode, dataNodeTuning } = await import('../nodes/data');
import type { NodeRunContext } from '../nodes/types';

const later = <T>(v: T, ms: number) => new Promise<T>((r) => setTimeout(() => r(v), ms));

function ctx(op: 'create' | 'list'): NodeRunContext {
  return {
    db: {} as NodeRunContext['db'],
    run: { id: 'r1', orgId: 'org-A', actorId: 'u1', input: {} },
    plan: 'STARTER',
    scope: {} as NodeRunContext['scope'],
    node: {
      id: 'd', type: 'data', label: 'データ',
      config: op === 'create' ? { resource: 'deal', op, values: { title: 'x' } } : { resource: 'deal', op, limit: 5 },
    } as NodeRunContext['node'],
  };
}

beforeEach(() => {
  runDataRequest.mockReset();
  dataNodeTuning.readTimeoutMs = 10;
});

describe('データノードのタイムアウト', () => {
  it('書き込みは時間を過ぎても打ち切らず、成功を返す（二重に作らせない）', async () => {
    runDataRequest.mockImplementation(() => later({ id: 'deal-1', title: 'x' }, 40));
    const res = await runDataNode(ctx('create'));
    expect(res).toMatchObject({ ok: true, output: { id: 'deal-1' }, attempts: 1 });
    expect(runDataRequest).toHaveBeenCalledTimes(1);
  });

  it('読み取りは打ち切って 1 回やり直し、だめなら TIMEOUT', async () => {
    runDataRequest.mockImplementation(() => later({ rows: [], count: 0 }, 40));
    const res = await runDataNode(ctx('list'));
    expect(res).toMatchObject({ ok: false, error: { code: 'TIMEOUT' }, attempts: 2 });
    expect(runDataRequest).toHaveBeenCalledTimes(2);
  });
});
