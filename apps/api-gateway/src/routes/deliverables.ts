import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth } from '../middleware/auth';
import { aiEngineHeaders } from '../services/ai-engine-auth';

const rankSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        summary: z.string().optional(),
        department: z.string().optional(),
      }),
    )
    .max(200),
});

/** 成果物の重要度づけ等。重要度推定は AI Engine /rank に委譲（ベストエフォート）。 */
export async function deliverablesRoutes(app: FastifyInstance): Promise<void> {
  app.post('/rank', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const parsed = rankSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    if (parsed.data.items.length === 0) {
      return reply.send({ success: true, data: { rankings: [] } });
    }

    const org = await prisma.organization.findUnique({ where: { id: payload.orgId } });
    const plan = org?.plan ?? 'STARTER';
    const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://ai-engine:8000';
    try {
      const res = await fetch(`${aiEngineUrl}/rank`, {
        method: 'POST',
        headers: aiEngineHeaders(),
        body: JSON.stringify({ items: parsed.data.items, org_id: payload.orgId, plan }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) return reply.send({ success: true, data: { rankings: [] } });
      const data = (await res.json()) as { rankings: { id: string; importance: string; reason?: string }[] };
      return reply.send({ success: true, data });
    } catch {
      // 失敗してもUIを止めない（フロントは mid 既定にフォールバック）
      return reply.send({ success: true, data: { rankings: [] } });
    }
  });
}
