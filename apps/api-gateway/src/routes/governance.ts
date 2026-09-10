import type { FastifyInstance } from 'fastify';
import { prisma } from '../utils/prisma';
import { requireAdmin } from '../middleware/auth';

export async function governanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/logs', { preHandler: requireAdmin }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const query = request.query as { page?: string; limit?: string; department?: string };
    const page = parseInt(query.page ?? '1');
    const limit = parseInt(query.limit ?? '20');
    const skip = (page - 1) * limit;

    const where = {
      orgId: payload.orgId,
      ...(query.department ? { department: query.department } : {}),
    };

    const [logs, total] = await Promise.all([
      prisma.aILog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      prisma.aILog.count({ where }),
    ]);

    return reply.send({
      success: true,
      data: logs,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  });

  app.get('/risks', { preHandler: requireAdmin }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const query = request.query as { resolved?: string };
    const risks = await prisma.riskEvent.findMany({
      where: {
        orgId: payload.orgId,
        ...(query.resolved !== undefined ? { resolved: query.resolved === 'true' } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ success: true, data: risks });
  });

  app.patch('/risks/:id/resolve', { preHandler: requireAdmin }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const { id } = request.params as { id: string };

    /* ⚠️ id だけで update してはいけない。同ファイルの /logs /risks /stats は全て orgId で
       絞っているのに、ここだけ抜けていた（他組織のリスクを既読にできる状態だった）。
       ガバナンスは「見張る」機能なので、そこで分離が破れているのは売り文句と正面衝突する。
       件数が0なら他組織のものか存在しないので、どちらか判別させずに 404 を返す。 */
    const result = await prisma.riskEvent.updateMany({
      where: { id, orgId: payload.orgId },
      data: { resolved: true },
    });
    if (result.count === 0) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'リスクイベントが見つかりません' } });
    }

    const updated = await prisma.riskEvent.findFirst({ where: { id, orgId: payload.orgId } });
    return reply.send({ success: true, data: updated });
  });

  app.get('/stats', { preHandler: requireAdmin }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const orgId = payload.orgId;

    const [totalRequests, risks, logs] = await Promise.all([
      prisma.aILog.count({ where: { orgId } }),
      prisma.riskEvent.findMany({ where: { orgId }, select: { severity: true } }),
      prisma.aILog.findMany({ where: { orgId }, select: { tokens: true, latencyMs: true, department: true } }),
    ]);

    const totalTokens = logs.reduce((s, l) => s + (l.tokens ?? 0), 0);
    const avgLatencyMs = logs.length > 0
      ? Math.round(logs.reduce((s, l) => s + (l.latencyMs ?? 0), 0) / logs.length)
      : 0;

    const riskCounts = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    risks.forEach((r) => { riskCounts[r.severity as keyof typeof riskCounts]++; });

    const deptMap: Record<string, number> = {};
    logs.forEach((l) => { deptMap[l.department] = (deptMap[l.department] ?? 0) + 1; });
    const topDepartments = Object.entries(deptMap)
      .map(([department, count]) => ({ department, count }))
      .sort((a, b) => b.count - a.count);

    return reply.send({
      success: true,
      data: { totalRequests, totalTokens, riskEvents: riskCounts, topDepartments, avgLatencyMs },
    });
  });
}
