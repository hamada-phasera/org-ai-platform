import { describe, it, expect, vi } from 'vitest';
import { JobRegistry, drain, tracked } from '../lifecycle-core';

/** 時間を進められる偽の時計。実時間を待たずに予算切れを試す。 */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('JobRegistry', () => {
  it('開始と終了で在庫が増減する', () => {
    const r = new JobRegistry();
    const a = r.start('file-index', 'f1', 0);
    const b = r.start('receipt', 'm1', 0);
    expect(r.size).toBe(2);
    r.finish(a);
    expect(r.size).toBe(1);
    r.finish(b);
    expect(r.size).toBe(0);
  });

  it('⚠️ 終了処理が始まったら新規を受け付けない', () => {
    // 走らせても途中で殺されるだけで、「中断された」記録が増えるだけになる
    const r = new JobRegistry();
    r.beginShutdown();
    expect(r.start('agent-run', 't1', 0)).toBeNull();
    expect(r.size).toBe(0);
  });

  it('finish(null) は何もしない（開始できなかったときに呼ばれる）', () => {
    const r = new JobRegistry();
    r.start('receipt', 'm1', 0);
    r.finish(null);
    expect(r.size).toBe(1);
  });

  it('種類で絞れる', () => {
    const r = new JobRegistry();
    r.start('agent-run', 't1', 0);
    r.start('file-index', 'f1', 0);
    expect(r.listByKind(['agent-run']).map((j) => j.ref)).toEqual(['t1']);
  });
});

describe('drain', () => {
  it('全部終わっていれば即座に成功する', async () => {
    const r = new JobRegistry();
    const c = fakeClock();
    const res = await drain(r, { budgetMs: 1000, pollMs: 100, now: c.now, sleep: c.sleep });
    expect(res.drained).toBe(true);
    expect(res.remaining).toEqual([]);
  });

  it('終わるまで待つ', async () => {
    const r = new JobRegistry();
    const id = r.start('receipt', 'm1', 0);
    const c = fakeClock();
    // 2回目の確認で終わる
    let polls = 0;
    const sleep = async (ms: number) => {
      c.advance(ms);
      if (++polls === 2) r.finish(id);
    };
    const res = await drain(r, { budgetMs: 5000, pollMs: 100, now: c.now, sleep });
    expect(res.drained).toBe(true);
  });

  it('⚠️ 予算を超えたら諦めて、残りを返す（呼び出し側が印を付けられる）', async () => {
    const r = new JobRegistry();
    r.start('receipt', 'm1', 0);
    const c = fakeClock();
    const res = await drain(r, { budgetMs: 500, pollMs: 100, now: c.now, sleep: c.sleep });
    expect(res.drained).toBe(false);
    expect(res.remaining.map((j) => j.ref)).toEqual(['m1']);
  });

  it('⚠️ 長時間クラスは待たない（猶予を食い潰して全部道連れにしない）', async () => {
    const r = new JobRegistry();
    r.start('agent-run', 't1', 0); // 分単位でかかりうる
    const c = fakeClock();
    const res = await drain(r, {
      budgetMs: 5000, pollMs: 100, now: c.now, sleep: c.sleep,
      skipKinds: ['agent-run'],
    });
    // agent-run は待たない対象なので、待たずに成功として返る
    expect(res.drained).toBe(true);
    expect(res.waitedMs).toBe(0);
  });

  it('待つ対象と待たない対象が混在しても、待つ方だけを見る', async () => {
    const r = new JobRegistry();
    r.start('agent-run', 't1', 0);
    const short = r.start('receipt', 'm1', 0);
    const c = fakeClock();
    let polls = 0;
    const sleep = async (ms: number) => {
      c.advance(ms);
      if (++polls === 1) r.finish(short);
    };
    const res = await drain(r, {
      budgetMs: 5000, pollMs: 100, now: c.now, sleep, skipKinds: ['agent-run'],
    });
    expect(res.drained).toBe(true);
    expect(r.size).toBe(1); // agent-run は残ったまま
  });
});

describe('tracked', () => {
  it('処理が終われば台帳から消える', async () => {
    const r = new JobRegistry();
    let resolve!: () => void;
    const p = new Promise<void>((res) => { resolve = res; });
    tracked('file-index', 'f1', () => p, r);
    expect(r.size).toBe(1);
    resolve();
    await p;
    await new Promise((res) => setTimeout(res, 0));
    expect(r.size).toBe(0);
  });

  it('⚠️ 処理が失敗しても台帳から消える（在庫が漏れて終了が止まらない）', async () => {
    const r = new JobRegistry();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tracked('receipt', 'm1', async () => { throw new Error('boom'); }, r);
    await new Promise((res) => setTimeout(res, 0));
    expect(r.size).toBe(0);
    spy.mockRestore();
  });

  it('終了処理中は開始しない', async () => {
    const r = new JobRegistry();
    r.beginShutdown();
    const run = vi.fn(async () => {});
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tracked('agent-run', 't1', run, r);
    expect(run).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
