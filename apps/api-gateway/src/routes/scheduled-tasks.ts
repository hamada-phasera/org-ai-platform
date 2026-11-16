import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
// agentId は同じ組織のエージェントであること（I3）
import { authOf, assertSameOrg } from '../tenancy';
import { requireAuth } from '../middleware/auth';
import { sendError } from '../utils/http-error';

const DEPARTMENTS = ['SALES', 'MARKETING', 'ACCOUNTING', 'ANALYTICS', 'GENERAL'] as const;
const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;

const createSchema = z.object({
  title: z.string().min(1).max(200),
  department: z.enum(DEPARTMENTS),
  taskType: z.string().min(1).max(50),
  input: z.string().min(1),
  recipientEmail: z.string().email().nullable().optional(),
  frequency: z.enum(FREQUENCIES),
  hourUtc: z.number().int().min(0).max(23),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  enabled: z.boolean().default(true),
  /** 紐づけるエージェント。指定時は定期実行がそのエージェント（steps / instructions）で走る。 */
  agentId: z.string().nullable().optional(),
});

const updateSchema = createSchema.partial();


export async function scheduledTaskRoutes(app: FastifyInstance): Promise<void> {
  // 一覧
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = authOf(request);
    const { db } = payload;
    const tasks = await db.scheduledTask.findMany({
      where: { orgId: payload.orgId },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ success: true, data: tasks });
  });

  // 作成
  app.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = authOf(request);
    const { db } = payload;
    const result = createSchema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }
    const data = result.data;

    // weekly なら dayOfWeek、monthly なら dayOfMonth を要求
    if (data.frequency === 'weekly' && data.dayOfWeek == null) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'weekly には dayOfWeek (0-6) が必要です');
    }
    if (data.frequency === 'monthly' && data.dayOfMonth == null) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'monthly には dayOfMonth (1-31) が必要です');
    }

    if (data.agentId && !(await assertSameOrg(db, 'agent', data.agentId))) {
      return sendError(reply, 404, 'NOT_FOUND', '指定されたエージェントが見つかりません');
    }

    const created = await db.scheduledTask.create({
      data: {
        orgId: payload.orgId,
        title: data.title,
        department: data.department,
        taskType: data.taskType,
        input: data.input,
        recipientEmail: data.recipientEmail ?? null,
        frequency: data.frequency,
        hourUtc: data.hourUtc,
        dayOfWeek: data.dayOfWeek ?? null,
        dayOfMonth: data.dayOfMonth ?? null,
        enabled: data.enabled,
        agentId: data.agentId ?? null,
      },
    });
    return reply.code(201).send({ success: true, data: created });
  });

  // 更新
  app.patch('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const payload = authOf(request);
    const { db } = payload;
    const existing = await db.scheduledTask.findUnique({ where: { id } });
    if (!existing || existing.orgId !== payload.orgId) {
      return sendError(reply, 404, 'NOT_FOUND', '定期タスクが見つかりません');
    }

    const result = updateSchema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }
    if (result.data.agentId && !(await assertSameOrg(db, 'agent', result.data.agentId))) {
      return sendError(reply, 404, 'NOT_FOUND', '指定されたエージェントが見つかりません');
    }

    const updated = await db.scheduledTask.update({
      where: { id },
      data: result.data,
    });
    return reply.send({ success: true, data: updated });
  });

  // 削除
  app.delete('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const payload = authOf(request);
    const { db } = payload;
    const existing = await db.scheduledTask.findUnique({ where: { id } });
    if (!existing || existing.orgId !== payload.orgId) {
      return sendError(reply, 404, 'NOT_FOUND', '定期タスクが見つかりません');
    }
    await db.scheduledTask.delete({ where: { id } });
    return reply.send({ success: true, data: { deleted: true } });
  });
}
