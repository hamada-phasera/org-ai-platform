import type { FastifyRequest, FastifyReply } from 'fastify';
import { hasRoleAtLeast, isUserRole, type UserRole } from '@org-ai/shared-types';
import { prisma } from '../utils/prisma';
import { READ_ONLY_MESSAGE, entitlementOf, needsEntitlementCheck } from '../services/entitlement';
import { sendError } from '../utils/http-error';
import { getMembership } from '../tenancy/membership-cache';
import { enterTenant, makeTenantContext } from '../tenancy/context';

/**
 * 認証と、テナント（組織）の解決。docs/design/multi-tenancy.md §7.1.3
 *
 *   requireUser  … JWT を検証し、アカウントが有効かだけを見る。組織を選ぶ前の操作
 *                  （所属一覧・組織の切り替え・組織の作成・招待の受諾）用。
 *   requireAuth  … JWT の orgId を「このトークンが操作してよい唯一の組織」として、
 *                  **毎リクエスト** Membership(sub, orgId) が ACTIVE かを確かめる（30 秒キャッシュ）。
 *                  通ったら request.tenant = { orgId, userId, role(Membership), db: tenantDb(orgId) }。
 *                  書き込みでは契約も見て、解約済みの組織を「閲覧のみ」にする。
 *   requireRole  … requireAuth に加えて、**キャッシュを通さず** DB の Membership.role を見る。
 *                  降格と無効化が即座に効く（効かせるべきはこちら）。
 *
 * ⚠️ JWT には role が入っているが、**権限判定にそれを使わない**。
 *    role を変えても既存トークンには反映されず、退職者のトークンが有効期限まで
 *    最強権限のまま生き続けることになる。判定は Membership.role だけ。
 *
 * エラー:
 *   401 AUTH_REQUIRED          … トークンが無い/壊れている、アカウントが無い/無効（フロントはログアウトへ）
 *   403 TENANT_REQUIRED        … 所属している組織が無い（組織を作るか招待を受ける）
 *   403 TENANT_ACCESS_REVOKED  … トークンの組織から外された/無効化された（ログアウトさせず、組織一覧へ）
 *   402 SUBSCRIPTION_REQUIRED  … 解約済みの組織への書き込み
 *   403 FORBIDDEN              … 役割が足りない
 */

interface JwtUser {
  sub?: string;
  orgId?: string | null;
  role?: string;
  email?: string;
}

const ACCOUNT_UNAVAILABLE = 'このアカウントは利用できません。管理者にご確認ください。';

async function verifyJwt(request: FastifyRequest, reply: FastifyReply): Promise<JwtUser | null> {
  try {
    await request.jwtVerify();
  } catch {
    sendError(reply, 401, 'AUTH_REQUIRED', '認証が必要です');
    return null;
  }
  const user = (request.user ?? {}) as JwtUser;
  if (!user.sub) {
    sendError(reply, 401, 'AUTH_REQUIRED', '認証が必要です');
    return null;
  }
  return user;
}

/**
 * JWT とアカウントの有効性だけを確かめる（組織は問わない）。
 * 組織を選ぶ前の操作用。request.tenant は作らない。
 */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const jwtUser = await verifyJwt(request, reply);
  if (!jwtUser) return;
  const user = await prisma.user.findUnique({ where: { id: jwtUser.sub }, select: { status: true } });
  if (!user || user.status !== 'ACTIVE') {
    sendError(reply, 401, 'AUTH_REQUIRED', ACCOUNT_UNAVAILABLE);
  }
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { bypassCache: boolean },
): Promise<void> {
  const jwtUser = await verifyJwt(request, reply);
  if (!jwtUser) return;

  const orgId = jwtUser.orgId;
  if (!orgId) {
    sendError(reply, 403, 'TENANT_REQUIRED', '所属している組織がありません。招待を受けるか、新しい組織を作成してください。');
    return;
  }

  const snap = await getMembership(jwtUser.sub as string, orgId, { bypassCache: opts.bypassCache });
  /* ⚠️ アカウントが無い・無効化済みは 401（403 ではない）。
     「権限が足りない」ではなく「そのアカウントはもう使えない」ので、フロントの 401→ログアウト導線に乗せる。
     以前は requireAuth が status を見ておらず、無効化した人が大半の API を使い続けられた（E3）。 */
  if (snap.userStatus !== 'ACTIVE') {
    sendError(reply, 401, 'AUTH_REQUIRED', ACCOUNT_UNAVAILABLE);
    return;
  }
  if (!snap.membership || snap.membership.status !== 'ACTIVE') {
    sendError(reply, 403, 'TENANT_ACCESS_REVOKED', 'この組織へのアクセス権がなくなりました');
    return;
  }

  /* 契約が切れた組織は書き込みだけ止める（閲覧と書き出しは通す）。
     ⚠️ 決済と認証の経路は必ず通す。ここを止めると再開する手段が無くなる。 */
  if (needsEntitlementCheck(request.method, request.url) && entitlementOf(snap.subscriptionStatus) === 'read_only') {
    sendError(reply, 402, 'SUBSCRIPTION_REQUIRED', READ_ONLY_MESSAGE);
    return;
  }

  /* 未知の role は MEMBER より下（何も満たさない）。fail-closed */
  const role: UserRole | null = isUserRole(snap.membership.role) ? snap.membership.role : null;
  const tenant = makeTenantContext({ orgId, userId: jwtUser.sub as string, role, source: 'http' });
  request.tenant = tenant;
  /* 以降のハンドラが request.user.role を読んでも Membership の値になるように揃えておく
     （判定に使うのは request.tenant.role だけ。ここは表示用の後方互換） */
  request.user = { ...(request.user as object), role: snap.membership.role, orgId };
  // リクエストの外で続く処理（void runAgentTask(...) など）と aiEngineHeaders() に org を引き継ぐ
  enterTenant(tenant);
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticate(request, reply, { bypassCache: false });
}

/**
 * 指定した役割以上を要求する。Membership を**キャッシュを通さず**読み直す。
 */
export function requireRole(required: UserRole) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await authenticate(request, reply, { bypassCache: true });
    if (reply.sent) return;

    const role = request.tenant?.role ?? null;
    if (!role || !hasRoleAtLeast(role, required)) {
      sendError(reply, 403, 'FORBIDDEN', required === 'OWNER' ? 'この操作はオーナーのみ行えます' : 'この操作には管理者権限が必要です');
    }
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
