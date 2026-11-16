import type { FastifyInstance } from 'fastify';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireUser } from '../middleware/auth';
import { sendError } from '../utils/http-error';
import {
  findActiveMembership,
  listActiveMemberships,
  loadUserProfile,
  pickActiveOrg,
  rememberActiveOrg,
  signAccessToken,
} from '../services/memberships';
import { seedDefaultCapabilities } from '../services/organizations';
import { tenantDbFrom } from '../tenancy/tenant-db';

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  orgName: z.string().min(1),
});

const switchOrgSchema = z.object({ orgId: z.string().min(1).max(100) });

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
      // 新しい組織に既定のノードを入れる（以前は seed スクリプトを手で流すまで空だった。E8）
      await seedDefaultCapabilities(tenantDbFrom(tx, org.id));
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

  /* 所属している組織の一覧（組織をまたぐのでユーザー単位。スイッチャーが使う）。 */
  app.get('/memberships', { preHandler: requireUser }, async (request, reply) => {
    const { sub } = request.user as { sub: string };
    return reply.send({ success: true, data: await listActiveMemberships(sub) });
  });

  /*
   * 組織を切り替える = その組織用の新しいトークンを発行する（設計書 ADR-3）。
   * ⚠️ body の orgId は「どこに切り替えたいか」の希望にすぎない。Membership が ACTIVE なときだけ発行する。
   *    所属していない・無効化された・存在しない組織は区別せずに 403 TENANT_NOT_MEMBER（存在を漏らさない）。
   * 古いトークン（前の組織用）はそのまま有効（トークンは組織ごとに独立。所属が有効な間だけ通る）。
   */
  app.post('/switch-org', { preHandler: requireUser }, async (request, reply) => {
    const { sub } = request.user as { sub: string };
    const parsed = switchOrgSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '切り替え先の組織を指定してください');
    }
    const target = await findActiveMembership(sub, parsed.data.orgId);
    if (!target) {
      return sendError(reply, 403, 'TENANT_NOT_MEMBER', 'この組織には所属していません');
    }
    const profile = await loadUserProfile(sub);
    if (!profile) {
      return sendError(reply, 401, 'AUTH_REQUIRED', '認証が必要です');
    }
    // 次にログインしたときの既定の組織（+ 移行期間中の User.role の写し）
    await rememberActiveOrg(sub, target.orgId, target.role);
    const token = signAccessToken(app, { userId: sub, orgId: target.orgId, role: target.role, email: profile.email });
    return reply.send({
      success: true,
      data: {
        token,
        user: { ...profile, orgId: target.orgId, role: target.role },
        memberships: await listActiveMemberships(sub),
      },
    });
  });
}
