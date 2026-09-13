import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLAN_LIMITS, USAGE_WARN_RATIO, usageState, type Plan } from '@org-ai/shared-types';

/**
 * 画面に出すモデル名が、ai-engine が実際に叩くモデルと一致していることを確かめる。
 *
 * ⚠️ 以前この2つは食い違っていた。画面は梅に「Claude Haiku 4.5」と表示していたが、
 *    router は Gemini flash-lite に流しており、3プラン中2つで顧客が受け取っていない
 *    モデル名を出していた。ai-engine 側も同じ JSON を検証している
 *    （apps/ai-engine/tests/test_plan_models.py）。片側だけ変えると、もう片側が落ちる。
 */

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../../../tests/fixtures/plan-models.json'), 'utf8'),
) as {
  plans: Record<Plan, { provider: string; model: string; label: string; callsPerMonth: number }>;
  tasks: Record<string, { provider: string; model: string }>;
  usage: { warnRatio: number; overBehavior: string };
};

describe('PLAN_LIMITS と共有の表', () => {
  const plans: Plan[] = ['STARTER', 'PRO', 'MAX'];

  it.each(plans)('%s のモデルIDが表と一致する', (plan) => {
    expect(PLAN_LIMITS[plan].model).toBe(fixture.plans[plan].model);
  });

  it.each(plans)('%s の表示名が表と一致する', (plan) => {
    expect(PLAN_LIMITS[plan].modelLabel).toBe(fixture.plans[plan].label);
  });

  it('⚠️ 表示名がモデルIDと矛盾していない（Gemini を Claude と表示しない）', () => {
    for (const plan of plans) {
      const { model, modelLabel } = PLAN_LIMITS[plan];
      const isGemini = model.startsWith('gemini');
      expect(modelLabel.toLowerCase().includes('gemini')).toBe(isGemini);
      expect(modelLabel.toLowerCase().includes('claude')).toBe(!isGemini);
    }
  });

  it('上位プランほど実行量の上限が大きい', () => {
    expect(PLAN_LIMITS.STARTER.aiCallsPerMonth).toBeLessThan(PLAN_LIMITS.PRO.aiCallsPerMonth);
    expect(PLAN_LIMITS.PRO.aiCallsPerMonth).toBeLessThan(PLAN_LIMITS.MAX.aiCallsPerMonth);
  });

  it('実行量の上限が実用的な水準にある（1往復で1〜2回消費する前提）', () => {
    // 旧値の 100 は「チャット50往復」程度で、10人の会社では1週間持たなかった
    expect(PLAN_LIMITS.STARTER.aiCallsPerMonth).toBeGreaterThanOrEqual(1000);
  });
});

describe('タスク別のモデル（プランに依存しないもの）', () => {
  it('判定と設計に別のモデルを使う', () => {
    // ⚠️ 同じにすると、捨てる前提の判定を最上位モデルで回すことになる
    expect(fixture.tasks.SCREEN.model).not.toBe(fixture.tasks.DESIGN.model);
  });

  it('抽出はプランで変えない（安いプランで領収書を読み違えさせない）', () => {
    expect(fixture.tasks.EXTRACT.provider).toBe('anthropic');
    expect(fixture.tasks.EXTRACT.model).toBeTruthy();
  });
});

describe('利用量の上限（ai-engine と同じ表を見ている）', () => {
  const plans: Plan[] = ['STARTER', 'PRO', 'MAX'];

  it.each(plans)('%s の月間上限が表と一致する', (plan) => {
    expect(PLAN_LIMITS[plan].aiCallsPerMonth).toBe(fixture.plans[plan].callsPerMonth);
  });

  it('警告のしきい値が表と一致する', () => {
    expect(USAGE_WARN_RATIO).toBe(fixture.usage.warnRatio);
  });

  it('⚠️ 上限を超えても止めない（軽いモデルに落として継続する）', () => {
    expect(fixture.usage.overBehavior).toBe('degrade');
  });

  it('状態の境目が ai-engine の state_of と同じ', () => {
    const limit = PLAN_LIMITS.STARTER.aiCallsPerMonth;
    expect(usageState(0, limit)).toBe('ok');
    expect(usageState(Math.ceil(limit * 0.8) - 1, limit)).toBe('ok');
    expect(usageState(limit * 0.8, limit)).toBe('warn');
    expect(usageState(limit - 1, limit)).toBe('warn');
    expect(usageState(limit, limit)).toBe('over');
    expect(usageState(5, 0)).toBe('ok');
  });
});
