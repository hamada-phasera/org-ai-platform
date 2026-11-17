// requireAuth / requireRole が読む「User + その組織の Membership + 組織の契約状態」の形
// （src/tenancy/membership-cache.ts の load と同じ select）を作るテスト用ヘルパ。

export interface MembershipRowOptions {
  userStatus?: string;
  role?: string;
  status?: string;
  subscriptionStatus?: string | null;
  /** 組織のトライアルの終わり（未指定は null = 登録時トライアルより前の既存組織） */
  trialEndsAt?: Date | null;
  /** false なら Membership が無い（その組織に所属していない） */
  member?: boolean;
}

export function userWithMembership(o: MembershipRowOptions = {}) {
  return {
    status: o.userStatus ?? 'ACTIVE',
    memberships:
      o.member === false
        ? []
        : [
            {
              role: o.role ?? 'OWNER',
              status: o.status ?? 'ACTIVE',
              org: {
                subscriptionStatus: o.subscriptionStatus === undefined ? null : o.subscriptionStatus,
                trialEndsAt: o.trialEndsAt ?? null,
              },
            },
          ],
  };
}
