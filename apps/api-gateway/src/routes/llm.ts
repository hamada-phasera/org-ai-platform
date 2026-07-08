import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth } from '../middleware/auth';

const llmChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      })
    )
    .min(1),
  jsonMode: z.boolean().optional(),
});

/**
 * タスクマネージャー等からブラウザで Groq を直接叩かせず、ai-engine 経由で 1 本化する（TPM の二重消費防止）。
 */
export async function llmRoutes(app: FastifyInstance): Promise<void> {
  app.post('/chat', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = llmChatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }

    const payload = request.user as { orgId: string; email?: string };
    const org = await prisma.organization.findUnique({ where: { id: payload.orgId } });
    const plan = org?.plan ?? 'STARTER';

    const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://localhost:8000';
    let res: Response;
    try {
      res = await fetch(`${aiEngineUrl}/llm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: parsed.data.messages,
          department: 'GENERAL',
          org_id: payload.orgId,
          plan,
          json_mode: parsed.data.jsonMode ?? false,
          user_email: payload.email ?? null, // 松竹梅ルーティング（admin判定）
        }),
      });
    } catch (e) {
      request.log.error({ err: e }, '[llm] ai-engine unreachable');
      return reply.code(502).send({
        success: false,
        error: {
          code: 'AI_ENGINE_UNAVAILABLE',
          message: 'AI エンジンに接続できません。AI_ENGINE_URL とサービス起動を確認してください。',
        },
      });
    }

    const text = await res.text();
    if (!res.ok) {
      return reply.code(res.status >= 500 ? 502 : res.status).send({
        success: false,
        error: { code: 'LLM_UPSTREAM_ERROR', message: text.slice(0, 800) },
      });
    }

    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      return reply.send({ success: true, data });
    } catch {
      return reply.code(502).send({
        success: false,
        error: { code: 'LLM_BAD_RESPONSE', message: 'AI エンジンの応答を解釈できませんでした。' },
      });
    }
  });
}
