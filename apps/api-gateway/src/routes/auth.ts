import type { FastifyInstance } from 'fastify';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth } from '../middleware/auth';

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
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: result.error.message },
      });
    }
    const { name, email, password, orgName } = result.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.code(409).send({
        success: false,
        error: { code: 'AUTH_EMAIL_EXISTS', message: 'このメールアドレスは既に登録されています' },
      });
    }

    const org = await prisma.organization.create({
      data: { name: orgName, plan: 'STARTER' },
    });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, passwordHash, role: 'OWNER', orgId: org.id },
    });

    const token = app.jwt.sign(
      // email は LLM 松竹梅ルーティングの admin 判定（ADMIN_EMAILS）に使う
      { sub: user.id, orgId: org.id, role: user.role, email: user.email },
      { expiresIn: '7d' },
    );

    return reply.code(201).send({
      success: true,
      data: { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, orgId: org.id } },
    });
  });

  app.post('/login', async (request, reply) => {
    const result = loginSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: result.error.message },
      });
    }
    const { email, password } = result.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({
        success: false,
        error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'メールアドレスまたはパスワードが正しくありません' },
      });
    }

    const token = app.jwt.sign(
      // email は LLM 松竹梅ルーティングの admin 判定（ADMIN_EMAILS）に使う
      { sub: user.id, orgId: user.orgId, role: user.role, email: user.email },
      { expiresIn: '7d' },
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
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'ユーザーが見つかりません' } });
    }
    return reply.send({ success: true, data: user });
  });
}
