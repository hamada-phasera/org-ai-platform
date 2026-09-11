import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { PLAN_LIMITS } from '@org-ai/shared-types';

const prismaMock = {
  organization: { findUnique: vi.fn(), updateMany: vi.fn() },
  uploadedFile: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

vi.mock('../../src/middleware/auth', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'MEMBER' };
  },
}));

const driverMock = { name: 'supabase' as const, put: vi.fn(), get: vi.fn(), delete: vi.fn(), signedUrl: vi.fn() };
const localDriverMock = { name: 'local' as const, put: vi.fn(), get: vi.fn(), delete: vi.fn(), signedUrl: vi.fn() };
const currentDriverName = vi.fn();
vi.mock('../../src/services/storage/driver', () => ({
  writeDriver: () => driverMock,
  readDriver: (name: string) => (name === 'local' ? localDriverMock : driverMock),
  currentDriverName: () => currentDriverName(),
}));

const extractText = vi.fn();
vi.mock('../../src/utils/fileExtractor', () => ({ extractText: (...a: unknown[]) => extractText(...a) }));
vi.mock('../../src/services/rag', () => ({ indexFile: vi.fn(async () => undefined) }));
vi.mock('../../src/services/ai-engine-auth', () => ({ aiEngineHeaders: () => ({ 'Content-Type': 'application/json' }) }));
const tracked = vi.fn();
vi.mock('../../src/services/lifecycle-core', () => ({ tracked: (...a: unknown[]) => tracked(...a) }));

const { fileRoutes } = await import('../../src/routes/files');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  // 本番と同じく、既定の上限は大きく取り、プランごとの上限はルートが絞る
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  await app.register(fileRoutes, { prefix: '/api/files' });
  await app.ready();
  return app;
}

function multipartBody(filename: string, mime: string, content: Buffer) {
  const boundary = '----flowtestboundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const QUOTA = PLAN_LIMITS.STARTER.storageBytes;

beforeEach(() => {
  vi.clearAllMocks();
  currentDriverName.mockReturnValue('supabase');
  prismaMock.$transaction.mockImplementation(async (fn: (tx: typeof prismaMock) => unknown) => fn(prismaMock));
  prismaMock.organization.findUnique.mockResolvedValue({ plan: 'STARTER', storageUsedBytes: BigInt(0), storageAddonUnits: 0 });
  prismaMock.organization.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.uploadedFile.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'file-1',
    ...data,
  }));
  driverMock.put.mockResolvedValue(undefined);
  driverMock.delete.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/files/upload', () => {
  it('組織の区切りの下に保存し、行の作成と使用量の加算を同じトランザクションで行う', async () => {
    const app = await build();
    const content = Buffer.from('hello world');
    const res = await app.inject({ method: 'POST', url: '/api/files/upload', ...multipartBody('report.txt', 'text/plain', content) });

    expect(res.statusCode).toBe(201);
    const [key, body, mime] = driverMock.put.mock.calls[0];
    expect(key).toMatch(/^org-1\/.+_report\.txt$/);
    expect(Buffer.compare(body, content)).toBe(0);
    expect(mime).toBe('text/plain');

    // ⚠️ 加算は「加算後も上限以内」を条件にする。同時アップロードで上限を超えないため
    expect(prismaMock.organization.updateMany).toHaveBeenCalledWith({
      where: { id: 'org-1', storageUsedBytes: { lte: BigInt(QUOTA - content.byteLength) } },
      data: { storageUsedBytes: { increment: BigInt(content.byteLength) } },
    });
    const created = prismaMock.uploadedFile.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ orgId: 'org-1', storagePath: key, storageDriver: 'supabase', sizeBytes: content.byteLength });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(tracked).toHaveBeenCalledWith('file-index', 'file-1', expect.any(Function));
    await app.close();
  });

  it('容量を使い切っていたら、保存先に送らずに 413 を返す', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({ plan: 'STARTER', storageUsedBytes: BigInt(QUOTA), storageAddonUnits: 0 });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/files/upload', ...multipartBody('a.txt', 'text/plain', Buffer.from('x')) });

    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('QUOTA_EXCEEDED');
    expect(driverMock.put).not.toHaveBeenCalled();
    expect(prismaMock.uploadedFile.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('追加容量があれば、無料枠を超えていても保存できる', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({ plan: 'STARTER', storageUsedBytes: BigInt(QUOTA), storageAddonUnits: 1 });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/files/upload', ...multipartBody('a.txt', 'text/plain', Buffer.from('x')) });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('プランの1ファイル上限を超えたら、読み取りの時点で 413 を返す', async () => {
    const app = await build();
    const big = Buffer.alloc(PLAN_LIMITS.STARTER.maxFileBytes + 1, 0x61);
    const res = await app.inject({ method: 'POST', url: '/api/files/upload', ...multipartBody('big.txt', 'text/plain', big) });

    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');
    expect(driverMock.put).not.toHaveBeenCalled();
    await app.close();
  });

  it('判定の後に同時アップロードで容量が埋まったら、保存した本体を片付けて 413', async () => {
    prismaMock.organization.updateMany.mockResolvedValue({ count: 0 });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/files/upload', ...multipartBody('a.txt', 'text/plain', Buffer.from('x')) });

    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('QUOTA_EXCEEDED');
    const putKey = driverMock.put.mock.calls[0][0];
    expect(driverMock.delete).toHaveBeenCalledWith(putKey);
    expect(prismaMock.uploadedFile.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('保存先が落ちていたら 502。行も使用量も触らない', async () => {
    driverMock.put.mockRejectedValue(new Error('down'));
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/files/upload', ...multipartBody('a.txt', 'text/plain', Buffer.from('x')) });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('STORAGE_FAILED');
    expect(prismaMock.organization.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it('許可していない形式は 400', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/files/upload', ...multipartBody('a.exe', 'application/x-msdownload', Buffer.from('x')) });
    expect(res.statusCode).toBe(400);
    expect(driverMock.put).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /api/files', () => {
  const rows = [
    { id: 'a', originalName: 'old.pdf', mimeType: 'application/pdf', sizeBytes: 10, createdAt: new Date(), storageDriver: 'local' },
    { id: 'b', originalName: 'new.pdf', mimeType: 'application/pdf', sizeBytes: 10, createdAt: new Date(), storageDriver: 'supabase' },
  ];

  it('本番が Supabase に切り替わった後、ローカルの行は再アップロードを案内する', async () => {
    prismaMock.uploadedFile.findMany.mockResolvedValue(rows);
    const app = await build();
    const data = (await app.inject({ method: 'GET', url: '/api/files' })).json().data;

    expect(data.find((f: { id: string }) => f.id === 'a').needsReupload).toBe(true);
    expect(data.find((f: { id: string }) => f.id === 'b').needsReupload).toBe(false);
    // 保存先の内部名は画面に出さない
    expect(data[0]).not.toHaveProperty('storageDriver');
    await app.close();
  });

  it('開発環境（ローカル保存）では、ローカルの行を失われた扱いにしない', async () => {
    currentDriverName.mockReturnValue('local');
    prismaMock.uploadedFile.findMany.mockResolvedValue(rows);
    const app = await build();
    const data = (await app.inject({ method: 'GET', url: '/api/files' })).json().data;
    expect(data.every((f: { needsReupload: boolean }) => f.needsReupload === false)).toBe(true);
    await app.close();
  });
});

describe('GET /api/files/:fileId', () => {
  const row = {
    id: 'file-1', orgId: 'org-1', originalName: 'a.txt', mimeType: 'text/plain', sizeBytes: 3,
    storagePath: 'org-1/f_a.txt', storageDriver: 'supabase',
  };

  it('他組織のファイルは 404（本体に触らない）', async () => {
    prismaMock.uploadedFile.findUnique.mockResolvedValue({ ...row, orgId: 'org-2' });
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/files/file-1' });
    expect(res.statusCode).toBe(404);
    expect(driverMock.get).not.toHaveBeenCalled();
    await app.close();
  });

  it('行が他組織の区切りを指していたら、本体を取りに行かない', async () => {
    prismaMock.uploadedFile.findUnique.mockResolvedValue({ ...row, storagePath: 'org-2/f_a.txt' });
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/files/file-1' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('FILE_MISSING');
    expect(driverMock.get).not.toHaveBeenCalled();
    await app.close();
  });

  it('本体が失われていたら FILE_MISSING で再アップロードを案内する', async () => {
    prismaMock.uploadedFile.findUnique.mockResolvedValue(row);
    driverMock.get.mockResolvedValue(null);
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/files/file-1' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('FILE_MISSING');
    expect(res.json().error.message).toContain('もう一度アップロード');
    await app.close();
  });

  it('本体を返す', async () => {
    prismaMock.uploadedFile.findUnique.mockResolvedValue(row);
    driverMock.get.mockResolvedValue(Buffer.from('abc'));
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/files/file-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('abc');
    expect(res.headers['content-type']).toContain('text/plain');
    await app.close();
  });
});

describe('POST /api/files/:fileId/analyze', () => {
  it('保存先から取った本体（パスではなくバッファ）で抽出する', async () => {
    prismaMock.uploadedFile.findUnique.mockResolvedValue({
      id: 'file-1', orgId: 'org-1', originalName: 'a.txt', mimeType: 'text/plain', sizeBytes: 3,
      storagePath: 'org-1/f_a.txt', storageDriver: 'supabase',
    });
    driverMock.get.mockResolvedValue(Buffer.from('本文'));
    extractText.mockResolvedValue({ text: '本文', extractor: 'text', truncated: false });
    prismaMock.organization.findUnique.mockResolvedValue({ plan: 'STARTER' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ content: '要約' }), { status: 200 })));

    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/files/file-1/analyze', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(Buffer.isBuffer(extractText.mock.calls[0][0])).toBe(true);
    await app.close();
  });
});

describe('DELETE /api/files/:fileId', () => {
  const row = {
    id: 'file-1', orgId: 'org-1', originalName: 'a.txt', mimeType: 'text/plain', sizeBytes: 500,
    storagePath: 'org-1/f_a.txt', storageDriver: 'supabase',
  };

  it('本体を消し、行の削除と使用量の減算（0 で止める）を同じトランザクションで行う', async () => {
    prismaMock.uploadedFile.findUnique.mockResolvedValue(row);
    const app = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/files/file-1' });

    expect(res.statusCode).toBe(200);
    expect(driverMock.delete).toHaveBeenCalledWith('org-1/f_a.txt');
    expect(prismaMock.uploadedFile.delete).toHaveBeenCalledWith({ where: { id: 'file-1' } });
    const [strings, ...values] = prismaMock.$executeRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('GREATEST');
    expect(values).toEqual([BigInt(500), 'org-1']);
    await app.close();
  });

  it('Supabase の本体が消せなかったら、行を残して 502（見えない保管料を作らない）', async () => {
    prismaMock.uploadedFile.findUnique.mockResolvedValue(row);
    driverMock.delete.mockRejectedValue(new Error('403'));
    const app = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/files/file-1' });

    expect(res.statusCode).toBe(502);
    expect(prismaMock.uploadedFile.delete).not.toHaveBeenCalled();
    await app.close();
  });

  it('ローカルの本体が消せなくても、行は消す（再デプロイで消える置き場）', async () => {
    prismaMock.uploadedFile.findUnique.mockResolvedValue({ ...row, storageDriver: 'local' });
    localDriverMock.delete.mockRejectedValue(new Error('EACCES'));
    const app = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/files/file-1' });

    expect(res.statusCode).toBe(200);
    expect(prismaMock.uploadedFile.delete).toHaveBeenCalled();
    await app.close();
  });

  it('他組織のファイルは消せない', async () => {
    prismaMock.uploadedFile.findUnique.mockResolvedValue({ ...row, orgId: 'org-2' });
    const app = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/files/file-1' });
    expect(res.statusCode).toBe(404);
    expect(driverMock.delete).not.toHaveBeenCalled();
    expect(prismaMock.uploadedFile.delete).not.toHaveBeenCalled();
    await app.close();
  });
});
