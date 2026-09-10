import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth, requireOwner } from '../middleware/auth';
import { resolveAndExecute } from '../services/capability-resolver';

const resolveSchema = z.object({
  rawInput: z.string().optional(),
  name: z.string().nullable().optional(),
  args: z.record(z.unknown()).optional(),
  plan: z.string().optional(),
  // preview = 実行せず内容確認（NEEDS_CONFIRMATION）を返す。承認後は name + args で確定実行する
  mode: z.enum(['execute', 'preview']).optional(),
});

const patchSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(['ACTIVE', 'NEEDS_AUTH', 'DISABLED']).optional(),
  webhookPath: z.string().optional(),
  n8nWorkflowId: z.string().nullable().optional(),
  inputSchema: z.record(z.unknown()).optional(),
});

export async function capabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const caps = await prisma.capability.findMany({
      where: { orgId },
      include: { requiredCreds: true },
      orderBy: { name: 'asc' },
    });
    return reply.send({ success: true, data: caps });
  });

  app.post('/resolve', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { sub: string; orgId: string };
    const parsed = resolveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const result = await resolveAndExecute({
      rawInput: parsed.data.rawInput,
      name: parsed.data.name ?? null,
      args: parsed.data.args ?? {},
      userId: payload.sub,
      orgId: payload.orgId,
      plan: parsed.data.plan,
      mode: parsed.data.mode,
    });
    return reply.send({ success: true, data: result });
  });

  app.patch('/:id', { preHandler: requireOwner }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { orgId } = request.user as { orgId: string };
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const cap = await prisma.capability.findUnique({ where: { id } });
    if (!cap || cap.orgId !== orgId) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'capability が見つかりません' } });
    }
    const updated = await prisma.capability.update({
      where: { id },
      data: {
        ...parsed.data,
        inputSchema: parsed.data.inputSchema as object | undefined,
      },
    });
    return reply.send({ success: true, data: updated });
  });

  app.get('/gaps', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const gaps = await prisma.capabilityGap.findMany({
      where: { orgId },
      orderBy: [{ count: 'desc' }, { updatedAt: 'desc' }],
      take: 100,
    });
    return reply.send({ success: true, data: gaps });
  });

  app.get('/execution-logs', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const query = request.query as { capabilityId?: string; limit?: string };
    const logs = await prisma.executionLog.findMany({
      where: { orgId, ...(query.capabilityId ? { capabilityId: query.capabilityId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(query.limit ?? 50), 200),
    });
    return reply.send({ success: true, data: logs });
  });
}
