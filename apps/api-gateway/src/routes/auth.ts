import type { FastifyInstance } from 'fastify';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireUser } from '../middleware/auth';
import { sendError } from '../utils/http-error';
import { listActiveMemberships, pickActiveOrg, signAccessToken } from '../services/memberships';

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  orgName: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/register', async (request, reply) => {
    const result = registerSchema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }
    const { name, email, password, orgName } = result.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return sendError(reply, 409, 'AUTH_EMAIL_EXISTS', 'このメールアドレスは既に登録されています');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    /* 組織・本人・所属は1トランザクションで作る（途中で落ちて「所属の無いオーナー」を残さない）。
       新しい組織を作った本人がオーナー。以降のメンバーは招待から入る（Invitation の role は ADMIN|MEMBER のみ）。 */
    const { org, user } = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { name: orgName, plan: 'STARTER' } });
      const user = await tx.user.create({
        // User.role / User.orgId は移行期間中の写し（正本は Membership）
        data: { name, email, passwordHash, role: 'OWNER', orgId: org.id },
      });
      await tx.membership.create({ data: { userId: user.id, orgId: org.id, role: 'OWNER' } });
      await tx.organization.update({ where: { id: org.id }, data: { createdBy: user.id } });
      return { org, user };
    });

    const token = signAccessToken(app, { userId: user.id, orgId: org.id, role: 'OWNER', email: user.email });
    return reply.code(201).send({
      success: true,
      data: {
        token,
        user: { id: user.id, name: user.name, email: user.email, role: 'OWNER', orgId: org.id },
        memberships: [{ orgId: org.id, orgName: org.name, plan: org.plan, role: 'OWNER' }],
      },
    });
  });

  app.post('/login', async (request, reply) => {
    const result = loginSchema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }
    const { email, password } = result.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return sendError(reply, 401, 'AUTH_INVALID_CREDENTIALS', 'メールアドレスまたはパスワードが正しくありません');
    }
    /* ⚠️ 無効化したアカウントはログインさせない（E3）。
       文言は資格情報の誤りと同じにする（「そのアカウントは止められている」を外に漏らさない）。
       パスワード照合の後に見るのは、照合前に分岐すると応答時間で存在が分かるため。 */
    if (user.status !== 'ACTIVE') {
      return sendError(reply, 401, 'AUTH_INVALID_CREDENTIALS', 'メールアドレスまたはパスワードが正しくありません');
    }

    /* アクティブ組織 = 最後に選んだ組織（User.orgId）の所属が有効ならそれ / 無ければ最も古い有効な所属 /
       それも無ければ null（所属組織なし。招待を受けるか組織を作る画面へ）。 */
    const memberships = await listActiveMemberships(user.id);
    const active = pickActiveOrg(memberships, user.orgId);
    const token = signAccessToken(app, {
      userId: user.id,
      orgId: active?.orgId ?? null,
      role: active?.role ?? null,
      email: user.email,
    });

    return reply.send({
      success: true,
      data: {
        token,
        user: { id: user.id, name: user.name, email: user.email, role: active?.role ?? null, orgId: active?.orgId ?? null },
        memberships,
      },
    });
  });

  /* 自分の情報。組織を選ぶ前でも呼べる（requireUser）。
     orgId / role は**このトークンの**アクティブ組織と、その組織での役割（Membership）。 */
  app.get('/me', { preHandler: requireUser }, async (request, reply) => {
    const payload = request.user as { sub: string; orgId?: string | null };
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true, createdAt: true },
    });
    if (!user) {
      return sendError(reply, 404, 'NOT_FOUND', 'ユーザーが見つかりません');
    }
    const memberships = await listActiveMemberships(user.id);
    const active = memberships.find((m) => m.orgId === payload.orgId) ?? null;
    return reply.send({
      success: true,
      data: { ...user, orgId: active?.orgId ?? null, role: active?.role ?? null, memberships },
    });
  });
}
