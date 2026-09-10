import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AI_ENGINE_URL = 'https://ai.test';

const prismaMock = {
  project: { findFirst: vi.fn(), findMany: vi.fn() },
  vendor: { findFirst: vi.fn(), findMany: vi.fn() },
  costEntry: { create: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const fetchContentMock = vi.fn();
vi.mock('../inbox/line-client', () => ({
  fetchLineMessageContent: (...args: unknown[]) => fetchContentMock(...args),
  MAX_LINE_IMAGE_BYTES: 5 * 1024 * 1024,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { captureReceiptFromLine, matchProject, matchVendor, summarizeExtraction } = await import(
  '../inbox/receipt-capture'
);

const IMAGE_OK = { ok: true, base64: 'AAAA', mediaType: 'image/jpeg', bytes: 4 };

/** ai-engine /vision/receipt の応答 */
function visionReply(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body };
}

const FULL_EXTRACTION = {
  amountIncludingTax: 35_000,
  taxAmount: null,
  incurredOn: '2026-09-05',
  vendorHint: '〇〇建材',
  category: 'MATERIAL',
  projectHint: '山田邸新築',
  description: '木材',
  confidence: 0.9,
  notes: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.project.findFirst.mockResolvedValue(null);
  prismaMock.project.findMany.mockResolvedValue([]);
  prismaMock.vendor.findFirst.mockResolvedValue(null);
  prismaMock.vendor.findMany.mockResolvedValue([]);
  prismaMock.costEntry.create.mockResolvedValue({ id: 'cost-1' });
  fetchContentMock.mockResolvedValue(IMAGE_OK);
});

describe('matchProject', () => {
  it('工事番号の完全一致を最優先する', async () => {
    prismaMock.project.findFirst.mockResolvedValueOnce({ id: 'p1', name: '山田邸', code: 'K-001' });
    const r = await matchProject('org-1', 'K-001');
    expect(r?.id).toBe('p1');
    expect(prismaMock.project.findMany).not.toHaveBeenCalled();
  });

  it('部分一致は「1件だけ」のときに採用する', async () => {
    prismaMock.project.findMany.mockResolvedValueOnce([{ id: 'p2', name: '山田邸新築', code: 'K-002' }]);
    const r = await matchProject('org-1', '山田邸');
    expect(r?.id).toBe('p2');
  });

  it('⚠️ 候補が複数なら null（別の現場の原価にして粗利を狂わせない）', async () => {
    prismaMock.project.findMany.mockResolvedValueOnce([
      { id: 'p2', name: '山田邸新築', code: 'K-002' },
      { id: 'p3', name: '山田邸改修', code: 'K-003' },
    ]);
    expect(await matchProject('org-1', '山田邸')).toBeNull();
  });

  it('エッジ: ヒントが無い・短すぎるときは DB を引かない', async () => {
    expect(await matchProject('org-1', null)).toBeNull();
    expect(await matchProject('org-1', 'あ')).toBeNull();
    expect(await matchProject('org-1', '  ')).toBeNull();
    expect(prismaMock.project.findFirst).not.toHaveBeenCalled();
  });

  it('必ず orgId で絞る', async () => {
    prismaMock.project.findFirst.mockResolvedValueOnce(null);
    await matchProject('org-1', 'K-001');
    expect(prismaMock.project.findFirst.mock.calls[0][0].where.orgId).toBe('org-1');
  });
});

describe('matchVendor', () => {
  it('完全一致 → 部分一致1件の順で絞る', async () => {
    prismaMock.vendor.findFirst.mockResolvedValueOnce({ id: 'v1', name: '〇〇建材' });
    expect((await matchVendor('org-1', '〇〇建材'))?.id).toBe('v1');
  });

  it('複数候補なら null', async () => {
    prismaMock.vendor.findMany.mockResolvedValueOnce([
      { id: 'v1', name: '〇〇建材 本店' },
      { id: 'v2', name: '〇〇建材 支店' },
    ]);
    expect(await matchVendor('org-1', '〇〇建材')).toBeNull();
  });
});

describe('captureReceiptFromLine', () => {
  it('正常系: 工事が特定できたら DRAFT の原価明細を作る', async () => {
    prismaMock.project.findFirst.mockResolvedValueOnce(null); // code 不一致
    prismaMock.project.findFirst.mockResolvedValueOnce({ id: 'p1', name: '山田邸新築', code: 'K-001' });
    fetchMock.mockResolvedValue(visionReply(FULL_EXTRACTION));

    const r = await captureReceiptFromLine({
      orgId: 'org-1',
      plan: 'PRO',
      accessToken: 'tok',
      messageId: 'm1',
    });

    expect(r.costEntryId).toBe('cost-1');
    const data = prismaMock.costEntry.create.mock.calls[0][0].data;
    // ⚠️ AI が読んだ数字をそのまま確定値にしない
    expect(data.status).toBe('DRAFT');
    expect(data.source).toBe('LINE');
    expect(data.projectId).toBe('p1');
    expect(data.category).toBe('MATERIAL');
    // 35,000 円（税込）→ 本体 31,818 + 消費税 3,182
    expect(data.amount + data.taxAmount).toBe(35_000);
    expect(data.taxAmount).toBe(3_182);
    expect(r.summary).toContain('山田邸新築');
  });

  it('⚠️ 工事が特定できなければ明細を作らない（当てずっぽうで現場に付けない）', async () => {
    fetchMock.mockResolvedValue(visionReply({ ...FULL_EXTRACTION, projectHint: '不明な現場' }));

    const r = await captureReceiptFromLine({
      orgId: 'org-1',
      plan: 'PRO',
      accessToken: 'tok',
      messageId: 'm1',
    });

    expect(r.costEntryId).toBeNull();
    expect(prismaMock.costEntry.create).not.toHaveBeenCalled();
    expect(r.summary).toContain('工事を選んで');
  });

  it('金額が読めなければ明細を作らない（0円の明細を台帳に載せない）', async () => {
    prismaMock.project.findFirst.mockResolvedValueOnce(null);
    prismaMock.project.findFirst.mockResolvedValueOnce({ id: 'p1', name: '山田邸新築', code: 'K-001' });
    fetchMock.mockResolvedValue(visionReply({ ...FULL_EXTRACTION, amountIncludingTax: null }));

    const r = await captureReceiptFromLine({
      orgId: 'org-1',
      plan: 'PRO',
      accessToken: 'tok',
      messageId: 'm1',
    });

    expect(r.costEntryId).toBeNull();
    expect(r.summary).toContain('金額を読み取れませんでした');
  });

  it('消費税額が読めていればそれを使う（割り戻さない）', async () => {
    prismaMock.project.findFirst.mockResolvedValueOnce(null);
    prismaMock.project.findFirst.mockResolvedValueOnce({ id: 'p1', name: '山田邸新築', code: 'K-001' });
    // 軽減税率や端数処理で 10/110 と一致しないことがあるので、書いてある額を優先する
    fetchMock.mockResolvedValue(visionReply({ ...FULL_EXTRACTION, taxAmount: 3_000 }));

    await captureReceiptFromLine({ orgId: 'org-1', plan: 'PRO', accessToken: 'tok', messageId: 'm1' });

    const data = prismaMock.costEntry.create.mock.calls[0][0].data;
    expect(data.taxAmount).toBe(3_000);
    expect(data.amount).toBe(32_000);
  });

  it('画像が取得できなければ ai-engine を呼ばない', async () => {
    fetchContentMock.mockResolvedValue({ ok: false, reason: 'FETCH_FAILED' });

    const r = await captureReceiptFromLine({
      orgId: 'org-1',
      plan: 'PRO',
      accessToken: 'tok',
      messageId: 'm1',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.costEntryId).toBeNull();
  });

  it('大きすぎる画像は読まずに知らせる', async () => {
    fetchContentMock.mockResolvedValue({ ok: false, reason: 'TOO_LARGE' });
    const r = await captureReceiptFromLine({
      orgId: 'org-1',
      plan: 'PRO',
      accessToken: 'tok',
      messageId: 'm1',
    });
    expect(r.summary).toContain('大きすぎ');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ai-engine が落ちていても例外にしない', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const r = await captureReceiptFromLine({
      orgId: 'org-1',
      plan: 'PRO',
      accessToken: 'tok',
      messageId: 'm1',
    });
    expect(r.costEntryId).toBeNull();
    expect(r.summary).toContain('読み取りに失敗');
  });

  it('未知の費目は OTHER に寄せる（保存時に落ちないようにする）', async () => {
    prismaMock.project.findFirst.mockResolvedValueOnce(null);
    prismaMock.project.findFirst.mockResolvedValueOnce({ id: 'p1', name: '山田邸新築', code: 'K-001' });
    fetchMock.mockResolvedValue(visionReply({ ...FULL_EXTRACTION, category: 'WELFARE' }));

    await captureReceiptFromLine({ orgId: 'org-1', plan: 'PRO', accessToken: 'tok', messageId: 'm1' });

    expect(prismaMock.costEntry.create.mock.calls[0][0].data.category).toBe('OTHER');
  });

  it('画像そのものは DB に渡さない（保存しないという前提の担保）', async () => {
    prismaMock.project.findFirst.mockResolvedValueOnce(null);
    prismaMock.project.findFirst.mockResolvedValueOnce({ id: 'p1', name: '山田邸新築', code: 'K-001' });
    fetchMock.mockResolvedValue(visionReply(FULL_EXTRACTION));

    await captureReceiptFromLine({ orgId: 'org-1', plan: 'PRO', accessToken: 'tok', messageId: 'm1' });

    const written = JSON.stringify(prismaMock.costEntry.create.mock.calls[0][0]);
    expect(written).not.toContain(IMAGE_OK.base64);
    expect(written).not.toContain('image/jpeg');
  });
});

describe('summarizeExtraction', () => {
  it('紐付いたときは登録先と次にやることを書く', () => {
    const s = summarizeExtraction(FULL_EXTRACTION, { name: '山田邸新築' }, true);
    expect(s).toContain('〇〇建材');
    expect(s).toContain('¥35,000');
    expect(s).toContain('未確認');
  });

  it('読めた項目だけを並べる（null を「null」と出さない）', () => {
    const s = summarizeExtraction(
      { ...FULL_EXTRACTION, vendorHint: null, incurredOn: null },
      null,
      false,
    );
    expect(s).not.toContain('null');
  });
});
