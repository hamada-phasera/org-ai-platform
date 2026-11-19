import { describe, it, expect } from 'vitest';
import {
  FLOW_LIMITS,
  FLOW_NODE_TYPES,
  FLOW_NODE_TYPE_LABEL,
  canAddFlow,
  flowHistoryCutoff,
  flowLimitsOf,
  flowMonthStartUtc,
  flowPartCallState,
  flowRunAdmission,
  flowRunState,
  planAllowsPart,
} from '../index';

describe('FLOW_LIMITS（設計書 §7.6。値は仮）', () => {
  it('梅 < 竹 < 松 で、保持は当月を消さない 60 日以上', () => {
    expect(FLOW_LIMITS.STARTER).toEqual({ maxFlows: 3, runsPerMonth: 300, partCallsPerMonth: 100, concurrency: 2, historyDays: 60 });
    for (const key of ['maxFlows', 'runsPerMonth', 'partCallsPerMonth', 'concurrency', 'historyDays'] as const) {
      expect(FLOW_LIMITS.STARTER[key]).toBeLessThan(FLOW_LIMITS.PRO[key]);
      expect(FLOW_LIMITS.PRO[key]).toBeLessThan(FLOW_LIMITS.MAX[key]);
    }
    expect(FLOW_LIMITS.STARTER.historyDays).toBeGreaterThanOrEqual(60);
  });

  it('知らないプラン名は梅で数える（安全側）', () => {
    expect(flowLimitsOf('ENTERPRISE')).toBe(FLOW_LIMITS.STARTER);
    expect(flowLimitsOf('__proto__')).toBe(FLOW_LIMITS.STARTER);
  });

  it('ノード型は 7 種で、すべてに一語のラベル', () => {
    expect(FLOW_NODE_TYPES).toHaveLength(7);
    for (const t of FLOW_NODE_TYPES) expect(FLOW_NODE_TYPE_LABEL[t].length).toBeLessThanOrEqual(8);
  });
});

describe('canAddFlow', () => {
  it('上限未満なら作れる。降格で超えていても負にならない', () => {
    expect(canAddFlow('STARTER', 2)).toBe(true);
    expect(canAddFlow('STARTER', 3)).toBe(false);
    expect(canAddFlow('STARTER', 9)).toBe(false);
    expect(canAddFlow('PRO', 9)).toBe(true);
    expect(canAddFlow('MAX', -1)).toBe(true);
  });
});

describe('flowRunState / flowPartCallState', () => {
  it('8 割で warn、上限で over かつ blocked', () => {
    expect(flowRunState('STARTER', 0)).toEqual({ used: 0, limit: 300, state: 'ok', blocked: false });
    expect(flowRunState('STARTER', 240)).toMatchObject({ state: 'warn', blocked: false });
    expect(flowRunState('STARTER', 300)).toMatchObject({ state: 'over', blocked: true });
    expect(flowPartCallState('PRO', 999)).toMatchObject({ limit: 1000, blocked: false });
    expect(flowPartCallState('PRO', 1000)).toMatchObject({ blocked: true });
    expect(flowRunState('MAX', Number.NaN)).toMatchObject({ used: 0, blocked: false });
  });
});

describe('flowRunAdmission', () => {
  it('実行数の上限 → FLOW_RUN_LIMIT、部品の上限は部品を含むフローだけ → FLOW_PART_LIMIT', () => {
    expect(flowRunAdmission('STARTER', { runsThisMonth: 10, partCallsThisMonth: 0 }, true)).toBeNull();
    expect(flowRunAdmission('STARTER', { runsThisMonth: 300, partCallsThisMonth: 0 }, false)).toBe('FLOW_RUN_LIMIT');
    expect(flowRunAdmission('STARTER', { runsThisMonth: 10, partCallsThisMonth: 100 }, true)).toBe('FLOW_PART_LIMIT');
    expect(flowRunAdmission('STARTER', { runsThisMonth: 10, partCallsThisMonth: 100 }, false)).toBeNull();
  });
});

describe('planAllowsPart', () => {
  it('minPlan 以上のプランだけ。知らない minPlan は使えない', () => {
    expect(planAllowsPart('STARTER', 'STARTER')).toBe(true);
    expect(planAllowsPart('STARTER', 'PRO')).toBe(false);
    expect(planAllowsPart('PRO', 'PRO')).toBe(true);
    expect(planAllowsPart('MAX', 'PRO')).toBe(true);
    expect(planAllowsPart('MAX', 'GOLD')).toBe(false);
    expect(planAllowsPart('UNKNOWN', 'STARTER')).toBe(true);
    expect(planAllowsPart('UNKNOWN', 'PRO')).toBe(false);
  });
});

describe('月の境目と履歴の保持', () => {
  it('当月は UTC の暦月', () => {
    expect(flowMonthStartUtc(new Date('2026-11-30T23:59:59Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    // JST では 12/1 でも UTC ではまだ 11 月
    expect(flowMonthStartUtc(new Date('2026-11-30T16:00:00Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('保持日数を引いた時刻。ただし当月の始まりより後にはしない', () => {
    const now = new Date('2026-11-18T00:00:00Z');
    expect(flowHistoryCutoff('STARTER', now).toISOString()).toBe('2026-09-19T00:00:00.000Z');
    expect(flowHistoryCutoff('MAX', now).toISOString()).toBe('2025-11-18T00:00:00.000Z');
    // 仮に保持が短くても当月の行は消さない
    const early = new Date('2026-11-02T00:00:00Z');
    expect(flowHistoryCutoff('STARTER', early) <= flowMonthStartUtc(early)).toBe(true);
  });
});
