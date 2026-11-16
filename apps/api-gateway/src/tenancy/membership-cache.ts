// (userId, orgId) → 所属の状態。TTL 30 秒のプロセス内キャッシュ（docs/design/multi-tenancy.md ADR-7）。
//
// ■ なぜキャッシュするか
//   requireAuth は全リクエストで所属を確かめる（外したメンバーを締め出すため。Q1 仮採用）。
//   毎回 DB を引くと全リクエストに +1 クエリなので、読み取りには 30 秒の遅れを許す。
//   権限が要る操作（requireRole）は bypassCache で必ず DB を読む（降格・無効化が即座に効く）。
// ■ 破棄
//   Membership を変える API（役割の変更・無効化・招待の受諾・組織の作成）は、同じプロセスのキャッシュを
//   即座に破棄する。Render の api-gateway は1インスタンスの想定。台数を増やすと、他のインスタンスでは
//   最大 TTL 分だけ遅れる（設計書 §15-9）。
//   契約状態（subscriptionStatus）も載せているので、Stripe の写し込みでも組織単位で破棄する。
//
// ⚠️ DB の素のクライアントを使う（所属の確認はテナントが決まる前の処理なので）。

import { prisma } from '../utils/prisma';

export interface MembershipSnapshot {
  /** User が存在しない場合は null（= 401） */
  userStatus: string | null;
  /** その組織の Membership が無ければ null（= 403 TENANT_ACCESS_REVOKED） */
  membership: { role: string; status: string } | null;
  /** 組織の契約状態（解約後の閲覧のみ判定に使う） */
  subscriptionStatus: string | null;
}

export const MEMBERSHIP_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 10_000;

const cache = new Map<string, { at: number; value: MembershipSnapshot }>();
const keyOf = (userId: string, orgId: string): string => `${userId}\u0000${orgId}`;

async function load(userId: string, orgId: string): Promise<MembershipSnapshot> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      status: true,
      memberships: {
        where: { orgId },
        select: { role: true, status: true, org: { select: { subscriptionStatus: true } } },
        take: 1,
      },
    },
  });
  if (!user) return { userStatus: null, membership: null, subscriptionStatus: null };
  const m = user.memberships?.[0];
  return {
    userStatus: user.status,
    membership: m ? { role: m.role, status: m.status } : null,
    subscriptionStatus: m?.org?.subscriptionStatus ?? null,
  };
}

/** 所属の状態を返す。bypassCache なら必ず DB を読み、結果でキャッシュも更新する。 */
export async function getMembership(
  userId: string,
  orgId: string,
  opts: { bypassCache?: boolean; now?: number } = {},
): Promise<MembershipSnapshot> {
  const now = opts.now ?? Date.now();
  const key = keyOf(userId, orgId);
  if (!opts.bypassCache) {
    const hit = cache.get(key);
    if (hit && now - hit.at < MEMBERSHIP_CACHE_TTL_MS) return hit.value;
  }
  const value = await load(userId, orgId);
  if (cache.size >= MAX_ENTRIES) {
    // 一番古いものから捨てる（Map は挿入順）
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key);
  cache.set(key, { at: now, value });
  return value;
}

/** 1人の所属を破棄する。orgId を省くとその人の全組織。 */
export function invalidateMembership(userId: string, orgId?: string): void {
  if (orgId) {
    cache.delete(keyOf(userId, orgId));
    return;
  }
  for (const k of cache.keys()) if (k.startsWith(`${userId}\u0000`)) cache.delete(k);
}

/** 組織のエントリをすべて破棄する（契約状態が変わったとき）。 */
export function invalidateOrgMemberships(orgId: string): void {
  for (const k of cache.keys()) if (k.endsWith(`\u0000${orgId}`)) cache.delete(k);
}

/** テスト用 */
export function clearMembershipCache(): void {
  cache.clear();
}
