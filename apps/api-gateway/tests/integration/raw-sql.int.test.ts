import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { applyRlsPhase2a, createTestDatabase, hasTestDatabase, setEnv, truncateAll, type TestDatabase } from './setup';
import { buildIntegrationApp, registerCompany, upload, type Registered } from './app';

// raw SQL が他組織の行を返さない・触らないこと（計画書チャンク 9 の受け入れ条件 3）。
// raw SQL は routes/files.ts と services/rag.ts だけ（src/__tests__/architecture.test.ts が静的に検査）。
// ここでは実 Postgres + pgvector で、文が実際に組織で絞れていることを確かめる。
// 埋め込みは偽物（全文同じベクトル＝類似度 1）。外部の埋め込み API は呼ばない。

// RLS_MODE=on の回（計画書チャンク 11）は phase2a.sql を当て、gateway の接続を flow_app に替える。準備・確認は所有者のまま
let db: TestDatabase | undefined;
let appPrisma: PrismaClient | undefined;
vi.mock('../../src/utils/prisma', () => ({
  get prisma(): PrismaClient {
    if (!db) throw new Error('統合テストの DB が未作成です');
    return appPrisma ?? db.prisma;
  },
}));

const DIM = 1024;
const unit = (): number[] => Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('../../src/services/embeddings', () => ({
  EMBEDDING_DIM: 1024,
  isEmbeddingEnabled: () => true,
  embedTexts: async (texts: string[]) => texts.map(() => unit()),
  embedQuery: async () => unit(),
}));
vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'offline in tests' }), { status: 503 })));

describe.skipIf(!hasTestDatabase).each(['off', 'on'] as const)('raw SQL の組織分離（実 Postgres + pgvector・RLS_MODE=%s）', (rlsMode) => {
  let app: FastifyInstance;
  let restoreEnv: () => void;
  let filesDir: string;
  let a: Registered;
  let b: Registered;
  let rag: typeof import('../../src/services/rag');

  beforeAll(async () => {
    filesDir = mkdtempSync(join(tmpdir(), 'flow-int-raw-'));
    restoreEnv = setEnv({
      FILES_DIR: filesDir,
      STRIPE_SECRET_KEY: undefined,
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      RLS_MODE: rlsMode,
    });
    db = await createTestDatabase();
    if (rlsMode === 'on') appPrisma = (await applyRlsPhase2a(db)).app;
    app = await buildIntegrationApp();
    rag = await import('../../src/services/rag');
  });

  afterAll(async () => {
    await app?.close();
    const { drain, jobs } = await import('../../src/services/lifecycle-core');
    await drain(jobs, { budgetMs: 5_000, pollMs: 20, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    await appPrisma?.$disconnect();
    appPrisma = undefined;
    await db?.drop();
    db = undefined;
    restoreEnv?.();
    vi.unstubAllGlobals();
    rmSync(filesDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
    await truncateAll(db!.prisma);
    clearMembershipCache();
    a = await registerCompany(app, 'owner@a.example.jp', 'A 工務店');
    b = await registerCompany(app, 'owner@b.example.jp', 'B 建設');
  });

  /** 行だけ作る（RAG の索引は indexFile を直接呼ぶ） */
  const fileRow = (who: Registered, name: string) =>
    db!.prisma.uploadedFile.create({
      data: { orgId: who.orgId, uploadedBy: who.userId, originalName: name, storagePath: `/x/${name}`, mimeType: 'text/plain', sizeBytes: 10 },
    });

  /** 会話 1 件（MessageEmbedding は Message を外部キーで指す） */
  const message = async (who: Registered, content: string) => {
    const session = await db!.prisma.chatSession.create({ data: { orgId: who.orgId, title: 't' } });
    return db!.prisma.message.create({ data: { sessionId: session.id, role: 'user', content } });
  };

  it('files.ts: 削除の使用量の減算は自分の組織だけに効く', async () => {
    const aUp = await upload(app, a, 'a.txt', Buffer.alloc(3000, 'a'));
    const bUp = await upload(app, b, 'b.txt', Buffer.alloc(5000, 'b'));
    expect(aUp.statusCode).toBe(201);
    expect(bUp.statusCode).toBe(201);
    const used = async (orgId: string) =>
      Number((await db!.prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).storageUsedBytes);
    expect(await used(a.orgId)).toBe(3000);
    expect(await used(b.orgId)).toBe(5000);

    // A が B のファイルを消そうとしても 404。B の行も使用量も変わらない
    const cross = await app.inject({ method: 'DELETE', url: `/api/files/${bUp.json().data.id}`, headers: a.headers });
    expect(cross.statusCode).toBe(404);
    expect(await used(b.orgId)).toBe(5000);
    expect(await used(a.orgId)).toBe(3000);

    // B が自分のファイルを消すと、B だけが減る（A の使用量は変わらない）
    const own = await app.inject({ method: 'DELETE', url: `/api/files/${bUp.json().data.id}`, headers: b.headers });
    expect(own.statusCode).toBe(200);
    expect(await used(b.orgId)).toBe(0);
    expect(await used(a.orgId)).toBe(3000);

    // 移行前の行（カウンタに加算されていない）を消しても負にならない（GREATEST）
    const legacy = await fileRow(b, 'legacy.txt');
    const res = await app.inject({ method: 'DELETE', url: `/api/files/${legacy.id}`, headers: b.headers });
    expect(res.statusCode).toBe(200);
    expect(await used(b.orgId)).toBe(0);
    expect(await used(a.orgId)).toBe(3000);
  });

  it('rag.ts: 検索は自分の組織の資料と過去の会話だけを返す', async () => {
    const aFile = await fileRow(a, 'a-見積.txt');
    const bFile = await fileRow(b, 'b-見積.txt');
    await rag.indexFile(aFile.id, a.orgId, Buffer.from('A 社の見積は 120 万円です。'), 'text/plain');
    await rag.indexFile(bFile.id, b.orgId, Buffer.from('B 社の見積は 999 万円です。'), 'text/plain');
    const aMsg = await message(a, 'A 社の打ち合わせメモです。');
    const bMsg = await message(b, 'B 社の打ち合わせメモです。');
    await rag.indexMessages(a.orgId, aMsg.sessionId, [{ messageId: aMsg.id, role: 'user', content: aMsg.content }]);
    await rag.indexMessages(b.orgId, bMsg.sessionId, [{ messageId: bMsg.id, role: 'user', content: bMsg.content }]);
    expect(await db!.prisma.fileChunk.count()).toBe(2);
    expect(await db!.prisma.messageEmbedding.count()).toBe(2);

    // 全文が同じベクトル（類似度 1）でも、A の検索に B は出ない
    const ctx = await rag.retrieveContext({ orgId: a.orgId, query: '見積はいくら？' });
    expect(ctx).not.toBeNull();
    expect(ctx!.block).toContain('120 万円');
    expect(ctx!.block).toContain('A 社の打ち合わせメモ');
    expect(ctx!.block).not.toContain('999 万円');
    expect(ctx!.block).not.toContain('B 社');
    expect(ctx!.fileSources).toEqual(['a-見積.txt']);
    expect(ctx!.chatMatches).toBe(1);

    // B のファイル id を名指ししても、A の組織からは取れない
    const named = await rag.retrieveContext({ orgId: a.orgId, query: '見積', fileIds: [bFile.id] });
    expect(named?.block ?? '').not.toContain('999 万円');
    expect(named?.fileSources ?? []).toEqual([]);
  });

  it('rag.ts: 他組織の名前で索引し直しても、元の組織の索引は消えない', async () => {
    const aFile = await fileRow(a, 'a.txt');
    await rag.indexFile(aFile.id, a.orgId, Buffer.from('A 社の資料'), 'text/plain');
    expect(await db!.prisma.fileChunk.count({ where: { orgId: a.orgId } })).toBe(1);

    // DELETE は fileId と orgId の両方で絞る。B の名前で同じ fileId を索引し直しても A の行は残る
    await rag.indexFile(aFile.id, b.orgId, Buffer.from('B による上書き'), 'text/plain');
    const rows = await db!.prisma.fileChunk.findMany({ where: { fileId: aFile.id }, select: { orgId: true, content: true } });
    expect(rows).toContainEqual({ orgId: a.orgId, content: 'A 社の資料' });

    const ctx = await rag.retrieveContext({ orgId: a.orgId, query: '資料' });
    expect(ctx!.block).toContain('A 社の資料');
    expect(ctx!.block).not.toContain('B による上書き');
  });
});
