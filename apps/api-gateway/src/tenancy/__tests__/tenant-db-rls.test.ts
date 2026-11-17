import { describe, it, expect, vi, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';

// RLS Phase 2a（RLS_MODE=on）でテナントクライアントが set_config と本体を同じトランザクションに入れること。
// DB は偽物。「何が・どの順で・どのトランザクションに入ったか」だけを見る（実 DB は tests/integration/rls.int.test.ts）。

vi.mock('../../utils/prisma', () => ({ prisma: {} }));

const { tenantDbFrom } = await import('../index');

/** 呼ばれた順に記録する偽クライアント。クエリは「遅延の印」を返し、batch / await で実行されたことにする */
function fakeClient(opts: { interactive?: boolean } = {}) {
  const log: string[] = [];
  const q = (name: string, value: unknown = name) => {
    log.push(`build:${name}`);
    const p = Promise.resolve(value);
    return Object.assign(p, { __q: name });
  };
  const c: Record<string, unknown> = {
    aILog: { count: vi.fn((a: unknown) => q('aILog.count', { args: a })), create: vi.fn((a: unknown) => q('aILog.create', a)) },
    fileChunk: { findMany: vi.fn(() => q('fileChunk.findMany', [])) },
    task: { findMany: vi.fn(() => q('task.findMany', [])) },
    $queryRaw: vi.fn((sql: Prisma.Sql | TemplateStringsArray, ...vals: unknown[]) => {
      const text = 'sql' in (sql as Prisma.Sql) ? (sql as Prisma.Sql).sql : (sql as TemplateStringsArray).join('?');
      const values = 'values' in (sql as Prisma.Sql) ? (sql as Prisma.Sql).values : vals;
      return q(`raw:${text}:${JSON.stringify(values)}`, [{ ok: 1 }]);
    }),
    $executeRaw: vi.fn((sql: TemplateStringsArray) => q(`exec:${sql.join('?')}`, 1)),
  };
  if (!opts.interactive) {
    c.$transaction = vi.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) {
        log.push(`batch:[${arg.map((x) => (x as { __q: string }).__q).join(' | ')}]`);
        return Promise.all(arg);
      }
      log.push('interactive:begin');
      const r = await (arg as (tx: unknown) => Promise<unknown>)(fakeClient({ interactive: true }).c);
      return r;
    });
  }
  return { c, log };
}

const SET = `raw:SELECT set_config('app.org_id', ?, true):["org-A"]`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RLS_MODE=off（既定）', () => {
  it('包まない（batch も set_config も無い）', async () => {
    const { c, log } = fakeClient();
    const db = tenantDbFrom(c, 'org-A');
    await db.aILog.count({ where: {} });
    await db.$executeRaw`DELETE FROM "FileChunk" WHERE "orgId" = ${'org-A'}`;
    expect(log.some((l) => l.startsWith('batch'))).toBe(false);
    expect(log.some((l) => l.includes('set_config'))).toBe(false);
    expect(c.aILog as unknown).toBeDefined();
    expect((c.aILog as { count: ReturnType<typeof vi.fn> }).count).toHaveBeenCalledWith({ where: { orgId: 'org-A' } });
  });

  it('RLS_MODE が on 以外の値なら off 扱い', async () => {
    vi.stubEnv('RLS_MODE', 'enforce');
    const { c, log } = fakeClient();
    await tenantDbFrom(c, 'org-A').aILog.count({});
    expect(log.some((l) => l.startsWith('batch'))).toBe(false);
  });
});

describe('RLS_MODE=on', () => {
  it('4 表の操作は set_config と同じ batch transaction に入る（set_config が先）', async () => {
    vi.stubEnv('RLS_MODE', ' ON ');
    const { c, log } = fakeClient();
    const db = tenantDbFrom(c, 'org-A');
    const n = await db.aILog.count({ where: { department: 'SALES' } });
    expect(n).toEqual({ args: { where: { department: 'SALES', orgId: 'org-A' } } });
    expect(log).toContain(`batch:[${SET} | aILog.count]`);
    await db.fileChunk.findMany({});
    expect(log).toContain(`batch:[${SET} | fileChunk.findMany]`);
  });

  it('raw SQL も包む。値はバインド変数で渡す（SQL に埋め込まない）', async () => {
    vi.stubEnv('RLS_MODE', 'on');
    const { c, log } = fakeClient();
    const db = tenantDbFrom(c, 'org-A');
    const r = await db.$executeRaw`DELETE FROM "FileChunk" WHERE "orgId" = ${'org-A'}`;
    expect(r).toBe(1);
    expect(log).toContain(`batch:[${SET} | exec:DELETE FROM "FileChunk" WHERE "orgId" = ?]`);
    const rows = await db.$queryRaw(Prisma.sql`SELECT 1 FROM "MessageEmbedding" WHERE "orgId" = ${'org-A'}`);
    expect(rows).toEqual([{ ok: 1 }]);
    expect(log.filter((l) => l.startsWith('batch'))).toHaveLength(2);
  });

  it('4 表以外は包まない（往復を増やさない）', async () => {
    vi.stubEnv('RLS_MODE', 'on');
    const { c, log } = fakeClient();
    await tenantDbFrom(c, 'org-A').task.findMany({});
    expect(log).toEqual(['build:task.findMany']);
  });

  it('$transaction(fn) は開始直後に 1 回だけ set_config し、中の操作は包まない', async () => {
    vi.stubEnv('RLS_MODE', 'on');
    const { c, log } = fakeClient();
    const db = tenantDbFrom(c, 'org-A');
    // 中の tx は別の偽クライアント。記録を見るために差し替える
    const inner = fakeClient({ interactive: true });
    (c.$transaction as ReturnType<typeof vi.fn>).mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(inner.c));
    await db.$transaction(async (tx) => {
      await tx.aILog.count({});
      await tx.$executeRaw`UPDATE "Organization" SET "name" = ${'x'} WHERE "id" = ${'org-A'}`;
    });
    expect(inner.log[0]).toBe(`build:${SET}`);
    expect(inner.log.filter((l) => l.includes('set_config'))).toHaveLength(1);
    expect(inner.log).toContain('build:aILog.count');
    expect(log.some((l) => l.startsWith('batch'))).toBe(false);
  });

  it('外から渡された tx（tenantDbFrom(tx, orgId)）では本体の直前に set_config を流す', async () => {
    vi.stubEnv('RLS_MODE', 'on');
    const { c, log } = fakeClient({ interactive: true });
    const db = tenantDbFrom(c, 'org-A');
    await db.aILog.create({ data: { department: 'GENERAL' } as never });
    expect(log).toEqual([`build:${SET}`, 'build:aILog.create']);
  });

  it('組織ごとに自分の orgId を設定する（別のクライアントの値を使わない）', async () => {
    vi.stubEnv('RLS_MODE', 'on');
    const { c, log } = fakeClient();
    await tenantDbFrom(c, 'org-B').aILog.count({});
    expect(log[0]).toBe(`build:raw:SELECT set_config('app.org_id', ?, true):["org-B"]`);
  });
});
