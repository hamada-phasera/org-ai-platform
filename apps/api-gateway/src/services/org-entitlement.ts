// 認証の無いシステム経路（定期実行・LINE 受信・n8n からの enqueue）で、組織の契約を確かめる。
//
// requireAuth は HTTP の書き込みだけを止める。誰も操作していない時間に走るこれらの経路は requireAuth を通らないので、
// 入口でここを呼び、閲覧のみ（期限切れ・解約済み）の組織では AI の実行と新しい書き込みをしない
// （docs/plan/saas-review.md #1。トライアル中に定期実行を仕込めば期限後も無料で AI が回る抜け道を塞ぐ）。
//
// ⚠️ 判定は entitlementDecision の 1 か所（ここは組織の行を読んで渡すだけ）。
// ⚠️ 組織の行が読めない（無い）ときは止めない（fail-open。entitlementDecision の「壊れた日付で止めない」と同じ）。

import type { TenantDb } from '../tenancy/tenant-db';
import { config } from '../config/env';
import { entitlementDecision, type EntitlementDecision } from './entitlement';

export async function orgEntitlement(db: TenantDb, now: Date = new Date()): Promise<EntitlementDecision> {
  const org = await db.organization.findUnique({
    where: { id: db.orgId },
    select: { subscriptionStatus: true, trialEndsAt: true },
  });
  if (!org) return { access: 'full' };
  return entitlementDecision({
    status: org.subscriptionStatus,
    trialEndsAt: org.trialEndsAt,
    billingConfigured: config.billingConfigured,
    now,
  });
}
