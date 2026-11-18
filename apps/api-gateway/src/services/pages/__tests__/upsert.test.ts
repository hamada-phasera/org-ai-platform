import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { FakePrisma } from '../../../../tests/helpers/fake-prisma';
import { orgRow, sampleUpsert } from '../../../../tests/pages/fixtures';

// upsert の細部（冪等のハッシュ・同時登録・同時更新・エラー文言）。ルート経由のテストは tests/pages/*.route.test.ts。

vi.mock('../../../utils/prisma', () => ({ prisma: {} }));
const { tenantDbFrom } = await import('../../../tenancy');
const { upsertPage, definitionHashOf, describeIssues } = await import('../upsert');
const { pageUpsertSchema } = await import('@org-ai/shared-types');

const input = (over: Record<string, unknown> = {}) => pageUpsertSchema.parse(sampleUpsert(over));

describe('definitionHashOf', () => {
  it('キーの順番に依らず、配列の順番には依る', () => {
    const a = input().definition;
    const b = { blocks: a.blocks, actions: Object.fromEntries(Object.entries(a.actions).reverse()) } as typeof a;
    expect(definitionHashOf(a)).toBe(definitionHashOf(b));
    const c = { ...a, blocks: [...a.blocks].reverse() } as typeof a;
    expect(definitionHashOf(a)).not.toBe(definitionHashOf(c));
  });
});

type Fn = (args: Record<string, unknown>) => Promise<unknown>;

/** 偽 Prisma の customPage の一部の操作だけ差し替えた土台（tenantDb はこの上に orgId を差し込む） */
function withCustomPage(fake: FakePrisma, override: (real: Record<string, Fn>) => Record<string, Fn>): unknown {
  return new Proxy(fake, {
    get(t, prop) {
      const v = (t as unknown as Record<string | symbol, unknown>)[prop];
      if (prop !== 'customPage') return v;
      const real = v as Record<string, Fn>;
      return { ...real, ...override(real) };
    },
  });
}

describe('upsertPage', () => {
  it('seed のページを管理者が手で上書きすると MANUAL になり、サンプルの応答（sampleData）は捨てる（L8）', async () => {
    const { pageRow } = await import('../../../../tests/pages/fixtures');
    const fake = new FakePrisma({
      organization: [orgRow('org-A')],
      customPage: [pageRow({ id: 'p-seed', orgId: 'org-A', slug: 'inquiries', source: 'SEED', sampleData: { list: { open: 1 } } })],
      auditEvent: [],
    });
    const db = tenantDbFrom(fake, 'org-A');
    await upsertPage(db, { slug: 'inquiries', input: input(), source: 'MANUAL', plan: 'PRO', actorId: 'u-admin' });
    const row = fake.rows('customPage')[0]!;
    expect(row.source).toBe('MANUAL');
    expect(row.sampleData).toBe(Prisma.DbNull);
  });

  it('n8n の行の更新では sampleData に触れない', async () => {
    const { pageRow } = await import('../../../../tests/pages/fixtures');
    const fake = new FakePrisma({
      organization: [orgRow('org-A')],
      customPage: [pageRow({ id: 'p-n8n', orgId: 'org-A', slug: 'orders', source: 'N8N', sampleData: null })],
      auditEvent: [],
    });
    await upsertPage(tenantDbFrom(fake, 'org-A'), { slug: 'orders', input: input(), source: 'N8N', plan: 'PRO', actorId: null });
    expect(fake.rows('customPage')[0]!.sampleData).toBeNull();
  });

  it('同じ slug の同時作成（P2002）は、先に入った行への更新としてやり直す', async () => {
    const fake = new FakePrisma({ organization: [orgRow('org-A')], customPage: [], auditEvent: [] });
    let raced = false;
    // findUnique の直後に別のリクエストが同じ slug を作った状況を作る
    const db = tenantDbFrom(
      withCustomPage(fake, (real) => ({
        create: async (args) => {
          if (!raced) {
            raced = true;
            await real.create(args);
          }
          return real.create(args);
        },
      })),
      'org-A',
    );
    const res = await upsertPage(db, { slug: 'orders', input: input(), source: 'N8N', plan: 'PRO', actorId: null });
    expect(raced).toBe(true);
    expect(res).toMatchObject({ created: false, changed: false, version: 1 });
    expect(fake.rows('customPage')).toHaveLength(1);
  });

  it('梅（1 ページまで）で同じ slug を同時に作っても、上限で断らず更新としてやり直す', async () => {
    const fake = new FakePrisma({ organization: [orgRow('org-A')], customPage: [], auditEvent: [] });
    const first = tenantDbFrom(fake, 'org-A');
    let raced = false;
    // findUnique（無い）→ 別のリクエストが同じ slug を作る → count の順で走らせる
    const db = tenantDbFrom(
      withCustomPage(fake, (real) => ({
        count: async (args) => {
          if (!raced) {
            raced = true;
            await upsertPage(first, { slug: 'orders', input: input(), source: 'N8N', plan: 'STARTER', actorId: null });
          }
          return real.count(args);
        },
      })),
      'org-A',
    );
    const res = await upsertPage(db, { slug: 'orders', input: input(), source: 'N8N', plan: 'STARTER', actorId: null });
    expect(raced).toBe(true);
    expect(res).toMatchObject({ created: false, changed: false, version: 1 });
    expect(fake.rows('customPage')).toHaveLength(1);
  });

  it('梅で別の slug の 2 つ目は 403 PAGE_LIMIT_REACHED のまま', async () => {
    const fake = new FakePrisma({ organization: [orgRow('org-A')], customPage: [], auditEvent: [] });
    const db = tenantDbFrom(fake, 'org-A');
    await upsertPage(db, { slug: 'orders', input: input(), source: 'N8N', plan: 'STARTER', actorId: null });
    await expect(
      upsertPage(db, { slug: 'other', input: input(), source: 'N8N', plan: 'STARTER', actorId: null }),
    ).rejects.toMatchObject({ status: 403, code: 'PAGE_LIMIT_REACHED' });
  });

  it('版が先に進んでいたら（同時更新）読み直してやり直す', async () => {
    const fake = new FakePrisma({ organization: [orgRow('org-A')], customPage: [], auditEvent: [] });
    await upsertPage(tenantDbFrom(fake, 'org-A'), { slug: 'orders', input: input(), source: 'N8N', plan: 'PRO', actorId: null });
    let first = true;
    const db = tenantDbFrom(
      withCustomPage(fake, (real) => ({
        updateMany: async (args) => {
          if (first) {
            first = false;
            fake.rows('customPage')[0].version = 7; // 別の更新が先に版を進めた
            return { count: 0 };
          }
          return real.updateMany(args);
        },
      })),
      'org-A',
    );
    const res = await upsertPage(db, {
      slug: 'orders', input: input({ title: '受付' }), source: 'N8N', plan: 'PRO', actorId: null,
    });
    expect(first).toBe(false);
    expect(res).toMatchObject({ changed: true, version: 7 });
    expect(fake.rows('customPage')[0].title).toBe('受付');
  });
});

describe('describeIssues', () => {
  it('最大 3 件を「場所: 理由」で、enum の値は載せない', () => {
    const parsed = pageUpsertSchema.safeParse({ ...sampleUpsert(), icon: 'evil-<b>', status: 'NOPE', minRole: 'GOD', title: '' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const msg = describeIssues(parsed.error.issues);
    expect(msg).not.toContain('evil-<b>');
    expect(msg).not.toContain('NOPE');
    expect(msg).toMatch(/ほか \d+ 件$/);
    expect(msg.split(' / ')).toHaveLength(3);
  });
});
