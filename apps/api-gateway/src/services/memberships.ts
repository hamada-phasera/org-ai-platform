// 所属（Membership）まわりの共通処理。テナントが決まる前（ログイン・切り替え・招待の受諾）に使うので、
// 素の Prisma を使うシステム経路（アーキテクチャテストの allowlist に入っている）。

import type { FastifyInstance } from 'fastify';
import { isUserRole, type UserRole } from '@org-ai/shared-types';
import { prisma } from '../utils/prisma';
import { config } from '../config/env';
import { invalidateMembership } from '../tenancy/membership-cache';

export interface MembershipSummary {
  orgId: string;
  orgName: string;
  plan: string;
  role: UserRole;
}

/** 有効な所属の一覧（古い順）。組織をまたぐのでユーザー単位。 */
export async function listActiveMemberships(userId: string): Promise<MembershipSummary[]> {
  const rows = await prisma.membership.findMany({
    where: { userId, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { orgId: true, role: true, org: { select: { name: true, plan: true } } },
  });
  return rows
    .filter((r) => isUserRole(r.role))
    .map((r) => ({ orgId: r.orgId, orgName: r.org.name, plan: r.org.plan, role: r.role as UserRole }));
}

/**
 * ログイン時のアクティブ組織を選ぶ（設計書 §5.2 / S5）。
 * User.orgId（最後に選んだ組織）の所属が有効ならそれ、無ければ最も古い有効な所属、それも無ければ null。
 */
export function pickActiveOrg(memberships: MembershipSummary[], preferredOrgId: string | null): MembershipSummary | null {
  return memberships.find((m) => m.orgId === preferredOrgId) ?? memberships[0] ?? null;
}

/**
 * アクセストークンを発行する。中身は { sub, orgId, role(表示用), email, typ }。
 * ⚠️ role は表示用。判定は requireAuth が毎回 Membership を読む。
 * email は LLM 松竹梅ルーティングの admin 判定（ADMIN_EMAILS）に使う。
 */
export function signAccessToken(
  app: FastifyInstance,
  p: { userId: string; orgId: string | null; role: string | null; email: string },
): string {
  return app.jwt.sign(
    { sub: p.userId, orgId: p.orgId, role: p.role, email: p.email, typ: 'access' },
    { expiresIn: config.jwtExpiresIn },
  );
}

/**
 * 「最後に選んだ組織」を更新する。移行期間中は User.role にもその組織の役割を写す
 * （前のバージョンに戻したとき、前のバージョンの requireRole が User.role を読むため。設計書 §9.4）。
 */
export async function rememberActiveOrg(userId: string, orgId: string, role: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { orgId, role } });
}

/**
 * Membership.role を変えたときの二重書き込み。User.orgId が同じ組織のときだけ User.role に写す。
 */
export async function mirrorRoleToUser(userId: string, orgId: string, role: string): Promise<void> {
  await prisma.user.updateMany({ where: { id: userId, orgId }, data: { role } });
  invalidateMembership(userId, orgId);
}

/**
 * 組織の切り替え先として使えるか（設計書 §5.2 / S2〜S4）。
 * 所属していない・無効化されている・組織が無い、はすべて null（区別しない＝存在を漏らさない）。
 */
export async function findActiveMembership(userId: string, orgId: string): Promise<MembershipSummary | null> {
  const m = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { orgId: true, role: true, status: true, org: { select: { name: true, plan: true } } },
  });
  if (!m || m.status !== 'ACTIVE' || !m.org || !isUserRole(m.role)) return null;
  return { orgId: m.orgId, orgName: m.org.name, plan: m.org.plan, role: m.role };
}

/** 本人の表示用の情報（email はトークンに入れる） */
export async function loadUserProfile(userId: string): Promise<{ id: string; name: string; email: string } | null> {
  return prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
}
