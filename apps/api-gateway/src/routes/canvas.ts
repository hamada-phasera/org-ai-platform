import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canvasLayoutSchema } from '@org-ai/shared-types';
import { authOf } from '../tenancy';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { FLOW_SAVE_RATE_LIMIT } from '../middleware/rate-limit';
import { sendBodyTooLargeAsError, sendError } from '../utils/http-error';
import { describeIssues } from '../services/pages/upsert';
import { FlowServiceError, loadCanvas, saveCanvas } from '../services/flows/store';
import { canViewFlow } from '../services/flows/access';

/**
 * ホームキャンバス（docs/design/canvas-home.md §3.2・§6.6・§7.1）。prefix: `/api/canvas`。組織に 1 枚（K18）。
 *
 * - `GET /`  行が無ければ既定の配置（version 0）。見られるフローの一覧（名前・有効か）を添える。
 *   消えたフロー・見えないフローを指すノードは、web が「未作成」として描く（その flowId は flows に出ない）。
 * - `PUT /`  ADMIN 以上。`{ layout, baseVersion }`。版が違えば 409 CANVAS_CONFLICT。flow の行き先は自組織のフローだけ（400）。
 * - n8n には一切触れない（D9）。
 */

/** 配置は 32KB まで（スキーマが見る）。本文はその倍まで */
const CANVAS_BODY_LIMIT = 64 * 1024;

const putSchema = z
  .object({
    layout: canvasLayoutSchema,
    baseVersion: z.number().int().min(0),
  })
  .strict();

export async function canvasRoutes(app: FastifyInstance): Promise<void> {
  sendBodyTooLargeAsError(app, '配置が大きすぎます。ノードを減らしてください。');

  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { db, role } = authOf(request);
    const canvas = await loadCanvas(db);
    const flows = await db.flow.findMany({
      select: { id: true, slug: true, name: true, icon: true, enabled: true, minRole: true, templateKey: true },
      orderBy: { createdAt: 'asc' },
    });
    return reply.send({
      success: true,
      data: {
        layout: canvas.layout,
        version: canvas.version,
        isDefault: canvas.isDefault,
        flows: flows
          .filter((f) => canViewFlow(f, role))
          .map((f) => ({ id: f.id, slug: f.slug, name: f.name, icon: f.icon, enabled: f.enabled, templateKey: f.templateKey })),
      },
    });
  });

  app.put(
    '/',
    { preHandler: requireAdmin, bodyLimit: CANVAS_BODY_LIMIT, config: { rateLimit: FLOW_SAVE_RATE_LIMIT } },
    async (request, reply) => {
      const { db, sub } = authOf(request);
      const parsed = putSchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, 'VALIDATION_ERROR', describeIssues(parsed.error.issues));
      try {
        const res = await saveCanvas(db, { layout: parsed.data.layout, baseVersion: parsed.data.baseVersion, actorId: sub });
        return reply.send({ success: true, data: res });
      } catch (e) {
        if (e instanceof FlowServiceError) return sendError(reply, e.status, e.code, e.message);
        throw e;
      }
    },
  );
}
