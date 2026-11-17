import { describe, it, expect } from 'vitest';
import {
  onboardingDismissKey,
  onboardingKeysFor,
  onboardingSteps,
  type OnboardingFacts,
} from '../onboarding';

// TOP の初回の案内（docs/plan/saas-readiness-plan.md チャンク 6 受け入れ条件 3）

const owner = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  role: 'OWNER',
  hasChat: false,
  hasConnection: false,
  memberCount: 1,
  pendingInvites: 0,
  ...over,
});
const doneMap = (facts: OnboardingFacts, dismissed = false) =>
  Object.fromEntries(onboardingSteps(facts, dismissed).map((s) => [s.key, s.done]));

describe('onboardingSteps', () => {
  it('登録直後のオーナーは 3 項目すべて未完了で、指示・連携・招待の順', () => {
    const steps = onboardingSteps(owner(), false);
    expect(steps.map((s) => s.key)).toEqual(['instruct', 'connect', 'invite']);
    expect(steps.every((s) => !s.done)).toBe(true);
  });

  it('ラベルは一語', () => {
    for (const s of onboardingSteps(owner(), false)) expect(s.label).toMatch(/^\S+$/);
  });

  it.each([
    ['チャットがある → 指示だけ完了', owner({ hasChat: true }), { instruct: true, connect: false, invite: false }],
    ['連携がある → 連携だけ完了', owner({ hasConnection: true }), { instruct: false, connect: true, invite: false }],
    ['メンバーが 2 人 → 招待だけ完了', owner({ memberCount: 2 }), { instruct: false, connect: false, invite: true }],
    ['保留中の招待がある → 招待は完了', owner({ pendingInvites: 1 }), { instruct: false, connect: false, invite: true }],
    ['2 つ完了でも残り 1 つがあれば 3 行とも出す', owner({ hasChat: true, hasConnection: true }), { instruct: true, connect: true, invite: false }],
  ])('%s', (_name, facts, expected) => {
    expect(doneMap(facts)).toEqual(expected);
  });

  it('3 項目すべて完了なら空（何も出さない）', () => {
    expect(onboardingSteps(owner({ hasChat: true, hasConnection: true, memberCount: 3 }), false)).toEqual([]);
  });

  it('閉じた後は未完了でも空', () => {
    expect(onboardingSteps(owner(), true)).toEqual([]);
  });

  it('読み込み中（必要な事実が undefined）は空 = 完了済みの行が一瞬出ない', () => {
    expect(onboardingSteps(owner({ hasChat: undefined }), false)).toEqual([]);
    expect(onboardingSteps(owner({ hasConnection: undefined }), false)).toEqual([]);
    expect(onboardingSteps(owner({ memberCount: undefined }), false)).toEqual([]);
    expect(onboardingSteps(owner({ pendingInvites: undefined }), false)).toEqual([]);
  });

  it('ADMIN は指示・連携だけ（招待はオーナーだけの操作）。招待の事実は見ない', () => {
    const facts: OnboardingFacts = { role: 'ADMIN', hasChat: false, hasConnection: false };
    expect(onboardingSteps(facts, false).map((s) => s.key)).toEqual(['instruct', 'connect']);
    expect(onboardingSteps({ ...facts, hasChat: true, hasConnection: true }, false)).toEqual([]);
  });

  it('MEMBER と権限不明は指示だけ', () => {
    expect(onboardingSteps({ role: 'MEMBER', hasChat: false }, false).map((s) => s.key)).toEqual(['instruct']);
    expect(onboardingSteps({ role: null, hasChat: false }, false).map((s) => s.key)).toEqual(['instruct']);
    expect(onboardingSteps({ role: 'MEMBER', hasChat: true }, false)).toEqual([]);
  });

  it('行き先: 指示は入力欄（遷移なし）、連携と招待は設定の該当タブ', () => {
    const to = Object.fromEntries(onboardingSteps(owner(), false).map((s) => [s.key, s.to]));
    expect(to).toEqual({
      instruct: null,
      connect: '/settings?tab=integrations',
      invite: '/settings?tab=members',
    });
  });
});

describe('onboardingKeysFor / onboardingDismissKey', () => {
  it('権限ごとの行', () => {
    expect(onboardingKeysFor('OWNER')).toHaveLength(3);
    expect(onboardingKeysFor('ADMIN')).toHaveLength(2);
    expect(onboardingKeysFor('MEMBER')).toHaveLength(1);
    expect(onboardingKeysFor(undefined)).toHaveLength(1);
  });

  it('閉じた記録は組織ごと', () => {
    expect(onboardingDismissKey('org-a')).not.toBe(onboardingDismissKey('org-b'));
    expect(onboardingDismissKey('org-a')).toContain('org-a');
  });
});
