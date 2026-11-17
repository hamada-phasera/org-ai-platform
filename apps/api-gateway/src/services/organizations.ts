// 組織の作成と、組織をまたぐ判定（作成上限・トライアル）。
// 組織をまたいで数えるので素の prisma を使うシステム経路（アーキテクチャテストの allowlist）。

import { prisma } from '../utils/prisma';
import { tenantDbFrom, type TenantTx } from '../tenancy/tenant-db';
import { DEFAULT_CAPABILITIES } from './default-capabilities';
import { invalidateMembership } from '../tenancy/membership-cache';
import { appTrialEndFrom } from './entitlement';
import { config } from '../config/env';
import { recordAuditInTx } from './audit';

/**
 * 1ユーザーが作成できる組織の数（設計書 Q10 仮採用: 10）。招待での所属は数えない。
 * 悪用（トライアル目当ての量産）とコストの対策。
 */
export const MAX_ORGS_CREATED_PER_USER = 10;

/** その人が作った組織の数（Organization.createdBy）。 */
export async function countOrgsCreatedBy(userId: string): Promise<number> {
  return prisma.organization.count({ where: { createdBy: userId } });
}

/**
 * 新しい組織に既定のノード（Capability）を入れる（設計書 E8）。
 * テナントクライアントで書くので、orgId は自動で付き、他の組織には書けない。
 */
export async function seedDefaultCapabilities(db: TenantTx): Promise<void> {
  for (const cap of DEFAULT_CAPABILITIES) {
    const created = await db.capability.create({
      data: {
        orgId: db.orgId,
        name: cap.name,
        displayName: cap.displayName,
        description: cap.description,
        department: cap.department,
        inputSchema: cap.inputSchema as object,
        status: cap.status,
        webhookPath: cap.webhookPath,
      },
    });
    for (const provider of cap.providers) {
      await db.requiredCredential.create({ data: { capabilityId: created.id, provider, status: 'DISCONNECTED' } });
    }
  }
}

/**
 * 組織を作り、作成者を OWNER として所属させ、既定のノードを入れる（1トランザクション）。
 * 登録時トライアル（trialEndsAt）もここで決める（最初の1つだけ BILLING_TRIAL_DAYS 日）。
 * User.orgId（最後に選んだ組織）と User.role（移行期間中の写し）も新しい組織に向ける。
 */
export async function createOrganizationFor(
  userId: string,
  name: string,
): Promise<{ id: string; name: string; plan: string }> {
  const org = await prisma.$transaction(async (tx) => {
    const now = new Date();
    /* 作成者の行を先に更新して行ロックを取る（同時に 2 回押されても、2 本目は 1 本目のコミットを待ってから数える）。
       これが無いと「数えてから作る」の間に割り込まれ、両方にトライアルが付きうる（saas-review #8）。 */
    await tx.user.update({ where: { id: userId }, data: { updatedAt: now } });
    /* トライアルは作成者ごとに1回（D4）。すでに自分で組織を作っている人の2つ目以降は、
       作成時点で期限切れ（決済が設定済みなら契約するまで閲覧のみ）。招待で入った組織は数えない。 */
    const alreadyCreated = await tx.organization.count({ where: { createdBy: userId } });
    const trialEndsAt = alreadyCreated > 0 ? now : appTrialEndFrom(now, config.billingTrialDays);
    const org = await tx.organization.create({
      data: { name, plan: 'STARTER', createdBy: userId, trialEndsAt },
    });
    await tx.membership.create({ data: { userId, orgId: org.id, role: 'OWNER' } });
    const db = tenantDbFrom(tx, org.id);
    await seedDefaultCapabilities(db);
    await recordAuditInTx(db, {
      action: 'org.create',
      actorId: userId,
      targetType: 'organization',
      targetId: org.id,
      meta: { name },
    });
    await tx.user.update({ where: { id: userId }, data: { orgId: org.id, role: 'OWNER' } });
    return org;
  });
  invalidateMembership(userId, org.id);
  return { id: org.id, name: org.name, plan: org.plan };
}

/**
 * トライアルは**作成者ごとに1回**（設計書 Q3 仮採用）。
 * 組織を自分で作れるようになったので、組織ごとに1回のままだと組織を作るたびに無料期間が取れてしまう。
 * 作成者が作った別の組織で一度でもトライアル/契約を始めていれば、使用済みとみなす。
 * 作成者が分からない（移行前の）組織は、従来どおり組織ごとの判定だけにする。
 */
export async function creatorTrialUsed(org: { id: string; createdBy: string | null }): Promise<boolean> {
  if (!org.createdBy) return false;
  const other = await prisma.organization.count({
    where: {
      createdBy: org.createdBy,
      id: { not: org.id },
      OR: [{ trialEndsAt: { not: null } }, { stripeSubscriptionId: { not: null } }],
    },
  });
  return other > 0;
}
