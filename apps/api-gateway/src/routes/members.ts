import { createHash, randomBytes } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { isUserRole } from '@org-ai/shared-types';
// 招待のプレビューと受諾（認証の無い経路）だけが素の prisma を使う（アーキテクチャテストの allowlist）
import { prisma } from '../utils/prisma';
import { authOf } from '../tenancy';
import { requireAuth, requireOwner, requireUser, userOf } from '../middleware/auth';
import { config } from '../config/env';
import { sendError } from '../utils/http-error';
import { listActiveMemberships, mirrorRoleToUser, rememberActiveOrg, signAccessToken } from '../services/memberships';
import { invalidateMembership } from '../tenancy/membership-cache';
import { tenantDbFrom } from '../tenancy/tenant-db';
import { recordAudit, recordAuditInTx } from '../services/audit';
import { INVITE_RATE_LIMIT } from '../middleware/rate-limit';
import { emailSchema, normalizeEmail } from '../utils/email';

/**
 * メンバーと招待。prefix: `/api/members`
 *
 * ここが「組織型」を名乗るための最低条件。これが無いと1人用ツールになる。
 *
 * ⚠️ **メールは1通も送れない**（nodemailer/resend/SES すべて依存に無い）。
 *    なので招待は「管理者がリンクを発行して手渡す」方式にしてある。
 *    メールを足すときは、発行直後に送る処理を1つ挟むだけでよい。
 *
 * ⚠️ 招待トークンは **ハッシュだけ**を保存する。生値は発行時のレスポンスに1回出るきり。
 *    DB を読まれても招待を成立させられないようにするため。
 */

/** 招待リンクの既定の有効期限（日）。手渡し前提なので当日中に踏まれるとは限らない。 */
const INVITE_TTL_DAYS = config.inviteTtlDays;

const createInviteSchema = z.object({
  email: emailSchema.max(200).optional(),
  /** OWNER は招待では渡さない（オーナーの移譲は別の操作にする） */
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});

const acceptSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
});

const acceptExistingSchema = z.object({ token: z.string().min(20).max(200) });

const changeRoleSchema = z.object({ role: z.enum(['ADMIN', 'MEMBER']) });

/** 生トークン → 保存用ハッシュ。照合するだけなので可逆暗号にしない（OAuth state と同じ流儀）。 */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  /** メンバー一覧。全員が見てよい（誰が同僚かは隠す情報ではない）。
   *  role / status は**この組織の** Membership のもの（User.role / User.status ではない）。 */
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId, db } = authOf(request);
    const rows = await db.membership.findMany({
      where: { orgId },
      select: {
        role: true,
        status: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    const users = rows.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      status: m.status,
      createdAt: m.createdAt,
    }));
    return reply.send({ success: true, data: users });
  });

  /** 招待の一覧（保留中のみ）。オーナーだけ。 */
  app.get('/invitations', { preHandler: requireOwner }, async (request, reply) => {
    const { orgId, db } = authOf(request);
    const invitations = await db.invitation.findMany({
      where: { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ success: true, data: invitations });
  });

  /**
   * 招待を発行する。**生トークンはこの応答にしか出ない。**
   * 管理者はこのリンクを本人へ手渡す（口頭・Slack・LINE など）。
   */
  app.post('/invitations', { preHandler: requireOwner }, async (request, reply) => {
    const payload = authOf(request);
    const { db } = payload;
    const parsed = createInviteSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? '入力が不正です');
    }

    /* 既に**この組織に**所属している人には招待しない。
       別の組織で登録済みの人は招待できる（ログインして「参加」する。設計書 UC2 / §10.3）。
       メールは任意なので、指定があるときだけ確認する。 */
    if (parsed.data.email) {
      const already = await db.membership.findFirst({
        where: { user: { email: parsed.data.email } },
        select: { id: true },
      });
      if (already) {
        return sendError(reply, 409, 'CONFLICT', 'このメールアドレスの方は既にこの組織のメンバーです');
      }
    }

    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    const invitation = await db.invitation.create({
      data: {
        orgId: payload.orgId,
        email: parsed.data.email ?? null,
        role: parsed.data.role,
        tokenHash: hashToken(raw),
        expiresAt,
        createdBy: payload.sub,
      },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    });

    // ⚠️ 監査にも token は入れない
    await recordAudit(db, {
      action: 'member.invite',
      actorId: payload.sub,
      targetType: 'invitation',
      targetId: invitation.id,
      meta: { email: invitation.email, role: invitation.role },
    });

    /* ⚠️ token はここでしか返らない。ログにも出さないこと。 */
    return reply.code(201).send({
      success: true,
      data: { ...invitation, token: raw, expiresInDays: INVITE_TTL_DAYS },
    });
  });

  /** 招待を取り消す。 */
  app.delete('/invitations/:invitationId', { preHandler: requireOwner }, async (request, reply) => {
    const { orgId, db, sub } = authOf(request);
    const { invitationId } = request.params as { invitationId: string };
    const result = await db.invitation.updateMany({
      where: { id: invitationId, orgId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      return sendError(reply, 404, 'NOT_FOUND', '招待が見つかりません');
    }
    await recordAudit(db, { action: 'member.invite_revoke', actorId: sub, targetType: 'invitation', targetId: invitationId });
    return reply.send({ success: true, data: { id: invitationId } });
  });

  /**
   * 招待の内容を見る（受諾画面の表示用）。**認証不要**。
   * ⚠️ 返すのは組織名と役割だけ。メールアドレスや発行者は返さない
   *    （リンクを拾った第三者に組織の内情を教えない）。
   */
  app.get('/invitations/preview/:token', { config: { rateLimit: INVITE_RATE_LIMIT } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const invitation = await prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        role: true,
        email: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        org: { select: { name: true } },
      },
    });

    /* 無効な理由を細かく返さない（トークンの当てずっぽうに情報を与えない） */
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date()) {
      return sendError(reply, 404, 'NOT_FOUND', 'この招待リンクは使えません（期限切れ、または既に使用済みです）');
    }

    /* 招待のメールの人が既に登録済みなら、新しいアカウントを作らずにログインして参加してもらう。
       ⚠️ これで「そのメールが登録済みか」が分かるが、リンク（トークン）を持つ人にしか見えないので許容する
       （設計書 Q2 仮採用）。メールアドレス自体は返さない。 */
    const requiresLogin = invitation.email
      ? !!(await prisma.user.findUnique({ where: { email: normalizeEmail(invitation.email) }, select: { id: true } }))
      : false;

    return reply.send({
      success: true,
      data: {
        organizationName: invitation.org.name,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        requiresLogin,
      },
    });
  });

  /**
   * 招待を受諾してアカウントを作る。**認証不要**（これから作るので）。
   *
   * ⚠️ orgId と role は **招待レコードから取る**。リクエストボディの値は一切信用しない。
   *    ここを body 由来にすると、任意の組織に任意の権限で入れる穴になる。
   */
  app.post('/invitations/accept', { config: { rateLimit: INVITE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = acceptSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? '入力が不正です');
    }
    const { token, name, password } = parsed.data;
    const tokenHash = hashToken(token);

    const invitation = await prisma.invitation.findUnique({ where: { tokenHash } });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date()) {
      return sendError(reply, 404, 'NOT_FOUND', 'この招待リンクは使えません（期限切れ、または既に使用済みです）');
    }

    /* メールは招待に書いてあればそれを使う。無ければ受諾者が名乗る必要があるが、
       今回は「招待にメールが無ければ受諾できない」ことにして曖昧さを消す。 */
    if (!invitation.email) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'この招待にはメールアドレスが設定されていません。管理者に再発行を依頼してください。');
    }

    // 移行前の招待は大文字を含むことがあるので、照合・作成の前に揃える
    const inviteEmail = normalizeEmail(invitation.email);
    const existing = await prisma.user.findUnique({ where: { email: inviteEmail }, select: { id: true } });
    if (existing) {
      // 既に登録済みの人はアカウントを作らず、ログインして accept-existing で参加する
      return sendError(reply, 409, 'ACCOUNT_EXISTS', 'このメールアドレスは登録済みです。ログインしてから参加してください。');
    }

    const passwordHash = await bcrypt.hash(password, 10);

    /* ⚠️ 招待の消費とユーザー作成は同一トランザクション。
       別々にすると、同じリンクを2回同時に踏まれて2人できる。
       updateMany の条件に acceptedAt: null を入れて、勝った1回だけが進む。 */
    const created = await prisma.$transaction(async (tx) => {
      const claim = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (claim.count === 0) return null;

      const role = isUserRole(invitation.role) && invitation.role !== 'OWNER' ? invitation.role : 'MEMBER';
      const user = await tx.user.create({
        // User.role / User.orgId は移行期間中の写し（正本は Membership）
        data: {
          email: inviteEmail,
          passwordHash,
          name,
          role,
          orgId: invitation.orgId,
        },
        select: { id: true, name: true, email: true, role: true, orgId: true },
      });
      await tx.membership.create({
        data: { userId: user.id, orgId: invitation.orgId, role, invitedBy: invitation.createdBy },
      });
      await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedBy: user.id } });
      await recordAuditInTx(tenantDbFrom(tx, invitation.orgId), {
        action: 'member.join',
        actorId: user.id,
        targetType: 'user',
        targetId: user.id,
        meta: { role, invitationId: invitation.id },
      });
      return user;
    });

    if (!created) {
      return sendError(reply, 409, 'CONFLICT', 'この招待は既に使用されています');
    }

    const jwtToken = signAccessToken(app, {
      userId: created.id,
      orgId: created.orgId,
      role: created.role,
      email: created.email,
    });
    return reply.code(201).send({ success: true, data: { token: jwtToken, user: created } });
  });

  /** 役割を変える。オーナーだけ。OWNER への昇格はここではできない。 */
  app.patch('/:userId/role', { preHandler: requireOwner }, async (request, reply) => {
    const payload = authOf(request);
    const { db } = payload;
    const { userId } = request.params as { userId: string };
    const parsed = changeRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '不正な役割です');
    }

    /* ⚠️ 自分を降格させない。オーナーが0人の組織ができると、
       以降そこに誰も追加できなくなる（復旧手段が DB 直編集しか無くなる）。 */
    if (userId === payload.sub) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '自分自身の役割は変更できません');
    }

    const result = await db.membership.updateMany({
      where: { userId, orgId: payload.orgId },
      data: { role: parsed.data.role },
    });
    if (result.count === 0) {
      return sendError(reply, 404, 'NOT_FOUND', 'メンバーが見つかりません');
    }
    // 移行期間中の写し（User.orgId が同じ組織のときだけ）+ キャッシュの破棄
    await mirrorRoleToUser(userId, payload.orgId, parsed.data.role);
    await recordAudit(db, {
      action: 'member.role_change',
      actorId: payload.sub,
      targetType: 'user',
      targetId: userId,
      meta: { role: parsed.data.role },
    });
    return reply.send({ success: true, data: { id: userId, role: parsed.data.role } });
  });

  /**
   * メンバーを**この組織から**無効化 / 復帰させる（Membership.status）。他の組織の利用には影響しない。
   * アカウント全体の停止（User.status）は運営者の操作で、ここでは変えない（ADR-2）。
   * ⚠️ 物理削除はしない。Agent.createdBy などが User.id を FK 無しで参照しており、
   *    消すと「誰が作ったか」が辿れなくなる（監査が壊れる）。
   */
  app.patch('/:userId/status', { preHandler: requireOwner }, async (request, reply) => {
    const payload = authOf(request);
    const { db } = payload;
    const { userId } = request.params as { userId: string };
    const body = request.body as { status?: string };
    if (body?.status !== 'ACTIVE' && body?.status !== 'DISABLED') {
      return sendError(reply, 400, 'VALIDATION_ERROR', '不正な状態です');
    }
    if (userId === payload.sub) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '自分自身を無効化することはできません');
    }

    const result = await db.membership.updateMany({
      where: { userId, orgId: payload.orgId },
      data: { status: body.status },
    });
    if (result.count === 0) {
      return sendError(reply, 404, 'NOT_FOUND', 'メンバーが見つかりません');
    }
    // 外した人のトークンを、キャッシュの TTL を待たずに止める（同じプロセス内）
    invalidateMembership(userId, payload.orgId);
    await recordAudit(db, {
      action: 'member.status_change',
      actorId: payload.sub,
      targetType: 'user',
      targetId: userId,
      meta: { status: body.status },
    });
    return reply.send({ success: true, data: { id: userId, status: body.status } });
  });

  /**
   * 既に登録済みのユーザーが招待を受けて組織に参加する（設計書 UC2 / §10.3）。
   * ログイン中（requireUser）であることに加えて、**ログイン中の本人のメールが招待のメールと一致すること**を要求する
   * （リンクを拾った別人が自分のアカウントで入るのを防ぐ）。
   * 参加したら新しい組織用のトークンを返す（そのまま切り替わる）。
   */
  app.post('/invitations/accept-existing', { preHandler: requireUser, config: { rateLimit: INVITE_RATE_LIMIT } }, async (request, reply) => {
    const { sub } = userOf(request);
    const parsed = acceptExistingSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? '入力が不正です');
    }
    const invitation = await prisma.invitation.findUnique({ where: { tokenHash: hashToken(parsed.data.token) } });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date()) {
      return sendError(reply, 404, 'NOT_FOUND', 'この招待リンクは使えません（期限切れ、または既に使用済みです）');
    }
    const me = await prisma.user.findUnique({ where: { id: sub }, select: { id: true, name: true, email: true } });
    if (!me) {
      return sendError(reply, 401, 'AUTH_REQUIRED', '認証が必要です');
    }
    if (!invitation.email || normalizeEmail(invitation.email) !== normalizeEmail(me.email)) {
      return sendError(reply, 403, 'INVITATION_EMAIL_MISMATCH', 'この招待は別のメールアドレス宛てです。招待されたアカウントでログインしてください。');
    }
    const already = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: me.id, orgId: invitation.orgId } },
      select: { status: true },
    });
    if (already) {
      return sendError(
        reply,
        409,
        'CONFLICT',
        already.status === 'ACTIVE'
          ? '既にこの組織のメンバーです'
          : 'この組織での利用が停止されています。組織のオーナーにご確認ください。',
      );
    }

    // ⚠️ orgId / role は招待から取る。招待の消費と所属の作成は同じトランザクション（2回押しで2件作らない）
    const role = isUserRole(invitation.role) && invitation.role !== 'OWNER' ? invitation.role : 'MEMBER';
    const ok = await prisma.$transaction(async (tx) => {
      const claim = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date(), acceptedBy: me.id },
      });
      if (claim.count === 0) return false;
      await tx.membership.create({
        data: { userId: me.id, orgId: invitation.orgId, role, invitedBy: invitation.createdBy },
      });
      await recordAuditInTx(tenantDbFrom(tx, invitation.orgId), {
        action: 'member.join',
        actorId: me.id,
        targetType: 'user',
        targetId: me.id,
        meta: { role, invitationId: invitation.id },
      });
      return true;
    });
    if (!ok) {
      return sendError(reply, 409, 'CONFLICT', 'この招待は既に使用されています');
    }
    invalidateMembership(me.id, invitation.orgId);
    await rememberActiveOrg(me.id, invitation.orgId, role);
    const jwtToken = signAccessToken(app, { userId: me.id, orgId: invitation.orgId, role, email: me.email });
    return reply.code(201).send({
      success: true,
      data: { token: jwtToken, user: { ...me, orgId: invitation.orgId, role }, memberships: await listActiveMemberships(me.id) },
    });
  });
}
