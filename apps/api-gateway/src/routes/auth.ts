import type { FastifyInstance } from 'fastify';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth } from '../middleware/auth';
import { config } from '../config/env';
import { sendError } from '../utils/http-error';

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

    const org = await prisma.organization.create({
      data: { name: orgName, plan: 'STARTER' },
    });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      /* 新しい組織を作った本人がオーナー。以降のメンバーは招待から入る
         （Invitation の role は ADMIN|MEMBER のみ）。 */
      data: { name, email, passwordHash, role: 'OWNER', orgId: org.id },
    });

    const token = app.jwt.sign(
      // email は LLM 松竹梅ルーティングの admin 判定（ADMIN_EMAILS）に使う
      { sub: user.id, orgId: org.id, role: user.role, email: user.email },
      { expiresIn: config.jwtExpiresIn },
    );

    return reply.code(201).send({
      success: true,
      data: { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, orgId: org.id } },
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

    const token = app.jwt.sign(
      // email は LLM 松竹梅ルーティングの admin 判定（ADMIN_EMAILS）に使う
      { sub: user.id, orgId: user.orgId, role: user.role, email: user.email },
      { expiresIn: config.jwtExpiresIn },
    );

    return reply.send({
      success: true,
      data: { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, orgId: user.orgId } },
    });
  });

  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, email: true, role: true, orgId: true, createdAt: true },
    });
    if (!user) {
      return sendError(reply, 404, 'NOT_FOUND', 'ユーザーが見つかりません');
    }
    return reply.send({ success: true, data: user });
  });
}
