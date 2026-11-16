import type { FastifyRequest, FastifyReply } from 'fastify';
import { hasRoleAtLeast, type UserRole } from '@org-ai/shared-types';
import { prisma } from '../utils/prisma';
import { READ_ONLY_MESSAGE, entitlementOf, needsEntitlementCheck } from '../services/entitlement';
import { sendError } from '../utils/http-error';

/**
 * 認証と権限。
 *
 * 二段構えにしている理由:
 *   requireAuth  … JWT を検証する。読み取りでは DB を引かない（すべてのリクエストが通るので、
 *                  ここに1クエリ足すと全体に効いてしまう）。書き込みのときだけ契約を確認し、
 *                  解約済みの組織を「閲覧のみ」にする。
 *   requireRole  … 危険な操作の前でだけ DB を引く。低頻度なので +1 クエリは無視でき、
 *                  **降格と無効化が即座に効く**。昇格が遅れるのは無害だが、
 *                  降格が効かないのは事故なので、効かせるべきはこちら。
 *
 * ⚠️ JWT には role が入っているが、**権限判定にそれを使わない**。
 *    role を変えても既存トークンには反映されず、退職者のトークンが有効期限まで
 *    最強権限のまま生き続けることになる。
 */

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    sendError(reply, 401, 'AUTH_REQUIRED', '認証が必要です');
    return;
  }

  /* 契約が切れた組織は書き込みだけ止める（閲覧と書き出しは通す）。
     ⚠️ 決済と認証の経路は必ず通す。ここを止めると再開する手段が無くなる。 */
  if (!needsEntitlementCheck(request.method, request.url)) return;
  const { orgId } = (request.user ?? {}) as { orgId?: string };
  if (!orgId) return;
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { subscriptionStatus: true },
  });
  if (org && entitlementOf(org.subscriptionStatus) === 'read_only') {
    sendError(reply, 402, 'SUBSCRIPTION_REQUIRED', READ_ONLY_MESSAGE);
  }
}

/**
 * 指定した役割以上を要求する。
 *
 * DB の user を正本として role / status / orgId を読み直し、request.user を上書きする。
 * これで「JWT の orgId が古い」「無効化済み」を権限ルートの入口で必ず捕まえられる。
 */
export function requireRole(required: UserRole) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuth(request, reply);
    // 認証失敗時は requireAuth が 401 を送信済み。続行すると request.user 未定義で落ちる
    if (reply.sent) return;

    const payload = request.user as { sub?: string };
    const user = payload?.sub
      ? await prisma.user.findUnique({
          where: { id: payload.sub },
          select: { id: true, role: true, status: true, orgId: true, email: true },
        })
      : null;

    /* ⚠️ 見つからない・無効化済みは 401（403 ではない）。
       「権限が足りない」ではなく「そのアカウントはもう使えない」ので、
       フロントの 401→ログアウト導線に乗せる。 */
    if (!user || user.status !== 'ACTIVE' || !user.orgId) {
      sendError(reply, 401, 'AUTH_REQUIRED', 'このアカウントは利用できません。管理者にご確認ください。');
      return;
    }

    if (!hasRoleAtLeast(user.role, required)) {
      sendError(reply, 403, 'FORBIDDEN', required === 'OWNER' ? 'この操作はオーナーのみ行えます' : 'この操作には管理者権限が必要です');
      return;
    }

    /* DB を正本にして上書きする。以降のハンドラは request.user.orgId を信用してよい */
    request.user = { ...(request.user as object), role: user.role, orgId: user.orgId, sub: user.id };
  };
}

/** 管理者以上（OWNER も通る）。連携・外部APIノード・エージェント定義・監査の閲覧。 */
export const requireAdmin = requireRole('ADMIN');

/**
 * オーナーのみ。人の出し入れと、組織・請求先の変更。
 * ⚠️ 名前と意味を1対1に保つこと。requireOwner の中身を「ADMIN も通す」に緩めると、
 *    メンバー管理を requireOwner で守ったつもりが ADMIN も通る、という穴になる。
 */
export const requireOwner = requireRole('OWNER');
