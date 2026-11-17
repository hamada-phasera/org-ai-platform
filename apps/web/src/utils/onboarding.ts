import type { UserRole } from '@org-ai/shared-types';

/**
 * TOP の入力欄の下に出す「初回の案内」（3 行: 指示・連携・招待）の判定。純粋関数（DOM も保存領域も読まない）。
 *
 * 完了は既存 API から導出する（専用の列や API は足さない）:
 *   指示 … チャットのセッションが 1 件以上（GET /api/chat/sessions。組織全体）
 *   連携 … 接続済みの外部サービスが 1 件以上（GET /api/integrations の CONNECTED、LINE は GET /api/inbox/connections）
 *   招待 … 自分以外のメンバーか、保留中の招待が 1 件以上（GET /api/members、GET /api/members/invitations）
 *
 * 出す行は権限で絞る（押しても 403 になる行は出さない）:
 *   OWNER = 3 行 / ADMIN = 指示・連携（招待はオーナーだけ） / MEMBER = 指示だけ
 *
 * 全部終わったか、閉じた（組織ごとに保存）ら空配列 = 何も出さない。
 * 読み込み中（必要な事実が undefined）も空配列にする。完了済みの行が一瞬出てから消えるのを避けるため。
 */

export type OnboardingStepKey = 'instruct' | 'connect' | 'invite';

export interface OnboardingStep {
  key: OnboardingStepKey;
  /** 一語 */
  label: string;
  /** 1 文 */
  hint: string;
  /** 押したときの行き先。instruct は TOP の入力欄へ移るだけなので null */
  to: string | null;
  done: boolean;
}

export interface OnboardingFacts {
  /** この組織での権限（Membership.role）。不明なら MEMBER 扱い */
  role: UserRole | null | undefined;
  /** チャットのセッションがあるか。undefined = 読み込み中 */
  hasChat: boolean | undefined;
  /** 接続済みの外部サービスがあるか。OWNER/ADMIN だけ見る */
  hasConnection?: boolean | undefined;
  /** 自分を含むメンバー数（ACTIVE）。OWNER だけ見る */
  memberCount?: number | undefined;
  /** 保留中の招待の数。OWNER だけ見る（招待を送った時点で完了とみなす） */
  pendingInvites?: number | undefined;
}

export const ONBOARDING_STEPS: readonly Omit<OnboardingStep, 'done'>[] = [
  { key: 'instruct', label: '指示', hint: '上の欄に、今日やることを一行で。', to: null },
  { key: 'connect', label: '連携', hint: 'Slack や Google をつなぐ。', to: '/settings?tab=integrations' },
  { key: 'invite', label: '招待', hint: '一緒に使う人を呼ぶ。', to: '/settings?tab=members' },
];

/** この権限で出す行 */
export function onboardingKeysFor(role: UserRole | null | undefined): OnboardingStepKey[] {
  if (role === 'OWNER') return ['instruct', 'connect', 'invite'];
  if (role === 'ADMIN') return ['instruct', 'connect'];
  return ['instruct'];
}

/** 閉じた記録の保存キー（組織ごと）。組織を切り替えたら別の組織の案内として出し直す */
export function onboardingDismissKey(orgId: string): string {
  return `flow.onboarding.dismissed.${orgId}`;
}

export function onboardingSteps(facts: OnboardingFacts, dismissed: boolean): OnboardingStep[] {
  if (dismissed) return [];
  const keys = onboardingKeysFor(facts.role);

  const doneOf: Record<OnboardingStepKey, boolean | undefined> = {
    instruct: facts.hasChat,
    connect: facts.hasConnection,
    invite:
      facts.memberCount === undefined || facts.pendingInvites === undefined
        ? undefined
        : facts.memberCount > 1 || facts.pendingInvites > 0,
  };

  // 読み込み中は出さない
  if (keys.some((k) => doneOf[k] === undefined)) return [];

  const steps = ONBOARDING_STEPS.filter((s) => keys.includes(s.key)).map((s) => ({
    ...s,
    done: doneOf[s.key] === true,
  }));
  return steps.every((s) => s.done) ? [] : steps;
}
