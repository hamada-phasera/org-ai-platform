import { describe, it, expect } from 'vitest';
import { STORAGE_WARN_RATIO, USAGE_WARN_RATIO } from '@org-ai/shared-types';
import {
  appTrialDaysLeft,
  isReadOnly,
  needsPlanLink,
  planNoticeOf,
  planNoticeText,
  TRIAL_NOTICE_DAYS,
} from '../planNotice';

// 画面上部の帯の判定（docs/plan/saas-readiness-plan.md チャンク 2）

const NOW = Date.parse('2026-11-17T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(ms).toISOString();

type Billing = Parameters<typeof planNoticeOf>[0];
const billing = (over: Partial<NonNullable<Billing>> = {}): NonNullable<Billing> => ({
  configured: true,
  subscriptionStatus: null,
  trialEndsAt: null,
  ...over,
});
const GB = 1024 ** 3;
const usage = (ai: number, limit = 1000, used = 0, quota = GB) => ({
  aiCallsThisMonth: ai,
  planLimit: limit,
  storageUsedBytes: used,
  storageQuotaBytes: quota,
});

describe('planNoticeOf: 7 状態', () => {
  it('none: 何も無い', () => {
    expect(planNoticeOf(billing(), usage(0), NOW).kind).toBe('none');
    expect(planNoticeOf(undefined, undefined, NOW).kind).toBe('none');
  });

  it('expired: 登録時トライアル切れ（未契約・決済設定済み）', () => {
    expect(planNoticeOf(billing({ trialEndsAt: at(NOW - DAY) }), usage(0), NOW).kind).toBe('expired');
  });

  it('expired: 解約済み（canceled / unpaid / paused）で無料期間の残りが無い', () => {
    for (const s of ['canceled', 'unpaid', 'paused'] as const) {
      expect(planNoticeOf(billing({ subscriptionStatus: s }), usage(0), NOW).kind).toBe('expired');
    }
  });

  it('incomplete / incomplete_expired は未契約と同じ。解約後も無料期間の残りがあれば trial（saas-review #4）', () => {
    for (const s of ['incomplete', 'incomplete_expired'] as const) {
      // 期限の無い既存組織は止めない
      expect(planNoticeOf(billing({ subscriptionStatus: s }), usage(0), NOW).kind).toBe('none');
      expect(planNoticeOf(billing({ subscriptionStatus: s, trialEndsAt: at(NOW - DAY) }), usage(0), NOW).kind).toBe('expired');
      expect(planNoticeOf(billing({ subscriptionStatus: s, trialEndsAt: at(NOW + 3 * DAY) }), usage(0), NOW)).toEqual({
        kind: 'trial',
        daysLeft: 3,
      });
    }
    expect(planNoticeOf(billing({ subscriptionStatus: 'canceled', trialEndsAt: at(NOW + 3 * DAY) }), usage(0), NOW)).toEqual({
      kind: 'trial',
      daysLeft: 3,
    });
    expect(planNoticeOf(billing({ subscriptionStatus: 'canceled', trialEndsAt: at(NOW - DAY) }), usage(0), NOW).kind).toBe(
      'expired',
    );
  });

  it('expired: 402 を受けた（overview が取れていなくても）', () => {
    expect(planNoticeOf(undefined, undefined, NOW, { readOnly: true }).kind).toBe('expired');
  });

  it('trial: 残り 7 日以下', () => {
    const n = planNoticeOf(billing({ trialEndsAt: at(NOW + 3 * DAY) }), usage(0), NOW);
    expect(n).toEqual({ kind: 'trial', daysLeft: 3 });
  });

  it('storage-over / ai-over / storage-warn / ai-warn', () => {
    expect(planNoticeOf(billing(), usage(0, 1000, GB, GB), NOW).kind).toBe('storage-over');
    expect(planNoticeOf(billing(), usage(1000), NOW).kind).toBe('ai-over');
    expect(planNoticeOf(billing(), usage(0, 1000, 0.9 * GB, GB), NOW).kind).toBe('storage-warn');
    expect(planNoticeOf(billing(), usage(900), NOW).kind).toBe('ai-warn');
  });
});

describe('planNoticeOf: 境界値', () => {
  it('残り 7 日ちょうどは trial、7 日と 1 秒は none', () => {
    expect(planNoticeOf(billing({ trialEndsAt: at(NOW + 7 * DAY) }), usage(0), NOW)).toEqual({ kind: 'trial', daysLeft: 7 });
    expect(planNoticeOf(billing({ trialEndsAt: at(NOW + 7 * DAY + 1000) }), usage(0), NOW).kind).toBe('none');
    expect(TRIAL_NOTICE_DAYS).toBe(7);
  });

  it('残り 1 秒は「残り 1 日」（切り上げ）、0 日（期限ちょうど）は expired', () => {
    expect(planNoticeOf(billing({ trialEndsAt: at(NOW + 1000) }), usage(0), NOW)).toEqual({ kind: 'trial', daysLeft: 1 });
    // gateway と同じく、期限ちょうどは閲覧のみ側（§7）
    expect(planNoticeOf(billing({ trialEndsAt: at(NOW) }), usage(0), NOW).kind).toBe('expired');
  });

  it('AI: 8 割ちょうどは ai-warn、その 1 つ手前は none、上限ちょうどは ai-over', () => {
    const limit = 1000;
    const warnAt = limit * USAGE_WARN_RATIO;
    expect(planNoticeOf(billing(), usage(warnAt, limit), NOW).kind).toBe('ai-warn');
    expect(planNoticeOf(billing(), usage(warnAt - 1, limit), NOW).kind).toBe('none');
    expect(planNoticeOf(billing(), usage(limit - 1, limit), NOW).kind).toBe('ai-warn');
    expect(planNoticeOf(billing(), usage(limit, limit), NOW).kind).toBe('ai-over');
  });

  it('容量: 警告割合ちょうどは storage-warn、上限ちょうどは storage-over', () => {
    const quota = 1000;
    expect(planNoticeOf(billing(), usage(0, 1000, quota * STORAGE_WARN_RATIO, quota), NOW).kind).toBe('storage-warn');
    expect(planNoticeOf(billing(), usage(0, 1000, quota * STORAGE_WARN_RATIO - 1, quota), NOW).kind).toBe('none');
    expect(planNoticeOf(billing(), usage(0, 1000, quota, quota), NOW).kind).toBe('storage-over');
  });

  it('上限 0（不明）のときは出さない', () => {
    expect(planNoticeOf(billing(), usage(50, 0, 50, 0), NOW).kind).toBe('none');
  });
});

describe('planNoticeOf: 止めない条件は gateway と同じ', () => {
  it('決済未設定なら期限が過ぎても expired にも trial にもしない', () => {
    expect(planNoticeOf(billing({ configured: false, trialEndsAt: at(NOW - DAY) }), usage(0), NOW).kind).toBe('none');
    expect(planNoticeOf(billing({ configured: false, trialEndsAt: at(NOW + DAY) }), usage(0), NOW).kind).toBe('none');
  });

  it('trialEndsAt が null の既存組織は止めない', () => {
    expect(isReadOnly(billing({ trialEndsAt: null }), NOW)).toBe(false);
  });

  it('trialing / active / past_due は trialEndsAt に関係なく通す（Stripe のトライアルは帯を出さない）', () => {
    for (const s of ['trialing', 'active', 'past_due'] as const) {
      const b = billing({ subscriptionStatus: s, trialEndsAt: at(NOW - DAY) });
      expect(isReadOnly(b, NOW)).toBe(false);
      expect(planNoticeOf(b, usage(0), NOW).kind).toBe('none');
      expect(appTrialDaysLeft(billing({ subscriptionStatus: s, trialEndsAt: at(NOW + DAY) }), NOW)).toBe(0);
    }
  });

  it('壊れた日付で止めない', () => {
    expect(isReadOnly(billing({ trialEndsAt: 'not-a-date' }), NOW)).toBe(false);
  });
});

describe('planNoticeOf: 優先順', () => {
  it('expired > trial > storage-over > ai-over > storage-warn > ai-warn', () => {
    const all = usage(1000, 1000, GB, GB);
    expect(planNoticeOf(billing({ trialEndsAt: at(NOW - DAY) }), all, NOW).kind).toBe('expired');
    expect(planNoticeOf(billing({ trialEndsAt: at(NOW + DAY) }), all, NOW).kind).toBe('trial');
    expect(planNoticeOf(billing(), all, NOW).kind).toBe('storage-over');
    expect(planNoticeOf(billing(), usage(1000, 1000, 0.9 * GB, GB), NOW).kind).toBe('ai-over');
    expect(planNoticeOf(billing(), usage(900, 1000, 0.9 * GB, GB), NOW).kind).toBe('storage-warn');
  });
});

describe('planNoticeText / needsPlanLink', () => {
  it('none 以外は 1 文を返す', () => {
    for (const kind of ['expired', 'trial', 'storage-over', 'ai-over', 'storage-warn', 'ai-warn'] as const) {
      const { text } = planNoticeText({ kind, daysLeft: 2 });
      expect(text.length).toBeGreaterThan(0);
      expect(text.match(/。/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
    expect(planNoticeText({ kind: 'trial', daysLeft: 2 }).text).toContain('2日');
  });

  it('容量超過・サイズ超過・閲覧のみのエラーには契約画面へのリンクを付ける', () => {
    expect(needsPlanLink('QUOTA_EXCEEDED')).toBe(true);
    expect(needsPlanLink('FILE_TOO_LARGE')).toBe(true);
    expect(needsPlanLink('SUBSCRIPTION_REQUIRED')).toBe(true);
    expect(needsPlanLink('VALIDATION_ERROR')).toBe(false);
    expect(needsPlanLink(undefined)).toBe(false);
  });
});
