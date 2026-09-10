import { createHash, randomBytes } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { isUserRole } from '@org-ai/shared-types';
import { prisma } from '../utils/prisma';
import { requireAuth, requireOwner } from '../middleware/auth';

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
const INVITE_TTL_DAYS = Number(process.env.INVITE_TTL_DAYS ?? 7);

const createInviteSchema = z.object({
  email: z.string().email().max(200).optional(),
  /** OWNER は招待では渡さない（オーナーの移譲は別の操作にする） */
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});

const acceptSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
});

const changeRoleSchema = z.object({ role: z.enum(['ADMIN', 'MEMBER']) });

/** 生トークン → 保存用ハッシュ。照合するだけなので可逆暗号にしない（OAuth state と同じ流儀）。 */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  /** メンバー一覧。全員が見てよい（誰が同僚かは隠す情報ではない）。 */
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const users = await prisma.user.findMany({
      where: { orgId },
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    return reply.send({ success: true, data: users });
  });

  /** 招待の一覧（保留中のみ）。オーナーだけ。 */
  app.get('/invitations', { preHandler: requireOwner }, async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const invitations = await prisma.invitation.findMany({
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
    const payload = request.user as { orgId: string; sub: string };
    const parsed = createInviteSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? '入力が不正です' },
      });
    }

    /* 既に同じメールの利用者がいるなら招待しない（重複アカウントを作らせない）。
       メールは任意なので、指定があるときだけ確認する。 */
    if (parsed.data.email) {
      const existing = await prisma.user.findUnique({
        where: { email: parsed.data.email },
        select: { id: true },
      });
      if (existing) {
        return reply.code(409).send({
          success: false,
          error: { code: 'CONFLICT', message: 'このメールアドレスは既に登録されています' },
        });
      }
    }

    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    const invitation = await prisma.invitation.create({
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

    /* ⚠️ token はここでしか返らない。ログにも出さないこと。 */
    return reply.code(201).send({
      success: true,
      data: { ...invitation, token: raw, expiresInDays: INVITE_TTL_DAYS },
    });
  });

  /** 招待を取り消す。 */
  app.delete('/invitations/:invitationId', { preHandler: requireOwner }, async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { invitationId } = request.params as { invitationId: string };
    const result = await prisma.invitation.updateMany({
      where: { id: invitationId, orgId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: '招待が見つかりません' } });
    }
    return reply.send({ success: true, data: { id: invitationId } });
  });

  /**
   * 招待の内容を見る（受諾画面の表示用）。**認証不要**。
   * ⚠️ 返すのは組織名と役割だけ。メールアドレスや発行者は返さない
   *    （リンクを拾った第三者に組織の内情を教えない）。
   */
  app.get('/invitations/preview/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const invitation = await prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { role: true, expiresAt: true, acceptedAt: true, revokedAt: true, org: { select: { name: true } } },
    });

    /* 無効な理由を細かく返さない（トークンの当てずっぽうに情報を与えない） */
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date()) {
      return reply.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'この招待リンクは使えません（期限切れ、または既に使用済みです）' },
      });
    }

    return reply.send({
      success: true,
      data: { organizationName: invitation.org.name, role: invitation.role, expiresAt: invitation.expiresAt },
    });
  });

  /**
   * 招待を受諾してアカウントを作る。**認証不要**（これから作るので）。
   *
   * ⚠️ orgId と role は **招待レコードから取る**。リクエストボディの値は一切信用しない。
   *    ここを body 由来にすると、任意の組織に任意の権限で入れる穴になる。
   */
  app.post('/invitations/accept', async (request, reply) => {
    const parsed = acceptSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? '入力が不正です' },
      });
    }
    const { token, name, password } = parsed.data;
    const tokenHash = hashToken(token);

    const invitation = await prisma.invitation.findUnique({ where: { tokenHash } });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date()) {
      return reply.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'この招待リンクは使えません（期限切れ、または既に使用済みです）' },
      });
    }

    /* メールは招待に書いてあればそれを使う。無ければ受諾者が名乗る必要があるが、
       今回は「招待にメールが無ければ受諾できない」ことにして曖昧さを消す。 */
    if (!invitation.email) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'この招待にはメールアドレスが設定されていません。管理者に再発行を依頼してください。' },
      });
    }

    const existing = await prisma.user.findUnique({ where: { email: invitation.email }, select: { id: true } });
    if (existing) {
      return reply
        .code(409)
        .send({ success: false, error: { code: 'CONFLICT', message: 'このメールアドレスは既に登録されています' } });
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

      const user = await tx.user.create({
        data: {
          email: invitation.email as string,
          passwordHash,
          name,
          role: isUserRole(invitation.role) ? invitation.role : 'MEMBER',
          orgId: invitation.orgId,
        },
        select: { id: true, name: true, email: true, role: true, orgId: true },
      });
      await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedBy: user.id } });
      return user;
    });

    if (!created) {
      return reply.code(409).send({
        success: false,
        error: { code: 'CONFLICT', message: 'この招待は既に使用されています' },
      });
    }

    const jwtToken = app.jwt.sign(
      { sub: created.id, orgId: created.orgId, role: created.role, email: created.email },
      { expiresIn: process.env.JWT_EXPIRES_IN ?? '24h' },
    );
    return reply.code(201).send({ success: true, data: { token: jwtToken, user: created } });
  });

  /** 役割を変える。オーナーだけ。OWNER への昇格はここではできない。 */
  app.patch('/:userId/role', { preHandler: requireOwner }, async (request, reply) => {
    const payload = request.user as { orgId: string; sub: string };
    const { userId } = request.params as { userId: string };
    const parsed = changeRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: '不正な役割です' } });
    }

    /* ⚠️ 自分を降格させない。オーナーが0人の組織ができると、
       以降そこに誰も追加できなくなる（復旧手段が DB 直編集しか無くなる）。 */
    if (userId === payload.sub) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: '自分自身の役割は変更できません' },
      });
    }

    const result = await prisma.user.updateMany({
      where: { id: userId, orgId: payload.orgId },
      data: { role: parsed.data.role },
    });
    if (result.count === 0) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'メンバーが見つかりません' } });
    }
    return reply.send({ success: true, data: { id: userId, role: parsed.data.role } });
  });

  /**
   * メンバーを無効化 / 復帰させる。
   * ⚠️ 物理削除はしない。Agent.createdBy などが User.id を FK 無しで参照しており、
   *    消すと「誰が作ったか」が辿れなくなる（監査が壊れる）。
   */
  app.patch('/:userId/status', { preHandler: requireOwner }, async (request, reply) => {
    const payload = request.user as { orgId: string; sub: string };
    const { userId } = request.params as { userId: string };
    const body = request.body as { status?: string };
    if (body?.status !== 'ACTIVE' && body?.status !== 'DISABLED') {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: '不正な状態です' } });
    }
    if (userId === payload.sub) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: '自分自身を無効化することはできません' },
      });
    }

    const result = await prisma.user.updateMany({
      where: { id: userId, orgId: payload.orgId },
      data: { status: body.status },
    });
    if (result.count === 0) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'メンバーが見つかりません' } });
    }
    return reply.send({ success: true, data: { id: userId, status: body.status } });
  });
}
