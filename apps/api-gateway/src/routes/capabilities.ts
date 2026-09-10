import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { RESERVED_CAPABILITY_NAMES, type HttpNodeConfig, type HttpNodeHeader } from '@org-ai/shared-types';
import { requireAuth, requireOwner } from '../middleware/auth';
import { resolveAndExecute } from '../services/capability-resolver';
import { getNativeAdapter } from '../services/adapters';
import {
  buildHttpConfig,
  httpNodeInputSchema,
  paramsSchema,
  sanitizeHttpConfig,
} from '../services/http-node/config-schema';
import { buildInputSchema } from '../services/http-node/template';
import { executeHttpCapabilityDetailed } from '../services/http-node/executor';

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
  /* カスタムノード（kind='http'）のみ。inputSchema は params から再生成するので
     クライアント指定の inputSchema は http kind では無視する */
  http: httpNodeInputSchema.optional(),
  params: paramsSchema.optional(),
});

const createSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]{2,49}$/, 'name は英小文字で始まる英数字とアンダースコア（3〜50文字）です'),
  displayName: z.string().min(1).max(100),
  /* LLM がこのノードを選ぶ根拠になるので、短すぎる説明を許さない */
  description: z.string().min(20).max(1000),
  department: z.string().default('GENERAL'),
  params: paramsSchema.default([]),
  http: httpNodeInputSchema,
});

const testSchema = z.object({
  args: z.record(z.unknown()).default({}),
  /* 実課金・実送信の API を誤爆させないための明示同意 */
  confirmWrite: z.boolean().default(false),
});

/** 暗号文を落とした公開形。**行を spread してはならない**。 */
function sanitizeCapability(cap: {
  id: string;
  orgId: string;
  name: string;
  displayName: string;
  description: string;
  department: string;
  inputSchema: unknown;
  status: string;
  webhookPath: string | null;
  kind: string;
  httpConfig: unknown;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  requiredCreds?: unknown;
}) {
  return {
    id: cap.id,
    orgId: cap.orgId,
    name: cap.name,
    displayName: cap.displayName,
    description: cap.description,
    department: cap.department,
    inputSchema: cap.inputSchema,
    status: cap.status,
    webhookPath: cap.webhookPath,
    createdBy: cap.createdBy,
    createdAt: cap.createdAt,
    updatedAt: cap.updatedAt,
    ...(cap.requiredCreds !== undefined ? { requiredCreds: cap.requiredCreds } : {}),
    /* 'native' は adapter レジストリからの派生（DB には保存していない） */
    kind: getNativeAdapter(cap.name) ? 'native' : cap.kind,
    httpConfig: cap.kind === 'http' ? sanitizeHttpConfig(cap.httpConfig) : null,
  };
}

export async function capabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const caps = await prisma.capability.findMany({
      where: { orgId },
      include: { requiredCreds: true },
      orderBy: { name: 'asc' },
    });
    /* ⚠️ 以前は Prisma 行を生で返しており、httpConfig を足すと暗号文がそのまま漏れる。
       sanitize は「望ましい」ではなく必須。 */
    return reply.send({ success: true, data: caps.map(sanitizeCapability) });
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

  /**
   * カスタムノードを作る（kind='http'）。
   *
   * ⚠️ **保存時に外部へリクエストは飛ばさない**。宛先がユーザー入力の任意 URL なので、
   *    作成 API 自体が「認証済みユーザーが任意 URL へ飛ばせる blind request プリミティブ」に
   *    なってしまう。接続テストは明示の /:id/test に閉じ込め、個別にレート制限する。
   *    （integrations.ts が保存前に実 API を叩くのは、宛先が Slack という固定の
   *    信頼済みホストだから成立する話で、ここには当てはまらない）
   */
  app.post('/', { preHandler: requireOwner }, async (request, reply) => {
    const payload = request.user as { sub: string; orgId: string };
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const d = parsed.data;

    if ((RESERVED_CAPABILITY_NAMES as readonly string[]).includes(d.name) || getNativeAdapter(d.name)) {
      return reply.code(400).send({
        success: false,
        error: { code: 'RESERVED_NAME', message: `「${d.name}」は予約された名前です。別の名前にしてください。` },
      });
    }

    const built = buildHttpConfig(d.http, d.params);
    if (!built.ok) {
      return reply
        .code(400)
        .send({ success: false, error: { code: built.code, message: built.message } });
    }

    try {
      const created = await prisma.capability.create({
        data: {
          orgId: payload.orgId,
          name: d.name,
          displayName: d.displayName,
          description: d.description,
          department: d.department,
          /* params が単一の真実の源。ユーザーに JSON Schema を書かせない */
          inputSchema: buildInputSchema(d.params) as object,
          status: 'ACTIVE',
          kind: 'http',
          httpConfig: built.config as unknown as object,
          createdBy: payload.sub,
          webhookPath: null,
        },
      });
      return reply.code(201).send({ success: true, data: sanitizeCapability(created) });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        return reply.code(409).send({
          success: false,
          error: { code: 'DUPLICATE_NAME', message: 'この名前のノードは既にあります。' },
        });
      }
      throw e;
    }
  });

  /** カスタムノードを削除する。seed 由来（kind='n8n'）は構造的に消せない。 */
  app.delete('/:id', { preHandler: requireOwner }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { orgId } = request.user as { orgId: string };
    const force = (request.query as { force?: string }).force === 'true';

    const cap = await prisma.capability.findUnique({ where: { id } });
    if (!cap || cap.orgId !== orgId) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'capability が見つかりません' } });
    }
    if (cap.kind !== 'http') {
      return reply.code(403).send({
        success: false,
        error: { code: 'BUILTIN_CAPABILITY', message: '標準の機能は削除できません。' },
      });
    }

    /* 使っているエージェントがあれば、黙って壊さず知らせる。
       steps は Json なので JS 側で走査する（org あたりの件数は小さい） */
    const agents = await prisma.agent.findMany({
      where: { orgId },
      select: { id: true, name: true, steps: true },
    });
    const users = agents.filter((a) =>
      ((a.steps as unknown as { capabilityName?: string }[] | null) ?? []).some(
        (st) => st?.capabilityName === cap.name,
      ),
    );
    if (users.length > 0 && !force) {
      return reply.code(409).send({
        success: false,
        error: {
          code: 'IN_USE',
          message: `${users.length} 件のエージェントがこのノードを使っています。`,
          agents: users.map((a) => ({ id: a.id, name: a.name })),
        },
      });
    }

    await prisma.capability.delete({ where: { id } });
    return reply.send({ success: true, data: { deleted: true } });
  });

  /**
   * 保存済みノードの接続テスト。実行履歴（ExecutionLog）には書かない。
   * ⚠️ レスポンスに展開後 URL とヘッダを含めない（PII と API キーが載るため）。
   */
  app.post('/:id/test', { preHandler: requireOwner }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { orgId } = request.user as { orgId: string };
    const parsed = testSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }

    const cap = await prisma.capability.findUnique({ where: { id } });
    if (!cap || cap.orgId !== orgId || cap.kind !== 'http') {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'カスタムノードが見つかりません' } });
    }

    const method = (cap.httpConfig as { method?: string } | null)?.method ?? '';
    if (method.toUpperCase() !== 'GET' && !parsed.data.confirmWrite) {
      return reply.code(400).send({
        success: false,
        error: {
          code: 'CONFIRM_WRITE_REQUIRED',
          message: 'このノードは書き込み系です。実際に送信してよい場合のみ confirmWrite を指定してください。',
        },
      });
    }

    const startedAt = Date.now();
    const result = await executeHttpCapabilityDetailed(cap, parsed.data.args, orgId);
    return reply.send({
      success: true,
      data: {
        envelope: result.envelope,
        durationMs: Date.now() - startedAt,
        /* 展開後 URL は返さない。ホストとテンプレート形のパスだけ */
        requestPreview: { method, url: (cap.httpConfig as { url?: string } | null)?.url ?? '' },
      },
    });
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
    const d = parsed.data;

    /* カスタムノードの設定更新。kind と name は変更できない
       （kind を書き換えられると seed 行を http にしてから削除できてしまう） */
    let httpConfig: object | undefined;
    let inputSchema: object | undefined = d.inputSchema as object | undefined;
    if (d.http || d.params) {
      if (cap.kind !== 'http') {
        return reply.code(400).send({
          success: false,
          error: { code: 'NOT_CUSTOM_NODE', message: '標準の機能には接続設定を指定できません。' },
        });
      }
      const existing = cap.httpConfig as unknown as HttpNodeConfig | null;
      const params = d.params ?? existing?.params ?? [];
      const input = d.http ?? {
        method: existing?.method ?? 'GET',
        url: existing?.url ?? '',
        headers: (existing?.headers ?? []).map((h: HttpNodeHeader) => ({
          name: h.name,
          secret: !!h.secret,
          /* secret は value 省略で既存の封緘値を引き継がせる */
          ...(h.secret ? {} : { value: h.value }),
        })),
        bodyEncoding: existing?.bodyEncoding,
        bodyTemplate: existing?.bodyTemplate,
        outputPath: existing?.outputPath,
        timeoutMs: existing?.timeoutMs,
      };
      const built = buildHttpConfig(input, params, existing?.headers ?? []);
      if (!built.ok) {
        return reply
          .code(400)
          .send({ success: false, error: { code: built.code, message: built.message } });
      }
      httpConfig = built.config as unknown as object;
      /* http kind では inputSchema は params から必ず再生成する（二重の真実の源を作らない） */
      inputSchema = buildInputSchema(params) as object;
    }

    const updated = await prisma.capability.update({
      where: { id },
      data: {
        ...(d.displayName !== undefined ? { displayName: d.displayName } : {}),
        ...(d.description !== undefined ? { description: d.description } : {}),
        ...(d.status !== undefined ? { status: d.status } : {}),
        ...(d.webhookPath !== undefined ? { webhookPath: d.webhookPath } : {}),
        ...(d.n8nWorkflowId !== undefined ? { n8nWorkflowId: d.n8nWorkflowId } : {}),
        ...(inputSchema !== undefined ? { inputSchema } : {}),
        ...(httpConfig !== undefined ? { httpConfig } : {}),
      },
    });
    return reply.send({ success: true, data: sanitizeCapability(updated) });
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
