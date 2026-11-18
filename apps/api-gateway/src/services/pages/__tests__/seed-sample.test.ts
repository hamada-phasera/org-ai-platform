import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pageDefinitionSchema, pageUpsertSchema, projectQueryResult, type PageDefinition } from '@org-ai/shared-types';
import { FakePrisma } from '../../../../tests/helpers/fake-prisma';
import { SAMPLE_DEFINITION, orgRow } from '../../../../tests/pages/fixtures';
import {
  SAMPLE_INQUIRIES_DATA,
  SAMPLE_INQUIRIES_UPSERT,
  SAMPLE_PAGE_SLUG,
  parsedSampleUpsert,
  seedDefinitionHash,
  seedSamplePages,
} from '../../../../../../packages/db-schema/prisma/seed-pages';

// 業務ページのシードと n8n サンプル（docs/design/custom-pages.md §8・§9・チャンク 7）。
//   - seed の定義（正本）・n8n サンプルに埋め込んだ定義・テストの fixture が同じで、スキーマを通る
//   - seed の sampleData が本番と同じ projectQueryResult を通って KPI と表になる（DoD D1 のデータ側）
//   - seed のハッシュが gateway の definitionHashOf と同じ（手動 upsert で無駄に version が上がらない）
//   - 何度実行しても 1 行。n8n や人が作った同名のページには触らない

vi.mock('../../../utils/prisma', () => ({ prisma: {} }));
const { definitionHashOf } = await import('../upsert');

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const n8nSample = JSON.parse(readFileSync(join(ROOT, 'apps', 'n8n-workflows', 'pages', 'page-inquiries.json'), 'utf8')) as {
  nodes: { type: string; parameters: Record<string, unknown> }[];
};
const embeddedUpsert = (): unknown => {
  const put = n8nSample.nodes.find((n) => n.type === 'n8n-nodes-base.httpRequest');
  return JSON.parse(String(put?.parameters.jsonBody));
};

describe('サンプル定義（seed / n8n / fixture）', () => {
  it('seed の登録 body は pageUpsertSchema を通る', () => {
    expect(pageUpsertSchema.safeParse(JSON.parse(JSON.stringify(SAMPLE_INQUIRIES_UPSERT))).success).toBe(true);
  });

  it('n8n サンプルの登録ノードに埋め込んだ body はスキーマを通り、seed と同じ', () => {
    const parsed = pageUpsertSchema.safeParse(embeddedUpsert());
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(parsedSampleUpsert());
  });

  it('ルートテストの fixture（設計書 §9）とも同じ定義', () => {
    expect(pageDefinitionSchema.parse(SAMPLE_DEFINITION)).toEqual(parsedSampleUpsert().definition);
  });

  it('n8n の Webhook のパスは定義の hook と一致する（pages/__ORG_ID__/<hook>）', () => {
    const hooks = new Set(Object.values(parsedSampleUpsert().definition.actions).map((a) => a.hook));
    const paths = n8nSample.nodes
      .filter((n) => n.type === 'n8n-nodes-base.webhook')
      .map((n) => String(n.parameters.path));
    expect(new Set(paths)).toEqual(new Set([...hooks].map((h) => `pages/__ORG_ID__/${h}`)));
  });

  it('seed のハッシュは gateway の definitionHashOf と同じ', () => {
    const def = parsedSampleUpsert().definition;
    expect(seedDefinitionHash(def)).toBe(definitionHashOf(def));
  });
});

describe('sampleData（サンプルモードの応答）', () => {
  const def: PageDefinition = parsedSampleUpsert().definition;

  it('query の action の分だけを持つ（submit の応答は gateway が固定の文言で返す）', () => {
    const queries = Object.entries(def.actions).filter(([, a]) => a.kind === 'query').map(([id]) => id);
    expect(Object.keys(SAMPLE_INQUIRIES_DATA).sort()).toEqual(queries.sort());
  });

  it('本番と同じ projectQueryResult を通り、どのブロックも error にならない（KPI と表が出る）', () => {
    const result = projectQueryResult(def, 'list', JSON.parse(JSON.stringify(SAMPLE_INQUIRIES_DATA.list)));
    expect(result.blocks.some((b) => 'error' in b)).toBe(false);
    const kpi = result.blocks.find((b) => b.type === 'kpi');
    expect(kpi && 'values' in kpi ? kpi.values : null).toEqual({ 0: 3, 1: 12 });
    const table = result.blocks.find((b) => b.type === 'table');
    const rows = table && 'rows' in table ? table.rows : [];
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.id !== null)).toBe(true); // 行の「完了」が出る
    expect(Object.keys(rows[0]!.cells).sort()).toEqual(['date', 'name', 'status', 'subject']);
  });

  it('未対応の件数が行と合っている（見た目で矛盾しない）', () => {
    const open = SAMPLE_INQUIRIES_DATA.list.rows.filter((r) => r.status === '未対応').length;
    expect(SAMPLE_INQUIRIES_DATA.list.open).toBe(open);
  });
});

describe('seedSamplePages', () => {
  const asSeedPrisma = (fake: FakePrisma) => fake as unknown as Parameters<typeof seedSamplePages>[0];
  const pages = (fake: FakePrisma) => fake.rows('customPage');

  it('無ければ SEED・公開・sampleData 付きで作り、再実行では何も変えない', async () => {
    const fake = new FakePrisma({ organization: [orgRow('demo-org-001', { plan: 'STARTER' })], customPage: [] });
    expect(await seedSamplePages(asSeedPrisma(fake), 'demo-org-001')).toBe('created');
    expect(pages(fake)).toHaveLength(1);
    expect(pages(fake)[0]).toMatchObject({
      orgId: 'demo-org-001', slug: SAMPLE_PAGE_SLUG, title: '問い合わせ', icon: 'inbox',
      status: 'PUBLISHED', source: 'SEED', version: 1,
      definitionHash: definitionHashOf(parsedSampleUpsert().definition),
      sampleData: JSON.parse(JSON.stringify(SAMPLE_INQUIRIES_DATA)),
    });
    expect(await seedSamplePages(asSeedPrisma(fake), 'demo-org-001')).toBe('unchanged');
    expect(pages(fake)).toHaveLength(1);
    expect(pages(fake)[0]).toMatchObject({ version: 1 });
  });

  it('定義が古ければ定義だけ直して version + 1。画面で変えた status・並び・title は守る', async () => {
    const fake = new FakePrisma({ organization: [orgRow('demo-org-001')], customPage: [] });
    await seedSamplePages(asSeedPrisma(fake), 'demo-org-001');
    Object.assign(pages(fake)[0]!, {
      status: 'DRAFT', sortOrder: 3, title: '問合せ', definitionHash: 'old', sampleData: { list: { open: 0 } },
    });
    expect(await seedSamplePages(asSeedPrisma(fake), 'demo-org-001')).toBe('updated');
    expect(pages(fake)[0]).toMatchObject({
      status: 'DRAFT', sortOrder: 3, title: '問合せ', version: 2,
      definitionHash: definitionHashOf(parsedSampleUpsert().definition),
      sampleData: JSON.parse(JSON.stringify(SAMPLE_INQUIRIES_DATA)),
    });
  });

  it('n8n や人が作った同名のページには触らない（sampleData を足さない）', async () => {
    const fake = new FakePrisma({ organization: [orgRow('demo-org-001')], customPage: [] });
    await seedSamplePages(asSeedPrisma(fake), 'demo-org-001');
    Object.assign(pages(fake)[0]!, { source: 'N8N', sampleData: null, definitionHash: 'n8n' });
    expect(await seedSamplePages(asSeedPrisma(fake), 'demo-org-001')).toBe('skipped');
    expect(pages(fake)[0]).toMatchObject({ source: 'N8N', sampleData: null, definitionHash: 'n8n' });
  });

  it('他の組織の同名ページには触らない', async () => {
    const fake = new FakePrisma({ organization: [orgRow('org-A'), orgRow('org-B')], customPage: [] });
    await seedSamplePages(asSeedPrisma(fake), 'org-B');
    await seedSamplePages(asSeedPrisma(fake), 'org-A');
    expect(pages(fake).map((p) => p.orgId).sort()).toEqual(['org-A', 'org-B']);
  });
});
