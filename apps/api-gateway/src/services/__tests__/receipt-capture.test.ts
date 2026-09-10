import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AI_ENGINE_URL = 'https://ai.test';

const prismaMock = {
  project: { findFirst: vi.fn(), findMany: vi.fn() },
  vendor: { findFirst: vi.fn(), findMany: vi.fn() },
  costEntry: { create: vi.fn(), findFirst: vi.fn() },
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

/** 工事が name の完全一致で1件に決まる状態を作る（code 不一致 → name 1件） */
function projectResolvesByName(project = { id: 'p1', name: '山田邸新築', code: 'K-001' }) {
  prismaMock.project.findFirst.mockResolvedValueOnce(null); // code 不一致
  prismaMock.project.findMany.mockResolvedValueOnce([project]); // name 完全一致 1件
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
  prismaMock.costEntry.findFirst.mockResolvedValue(null); // 既存の同内容明細なし
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
    prismaMock.project.findMany.mockResolvedValueOnce([]); // 完全一致なし
    prismaMock.project.findMany.mockResolvedValueOnce([{ id: 'p2', name: '山田邸新築', code: 'K-002' }]);
    const r = await matchProject('org-1', '山田邸');
    expect(r?.id).toBe('p2');
  });

  it('⚠️ 工事名が完全一致でも複数あれば null（name に一意制約は無い）', async () => {
    // 「山田邸 1期(請求済)」と「山田邸 2期(施工中)」の両方がある状況。
    // findFirst で1件選ぶと、完成済みの現場に原価が付き、しかも再現しない
    prismaMock.project.findMany.mockResolvedValueOnce([
      { id: 'p1', name: '山田邸', code: 'K-001' },
      { id: 'p2', name: '山田邸', code: 'K-002' },
    ]);
    expect(await matchProject('org-1', '山田邸')).toBeNull();
  });

  it('LIKE のメタ文字をエスケープする（% で何にでも当たらない）', async () => {
    prismaMock.project.findMany.mockResolvedValue([]);
    await matchProject('org-1', '山田%邸');
    const partialCall = prismaMock.project.findMany.mock.calls[1][0];
    expect(partialCall.where.name.contains).toBe('山田\\%邸');
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
    prismaMock.vendor.findFirst.mockResolvedValueOnce(null);
    prismaMock.vendor.findMany.mockResolvedValueOnce([
      { id: 'v1', name: '〇〇建材 本店' },
      { id: 'v2', name: '〇〇建材 支店' },
    ]);
    expect(await matchVendor('org-1', '〇〇建材')).toBeNull();
  });
});

describe('captureReceiptFromLine', () => {
  it('正常系: 工事が特定できたら DRAFT の原価明細を作る', async () => {
    projectResolvesByName();
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
    projectResolvesByName();
    fetchMock.mockResolvedValue(visionReply({ ...FULL_EXTRACTION, category: 'WELFARE' }));

    await captureReceiptFromLine({ orgId: 'org-1', plan: 'PRO', accessToken: 'tok', messageId: 'm1' });

    expect(prismaMock.costEntry.create.mock.calls[0][0].data.category).toBe('OTHER');
  });

  it('⚠️ 日付が読めなければ明細を作らない（受信日で仮置きしない）', async () => {
    // 月末に先月分をまとめて送るのは建設業では普通。今日の日付で埋めると
    // 全部が今月に計上され、承認画面ではもっともらしく見えて期ズレが静かに起きる
    projectResolvesByName();
    fetchMock.mockResolvedValue(visionReply({ ...FULL_EXTRACTION, incurredOn: null }));

    const r = await captureReceiptFromLine({
      orgId: 'org-1', plan: 'PRO', accessToken: 'tok', messageId: 'm1',
    });

    expect(r.costEntryId).toBeNull();
    expect(prismaMock.costEntry.create).not.toHaveBeenCalled();
    expect(r.summary).toContain('日付を読み取れませんでした');
  });

  it('存在しない日付（2026-02-31）も作らない', async () => {
    projectResolvesByName();
    fetchMock.mockResolvedValue(visionReply({ ...FULL_EXTRACTION, incurredOn: '2026-02-31' }));
    const r = await captureReceiptFromLine({
      orgId: 'org-1', plan: 'PRO', accessToken: 'tok', messageId: 'm1',
    });
    expect(r.costEntryId).toBeNull();
  });

  it('⚠️ 読み取った消費税が本体価格以上なら割り戻しに退避する（0円の明細を作らない）', async () => {
    // レイアウトの崩れた感熱紙で「合計」と「消費税」を取り違えると起きる
    projectResolvesByName();
    fetchMock.mockResolvedValue(
      visionReply({ ...FULL_EXTRACTION, amountIncludingTax: 35_000, taxAmount: 35_000 }),
    );

    await captureReceiptFromLine({ orgId: 'org-1', plan: 'PRO', accessToken: 'tok', messageId: 'm1' });

    const data = prismaMock.costEntry.create.mock.calls[0][0].data;
    expect(data.amount).toBe(31_818); // 割り戻しに退避
    expect(data.taxAmount).toBe(3_182);
    expect(data.amount).toBeGreaterThan(0);
  });

  it('⚠️ 負の消費税を読んでも原価を負にしない', async () => {
    projectResolvesByName();
    fetchMock.mockResolvedValue(
      visionReply({ ...FULL_EXTRACTION, amountIncludingTax: 1_000, taxAmount: -10_000 }),
    );

    await captureReceiptFromLine({ orgId: 'org-1', plan: 'PRO', accessToken: 'tok', messageId: 'm1' });

    const data = prismaMock.costEntry.create.mock.calls[0][0].data;
    expect(data.amount).toBeGreaterThan(0);
    expect(data.amount + data.taxAmount).toBe(1_000);
  });

  it('労務費で消費税が読めなければ 0 にする（不課税を10%で割り戻さない）', async () => {
    projectResolvesByName();
    fetchMock.mockResolvedValue(
      visionReply({ ...FULL_EXTRACTION, category: 'LABOR', taxAmount: null, amountIncludingTax: 1_000_000 }),
    );

    await captureReceiptFromLine({ orgId: 'org-1', plan: 'PRO', accessToken: 'tok', messageId: 'm1' });

    const data = prismaMock.costEntry.create.mock.calls[0][0].data;
    expect(data.taxAmount).toBe(0);
    expect(data.amount).toBe(1_000_000); // 実額のまま。909,091 に目減りさせない
  });

  it('確からしさが低い読み取りは自動登録しない', async () => {
    projectResolvesByName();
    fetchMock.mockResolvedValue(visionReply({ ...FULL_EXTRACTION, confidence: 0.2 }));

    const r = await captureReceiptFromLine({
      orgId: 'org-1', plan: 'PRO', accessToken: 'tok', messageId: 'm1',
    });

    expect(r.costEntryId).toBeNull();
    expect(r.summary).toContain('確からしさが低い');
  });

  it('同じ内容の明細が既にあれば二重に作らない（同じ写真の再送）', async () => {
    projectResolvesByName();
    prismaMock.costEntry.findFirst.mockResolvedValue({ id: 'cost-existing' });
    fetchMock.mockResolvedValue(visionReply(FULL_EXTRACTION));

    const r = await captureReceiptFromLine({
      orgId: 'org-1', plan: 'PRO', accessToken: 'tok', messageId: 'm1',
    });

    expect(r.costEntryId).toBeNull();
    expect(prismaMock.costEntry.create).not.toHaveBeenCalled();
    expect(r.summary).toContain('既にある');
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
