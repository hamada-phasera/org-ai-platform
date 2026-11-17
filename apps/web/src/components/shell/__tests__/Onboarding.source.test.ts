import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 初回の案内の見た目の決まり（DESIGN.md: 左アクセントバー禁止・カードの入れ子禁止・TOP に KPI を出さない）を
// ソースで固定する（docs/plan/saas-readiness-plan.md チャンク 6 受け入れ条件 5）。

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('Onboarding', () => {
  const src = read('../Onboarding.tsx');

  it('左アクセントバーを使わない', () => {
    expect(src).not.toMatch(/\bborder-l(-\w+)?\b/);
    expect(src).not.toMatch(/\bborder-s(-\w+)?\b/);
  });

  it('カードを使わない（TOP の上で入れ子にしない）', () => {
    expect(src).not.toMatch(/\bCard\b/);
    expect(src).not.toMatch(/\brounded-/);
    expect(src).not.toMatch(/\bshadow-/);
  });

  it('数字（KPI）を出さない: 集計 API を読まず、件数や割合を描かない', () => {
    expect(src).not.toMatch(/\/dashboard/);
    expect(src).not.toMatch(/\.length\}/);
    expect(src).not.toMatch(/[件%]\s*</);
  });

  it('閉じた記録は組織ごとのキーで保存する', () => {
    expect(src).toContain('onboardingDismissKey(orgId)');
  });

  it('押せる要素は 44px 以上', () => {
    expect(src).toContain('h-11 w-11');
    expect(src).toContain('min-h-11');
  });
});

describe('TopPage', () => {
  const src = read('../../../pages/TopPage.tsx');

  it('案内は入力欄（form）の直後に置く', () => {
    const form = src.indexOf('</form>');
    const onboarding = src.indexOf('<Onboarding');
    expect(form).toBeGreaterThan(0);
    expect(onboarding).toBeGreaterThan(form);
    expect(src.slice(form, onboarding)).not.toMatch(/<(div|section|ExpandableCard)\b/);
  });

  it('常時出す数字は承認待ちの件数だけのまま（KPI を足さない）', () => {
    // 常時走るクエリ（enabled の無いもの）は saved-agents と pending-approval-count の 2 本だけ
    const queries = [...src.matchAll(/useQuery<[^>]*>\(\{\s*queryKey: \['([^']+)'\]([\s\S]*?)\}\);/g)];
    const always = queries.filter((m) => !/enabled:/.test(m[2])).map((m) => m[1]);
    expect(always.sort()).toEqual(['pending-approval-count', 'saved-agents']);
  });
});
