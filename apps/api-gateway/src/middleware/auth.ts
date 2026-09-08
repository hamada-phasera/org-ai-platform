import type { FastifyRequest, FastifyReply } from 'fastify';

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({
      success: false,
      error: { code: 'AUTH_REQUIRED', message: '認証が必要です' },
    });
  }
}

export async function requireOwner(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return; // 認証失敗時は requireAuth が 401 を送信済み。続行すると request.user 未定義で落ちる
  const user = request.user as { role: string };
  if (user.role !== 'OWNER') {
    reply.code(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'この操作にはOWNER権限が必要です' },
    });
  }
}
