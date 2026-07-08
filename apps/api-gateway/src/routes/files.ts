import type { FastifyInstance } from 'fastify';
import { createWriteStream, createReadStream, existsSync } from 'fs';
import { mkdir, unlink } from 'fs/promises';
import { join, resolve, basename } from 'path';
import { pipeline } from 'stream/promises';
import { prisma } from '../utils/prisma';
import { requireAuth } from '../middleware/auth';
import { extractText } from '../utils/fileExtractor';
import { indexFile } from '../services/rag';

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

const FILES_BASE = resolve(process.env.FILES_DIR ?? join(process.cwd(), '../../data/files'));

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.post('/upload', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { sub: string; orgId: string };
    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ success: false, error: { code: 'NO_FILE', message: 'ファイルが選択されていません' } });
    }

    if (!ALLOWED_MIME_TYPES.has(data.mimetype)) {
      return reply.code(400).send({ success: false, error: { code: 'INVALID_MIME', message: 'このファイル形式は許可されていません' } });
    }

    const orgDir = join(FILES_BASE, payload.orgId);
    await mkdir(orgDir, { recursive: true });

    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const safeName = basename(data.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = join(orgDir, `${fileId}_${safeName}`);

    // パストラバーサル対策
    if (!resolve(storagePath).startsWith(resolve(FILES_BASE))) {
      return reply.code(400).send({ success: false, error: { code: 'INVALID_PATH', message: '無効なファイルパスです' } });
    }

    await pipeline(data.file, createWriteStream(storagePath));

    const { size } = await import('fs').then((fs) => new Promise<{ size: number }>((ok, fail) =>
      fs.stat(storagePath, (err, s) => err ? fail(err) : ok(s))
    ));

    const file = await prisma.uploadedFile.create({
      data: {
        orgId: payload.orgId,
        uploadedBy: payload.sub,
        originalName: data.filename,
        storagePath,
        mimeType: data.mimetype,
        sizeBytes: size,
      },
    });

    // RAG: アップロード応答はブロックせず、バックグラウンドで抽出→チャンク→埋め込み→索引
    void indexFile(file.id, file.orgId, file.storagePath, file.mimeType).catch((e) =>
      request.log.error({ err: e, fileId: file.id }, '[files] RAG indexing failed'),
    );

    return reply.code(201).send({ success: true, data: { id: file.id, originalName: file.originalName, mimeType: file.mimeType, sizeBytes: file.sizeBytes } });
  });

  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const files = await prisma.uploadedFile.findMany({
      where: { orgId: payload.orgId },
      select: { id: true, originalName: true, mimeType: true, sizeBytes: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ success: true, data: files });
  });

  app.get('/:fileId', { preHandler: requireAuth }, async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const payload = request.user as { orgId: string };

    const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file || file.orgId !== payload.orgId) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'ファイルが見つかりません' } });
    }

    if (!existsSync(file.storagePath)) {
      return reply.code(404).send({ success: false, error: { code: 'FILE_MISSING', message: 'ファイルが見つかりません' } });
    }

    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);
    reply.header('Content-Type', file.mimeType);
    return reply.send(createReadStream(file.storagePath));
  });

  app.post('/:fileId/analyze', { preHandler: requireAuth }, async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    const payload = request.user as { orgId: string };
    const body = (request.body ?? {}) as { question?: string; department?: string };

    const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file || file.orgId !== payload.orgId) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'ファイルが見つかりません' } });
    }

    if (!existsSync(file.storagePath)) {
      return reply.code(404).send({ success: false, error: { code: 'FILE_MISSING', message: 'ファイル本体が見つかりません' } });
    }

    if (!resolve(file.storagePath).startsWith(resolve(FILES_BASE))) {
      return reply.code(400).send({ success: false, error: { code: 'INVALID_PATH', message: '無効なファイルパスです' } });
    }

    const extracted = await extractText(file.storagePath, file.mimeType);
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
        headers: { 'Content-Type': 'application/json' },
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

    await unlink(file.storagePath).catch(() => null);
    await prisma.uploadedFile.delete({ where: { id: fileId } });
    return reply.send({ success: true, data: { deleted: true } });
  });
}
