// 業務ページのシード（docs/design/custom-pages.md §8・§9）。
//
// - デモ組織に「問い合わせ」（slug `inquiries`、source = SEED、PUBLISHED）を入れる。
// - 定義はここが**唯一の正本**。n8n のサンプル（apps/n8n-workflows/pages/page-inquiries.json）の登録ノードに
//   同じ JSON を埋め込んであり、両者が一致することを gateway のテスト（seed-sample.test.ts）が確かめる。
// - `sampleData` は「アクション ID → n8n の応答そのもの」。書けるのは seed だけ（登録 API のスキーマに項目が無い。T16）。
//   使われるのは `PAGES_SAMPLE_MODE=true` かつ本番でないときだけ。gateway は本番と同じ projectQueryResult に通して返す。
// - 定義は shared-types の pageUpsertSchema を通してから書く（壊れた定義を DB に入れない）。
//
// ⚠️ ts-node（CommonJS）で動くので @org-ai/shared-types は dist を読む。`npm run seed` が先にビルドする。

import { createHash } from 'crypto';
import { PAGE_SCHEMA_VERSION, pageUpsertSchema, type PageDefinition, type PageUpsertInput } from '@org-ai/shared-types';
import type { Prisma, PrismaClient } from '@prisma/client';

export const SAMPLE_PAGE_SLUG = 'inquiries';

/**
 * 設計書 §9 のサンプル定義（n8n の登録ノードに埋め込むものと同じ）。
 * ⚠️ status / sortOrder / minRole は書かない: 書くとワークフローの再実行で管理者が画面で変えた値（公開など）を戻す（§5.3・レビュー M2）。
 */
export const SAMPLE_INQUIRIES_UPSERT = {
  title: '問い合わせ',
  icon: 'inbox',
  definition: {
    actions: {
      list: { kind: 'query', hook: 'inquiries-list' },
      create: { kind: 'submit', hook: 'inquiries-submit' },
      done: { kind: 'submit', hook: 'inquiries-submit', confirm: '対応済みにしますか' },
      remind: { kind: 'submit', hook: 'inquiries-submit', confirm: '担当へ通知しますか' },
    },
    blocks: [
      {
        type: 'kpi',
        items: [
          { label: '未対応', source: { action: 'list', key: 'open' } },
          { label: '今月', source: { action: 'list', key: 'month' } },
        ],
      },
      {
        type: 'table',
        source: { action: 'list', key: 'rows' },
        rowKey: 'id',
        columns: [
          { key: 'date', label: '日付', format: 'date' },
          { key: 'name', label: '名前', primary: true },
          { key: 'subject', label: '件名' },
          { key: 'status', label: '状態', format: 'badge' },
        ],
        rowAction: { label: '完了', action: 'done' },
      },
      {
        type: 'form',
        action: 'create',
        submit: '登録',
        fields: [
          { key: 'name', label: '名前', type: 'text', required: true },
          { key: 'tel', label: '電話', type: 'tel' },
          { key: 'subject', label: '件名', type: 'text', required: true },
          { key: 'body', label: '内容', type: 'textarea' },
        ],
      },
      { type: 'buttons', items: [{ label: '通知', action: 'remind' }] },
    ],
  },
} as const;

/** サンプルモードの応答（query の action ID → n8n が返すはずの JSON）。名前・電話は架空 */
export const SAMPLE_INQUIRIES_DATA = {
  list: {
    open: 3,
    month: 12,
    rows: [
      { id: 'inq-001', date: '2026-11-17', name: '山田建設', subject: '外壁塗装の見積', status: '未対応' },
      { id: 'inq-002', date: '2026-11-16', name: '佐藤様', subject: '浴室リフォームの相談', status: '未対応' },
      { id: 'inq-003', date: '2026-11-14', name: '鈴木工務店', subject: '足場の手配', status: '未対応' },
      { id: 'inq-004', date: '2026-11-10', name: '高橋様', subject: '雨漏りの点検', status: '対応済み' },
      { id: 'inq-005', date: '2026-11-05', name: '田中商店', subject: '店舗の内装', status: '対応済み' },
    ],
  },
} as const;

/** キーを並べ替えた JSON（配列の順は保つ）。gateway の definitionHashOf と同じ規則（テストで一致を確かめる） */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function seedDefinitionHash(definition: PageDefinition): string {
  return createHash('sha256').update(JSON.stringify(canonical(definition))).digest('hex');
}

/** サンプルの登録 body をスキーマに通したもの（通らなければ例外＝seed を止める） */
export function parsedSampleUpsert(): PageUpsertInput {
  return pageUpsertSchema.parse(JSON.parse(JSON.stringify(SAMPLE_INQUIRIES_UPSERT)));
}

type SeedPrisma = Pick<PrismaClient, 'customPage'>;

/**
 * 組織にサンプルページを入れる（何度実行しても 1 行）。
 * - 無ければ作る（source = SEED、PUBLISHED）。
 * - あれば定義と sampleData だけ合わせる（定義が変わったときだけ version + 1）。
 *   status・並び・minRole・title は画面で変えた値を守る。n8n や手動で作った同名のページには触らない。
 */
export async function seedSamplePages(prisma: SeedPrisma, orgId: string): Promise<'created' | 'updated' | 'unchanged' | 'skipped'> {
  const input = parsedSampleUpsert();
  const definition = input.definition as unknown as Prisma.InputJsonValue;
  const definitionHash = seedDefinitionHash(input.definition);
  const sampleData = JSON.parse(JSON.stringify(SAMPLE_INQUIRIES_DATA)) as Prisma.InputJsonValue;

  const existing = await prisma.customPage.findUnique({
    where: { orgId_slug: { orgId, slug: SAMPLE_PAGE_SLUG } },
    select: { id: true, source: true, version: true, definitionHash: true, sampleData: true },
  });

  if (!existing) {
    await prisma.customPage.create({
      data: {
        orgId,
        slug: SAMPLE_PAGE_SLUG,
        title: input.title,
        icon: input.icon ?? 'file-text',
        status: 'PUBLISHED',
        source: 'SEED',
        schemaVersion: PAGE_SCHEMA_VERSION,
        definition,
        definitionHash,
        sampleData,
      },
    });
    return 'created';
  }
  if (existing.source !== 'SEED') return 'skipped';

  const definitionChanged = existing.definitionHash !== definitionHash;
  const sampleChanged = JSON.stringify(canonical(existing.sampleData)) !== JSON.stringify(canonical(sampleData));
  if (!definitionChanged && !sampleChanged) return 'unchanged';

  await prisma.customPage.update({
    where: { id: existing.id },
    data: {
      sampleData,
      ...(definitionChanged
        ? { definition, definitionHash, schemaVersion: PAGE_SCHEMA_VERSION, version: existing.version + 1 }
        : {}),
    },
  });
  return 'updated';
}
