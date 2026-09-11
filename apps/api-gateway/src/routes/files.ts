import type { FastifyInstance } from 'fastify';
import { basename } from 'path';
import { PLAN_LIMITS, canUpload, formatBytes, type Plan } from '@org-ai/shared-types';
import { prisma } from '../utils/prisma';
import { keyBelongsToOrg, storageKey } from '../services/storage';
import { currentDriverName, readDriver, writeDriver } from '../services/storage/driver';
import { requireAuth } from '../middleware/auth';
import { extractText } from '../utils/fileExtractor';
import { indexFile } from '../services/rag';
import { aiEngineHeaders } from '../services/ai-engine-auth';
import { tracked } from '../services/lifecycle-core';

const ALLOWED_DEPARTMENTS = new Set(['SALES', 'MARKETING', 'ACCOUNTING', 'ANALYTICS', 'GENERAL']);

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  'image/png',
  'image/jpeg',
]);

/**
 * 移行前のファイルか。
 * ⚠️ 本番がオブジェクトストレージに切り替わったあと、driver='local' の行は
 *    Render の再デプロイで実体を失っている。行は残してあるので（RAG の索引を守るため）、
 *    画面で再アップロードを案内するための判定。
 */
const needsReupload = (driver: string): boolean => driver === 'local' && currentDriverName() === 'supabase';

/** 実体を失った行を見せるときの文言。削除ではなく再アップロードを促す。 */
const MISSING_MESSAGE =
  'このファイルの本体は保存場所の移行で失われています。お手数ですが、もう一度アップロードしてください。';

/**
 * 行に記録された保存先から本体を読む。
 * ⚠️ オブジェクトストレージのキーは、所有する組織の区切りの下にあることを確認してから触る
 *    （行の orgId は既に照合済みだが、キーの取り違えに対する二重の防御）。
 */
async function loadBody(file: { storagePath: string; storageDriver: string; orgId: string }): Promise<Buffer | null> {
  if (file.storageDriver === 'supabase' && !keyBelongsToOrg(file.storagePath, file.orgId)) return null;
  try {
    return await readDriver(file.storageDriver).get(file.storagePath);
  } catch (e) {
    console.error('[files] 本体の取得に失敗:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** 同時アップロードで、判定の後に容量が埋まった。 */
class QuotaRaceError extends Error {}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.post('/upload', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { sub: string; orgId: string };

    // プランを先に引く。1ファイルの上限はプランごとに違い、読み取りの上限に使う
    const org = await prisma.organization.findUnique({
      where: { id: payload.orgId },
      select: { plan: true, storageUsedBytes: true, storageAddonUnits: true },
    });
    const plan: Plan = org?.plan && org.plan in PLAN_LIMITS ? (org.plan as Plan) : 'STARTER';
    const used = Number(org?.storageUsedBytes ?? 0);
    const addonUnits = org?.storageAddonUnits ?? 0;
    const maxFileBytes = PLAN_LIMITS[plan].maxFileBytes;

    const tooLarge = () =>
      reply.code(413).send({
        success: false,
        error: { code: 'FILE_TOO_LARGE', message: `1ファイルの上限は ${formatBytes(maxFileBytes)} です。` },
      });
    const quotaExceeded = (quota: number) =>
      reply.code(413).send({
        success: false,
        error: {
          code: 'QUOTA_EXCEEDED',
          message: `保存容量の上限（${formatBytes(quota)}）に達しています。不要なファイルを削除すると、また保存できます。`,
        },
      });

    /* ⚠️ 上限は読み取りの時点で効かせる。読み切ってから判定すると、上限を大きく超える
       ファイルでも一度メモリに載る（Render の starter は RAM が小さい）。 */
    const data = await request.file({ limits: { fileSize: maxFileBytes } });
    if (!data) {
      return reply.code(400).send({ success: false, error: { code: 'NO_FILE', message: 'ファイルが選択されていません' } });
    }

    if (!ALLOWED_MIME_TYPES.has(data.mimetype)) {
      return reply.code(400).send({ success: false, error: { code: 'INVALID_MIME', message: 'このファイル形式は許可されていません' } });
    }

    let body: Buffer;
    try {
      body = await data.toBuffer();
    } catch (e) {
      if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') return tooLarge();
      throw e;
    }

    // 保存先へ送る前に弾く。確定の判定は下のトランザクションで行う
    const verdict = canUpload(plan, used, body.byteLength, addonUnits);
    if (!verdict.ok) {
      return verdict.reason === 'FILE_TOO_LARGE' ? tooLarge() : quotaExceeded(verdict.quota);
    }

    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = storageKey(payload.orgId, fileId, basename(data.filename));
    const driver = writeDriver();

    try {
      await driver.put(key, body, data.mimetype);
    } catch (e) {
      console.error('[files] 保存に失敗:', e instanceof Error ? e.message : e);
      return reply
        .code(502)
        .send({ success: false, error: { code: 'STORAGE_FAILED', message: 'ファイルを保存できませんでした。時間をおいて再度お試しください。' } });
    }

    /* ⚠️ 使用量の加算と行の作成は同じトランザクションで。別々にすると
       「保存したのに使用量が増えていない」行ができ、上限が効かなくなる。
       ⚠️ 加算は「加算後も上限以内」を条件にした updateMany で行う。
       上の canUpload は読んだ時点の値で判定しているので、同時に2件アップロードされると
       両方が通って上限を超える。条件付き更新なら DB が1件ずつ判定する。 */
    const size = body.byteLength;
    const quota = verdict.quota;
    let file;
    try {
      file = await prisma.$transaction(async (tx) => {
        const claimed = await tx.organization.updateMany({
          where: { id: payload.orgId, storageUsedBytes: { lte: BigInt(quota - size) } },
          data: { storageUsedBytes: { increment: BigInt(size) } },
        });
        if (claimed.count === 0) throw new QuotaRaceError();
        return tx.uploadedFile.create({
          data: {
            orgId: payload.orgId,
            uploadedBy: payload.sub,
            originalName: data.filename,
            storagePath: key,
            storageDriver: driver.name,
            mimeType: data.mimetype,
            sizeBytes: size,
          },
        });
      });
    } catch (e) {
      // 行が作れなかったので、保存した本体を片付ける（残すと使用量に数えられない孤児になる）
      await driver.delete(key).catch(() => null);
      if (e instanceof QuotaRaceError) return quotaExceeded(quota);
      throw e;
    }

    // RAG: アップロード応答はブロックせず、バックグラウンドで抽出→チャンク→埋め込み→索引
    // 応答後に走る索引づくり。失っても再アップロードで直るので、終了時は待つだけ
    // 手元にあるバッファで索引を作る。保存先から取り直すと往復が1回無駄になる
    tracked('file-index', file.id, () => indexFile(file.id, file.orgId, body, file.mimeType));

    return reply.code(201).send({ success: true, data: { id: file.id, originalName: file.originalName, mimeType: file.mimeType, sizeBytes: file.sizeBytes } });
  });

  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const files = await prisma.uploadedFile.findMany({
      where: { orgId: payload.orgId },
      select: { id: true, originalName: true, mimeType: true, sizeBytes: true, createdAt: true, storageDriver: true },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({
      success: true,
      data: files.map(({ storageDriver, ...f }) => ({ ...f, needsReupload: needsReupload(storageDriver) })),
    });
  });

  app.get('/:fileId', { preHandler: requireAuth }, async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const payload = request.user as { orgId: string };

    const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file || file.orgId !== payload.orgId) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'ファイルが見つかりません' } });
    }

    const content = await loadBody(file);
    if (!content) {
      return reply.code(404).send({ success: false, error: { code: 'FILE_MISSING', message: MISSING_MESSAGE } });
    }

    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);
    reply.header('Content-Type', file.mimeType);
    return reply.send(content);
  });

  app.post('/:fileId/analyze', { preHandler: requireAuth }, async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const payload = request.user as { orgId: string };
    const body = (request.body ?? {}) as { question?: string; department?: string };

    const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file || file.orgId !== payload.orgId) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'ファイルが見つかりません' } });
    }

    const content = await loadBody(file);
    if (!content) {
      return reply.code(404).send({ success: false, error: { code: 'FILE_MISSING', message: MISSING_MESSAGE } });
    }

    const extracted = await extractText(content, file.mimeType);
    if (extracted.extractor === 'unsupported') {
      return reply.code(415).send({
        success: false,
        error: { code: 'UNSUPPORTED_FILE_TYPE', message: extracted.text },
      });
    }

    const department = body.department && ALLOWED_DEPARTMENTS.has(body.department) ? body.department : 'GENERAL';
    const question = (body.question ?? 'このファイルの内容を要約し、重要なポイントを箇条書きで教えてください。').trim();

    const org = await prisma.organization.findUnique({ where: { id: payload.orgId } });
    const plan = org?.plan ?? 'STARTER';

    const prompt = [
      `# 添付ファイル: ${file.originalName}`,
      `形式: ${file.mimeType}`,
      extracted.truncated ? `※ 文字数が多いため先頭 ${extracted.text.length.toLocaleString()} 文字のみ抽出しています。` : '',
      '',
      '## ファイル内容',
      extracted.text,
      '',
      '## 依頼',
      question,
    ].filter(Boolean).join('\n');

    const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://localhost:8000';
    let res: Response;
    try {
      res = await fetch(`${aiEngineUrl}/orchestrate`, {
        method: 'POST',
        headers: aiEngineHeaders(),
        body: JSON.stringify({
          message: prompt,
          org_id: payload.orgId,
          plan,
          department,
          user_email: (request.user as { email?: string }).email ?? null, // 松竹梅ルーティング
        }),
      });
    } catch (e) {
      request.log.error({ err: e }, '[files] ai-engine unreachable');
      return reply.code(502).send({
        success: false,
        error: { code: 'AI_ENGINE_UNAVAILABLE', message: 'AI エンジンに接続できません' },
      });
    }

    const text = await res.text();
    if (!res.ok) {
      return reply.code(res.status >= 500 ? 502 : res.status).send({
        success: false,
        error: { code: 'ANALYZE_UPSTREAM_ERROR', message: text.slice(0, 800) },
      });
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      return reply.code(502).send({
        success: false,
        error: { code: 'ANALYZE_BAD_RESPONSE', message: 'AI エンジンの応答を解釈できませんでした' },
      });
    }

    return reply.send({
      success: true,
      data: {
        file: { id: file.id, originalName: file.originalName, mimeType: file.mimeType },
        department,
        extractor: extracted.extractor,
        truncated: extracted.truncated,
        analysis: data,
      },
    });
  });

  app.delete('/:fileId', { preHandler: requireAuth }, async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const payload = request.user as { orgId: string };

    const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file || file.orgId !== payload.orgId) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'ファイルが見つかりません' } });
    }

    /* 本体を先に消す。消せなかったら行を残して失敗を返す（行だけ消すと、
       使用量から外れた本体がバケットに残り続け、誰にも見えない保管料になる）。
       無いものを消すのは成功扱い（driver 側で冪等）。
       ローカルは再デプロイで消える前提の置き場なので、失敗しても行の削除は止めない。 */
    if (file.storageDriver === 'supabase' && !keyBelongsToOrg(file.storagePath, file.orgId)) {
      // 他組織の区切りを指す行。本体には触らず、行だけ片付ける
      console.error('[files] 組織の区切り外を指す行を検出したため、本体の削除を見送りました:', file.id);
    } else {
      try {
        await readDriver(file.storageDriver).delete(file.storagePath);
      } catch (e) {
        console.error('[files] 本体の削除に失敗:', e instanceof Error ? e.message : e);
        if (file.storageDriver !== 'local') {
          return reply
            .code(502)
            .send({ success: false, error: { code: 'STORAGE_FAILED', message: 'ファイルを削除できませんでした。時間をおいて再度お試しください。' } });
        }
      }
    }

    /* ⚠️ 行の削除と使用量の減算は同じトランザクションで。
       減算は GREATEST で 0 に張り付ける（移行前の行はカウンタに加算されていないので、
       そのまま引くと負になる）。読んでから書くと同時削除で競合するので1文で行う。 */
    await prisma.$transaction(async (tx) => {
      await tx.uploadedFile.delete({ where: { id: fileId } });
      await tx.$executeRaw`UPDATE "Organization" SET "storageUsedBytes" = GREATEST("storageUsedBytes" - ${BigInt(file.sizeBytes)}, 0) WHERE "id" = ${payload.orgId}`;
    });
    return reply.send({ success: true, data: { deleted: true } });
  });
}
