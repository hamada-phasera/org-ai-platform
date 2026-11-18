/* eslint-disable @typescript-eslint/no-explicit-any -- 不正な定義をわざと組み立てるテスト（型で守れない入力を確かめる） */
import { describe, it, expect } from 'vitest';
import {
  PAGE_ICONS,
  PAGE_LIMITS,
  buildInputSchema,
  canAddPage,
  pageActionState,
  pageDefinitionSchema,
  pageHookSchema,
  pageSlugSchema,
  pageSubmitResponseSchema,
  pageUpsertSchema,
  projectQueryResult,
  toPublicPageDefinition,
  utf8ByteLength,
  type PageDefinition,
} from '../index';

/** 設計書 §9 のサンプル（問い合わせ）。seed と n8n サンプルもこれと同じ形 */
const SAMPLE_UPSERT = {
  title: '問い合わせ',
  icon: 'inbox',
  status: 'DRAFT',
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
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sampleDefinition = (): PageDefinition => pageDefinitionSchema.parse(clone(SAMPLE_UPSERT.definition));

/** 定義の一部を差し替えて検証する */
function defWith(mutate: (d: any) => void) {
  const d = clone(SAMPLE_UPSERT.definition) as any;
  mutate(d);
  return pageDefinitionSchema.safeParse(d);
}

const ALL_BLOCKS = {
  actions: {
    q: { kind: 'query', hook: 'q' },
    s: { kind: 'submit', hook: 's', refresh: ['q'] },
  },
  blocks: [
    { type: 'heading', text: '見出し' },
    { type: 'text', text: '1 行目\n2 行目' },
    { type: 'kpi', items: [{ label: '件数', source: { action: 'q', key: 'count' }, format: 'number' }] },
    { type: 'table', source: { action: 'q', key: 'rows' }, columns: [{ key: 'a', label: 'A' }], empty: 'なし' },
    { type: 'list', source: { action: 'q', key: 'items' }, titleKey: 't', subKey: 's', metaKey: 'm' },
    {
      type: 'form',
      title: '登録',
      action: 's',
      submit: '送信',
      fields: [
        { key: 'a', label: 'A', type: 'text', maxLength: 50 },
        { key: 'b', label: 'B', type: 'textarea', maxLength: 2000 },
        { key: 'c', label: 'C', type: 'number', min: 0, max: 10 },
        { key: 'd', label: 'D', type: 'date' },
        { key: 'e', label: 'E', type: 'select', options: [{ value: 'x', label: 'X' }] },
        { key: 'f', label: 'F', type: 'checkbox' },
        { key: 'g', label: 'G', type: 'email' },
        { key: 'h', label: 'H', type: 'tel' },
      ],
    },
    { type: 'buttons', items: [{ label: '実行', action: 's', style: 'primary' }] },
  ],
};

describe('pageDefinitionSchema: 正常系', () => {
  it('設計書 §9 のサンプル（登録 body ごと）が通る', () => {
    expect(pageUpsertSchema.safeParse(clone(SAMPLE_UPSERT)).success).toBe(true);
  });

  it('7 種のブロックとすべての項目の型が通る', () => {
    const r = pageDefinitionSchema.safeParse(clone(ALL_BLOCKS));
    expect(r.error?.issues).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it('`<script>` を含む文字はただの文字として残る（HTML として解釈しない）', () => {
    const r = defWith((d) => {
      d.blocks.unshift({ type: 'heading', text: '<script>alert(1)</script>' });
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.blocks[0]).toEqual({ type: 'heading', text: '<script>alert(1)</script>' });
  });
});

describe('pageDefinitionSchema: 拒否', () => {
  it.each([
    ['未知の type', (d: any) => d.blocks.push({ type: 'html', html: '<b>x</b>' })],
    ['iframe ブロック', (d: any) => d.blocks.push({ type: 'iframe', src: 'https://example.com' })],
    ['ブロックの未知キー（html）', (d: any) => (d.blocks[0].html = '<b>x</b>')],
    ['ブロックの未知キー（style）', (d: any) => (d.blocks[1].style = 'color:red')],
    ['ブロックの未知キー（className）', (d: any) => (d.blocks[1].className = 'x')],
    ['列の未知キー（href）', (d: any) => (d.blocks[1].columns[0].href = 'https://x')],
    ['定義の未知キー', (d: any) => (d.staticData = { open: 1 })],
    ['アクションの未知キー（url）', (d: any) => (d.actions.list.url = 'https://evil.example')],
    ['未知の項目 type（file）', (d: any) => d.blocks[2].fields.push({ key: 'f', label: 'F', type: 'file' })],
    ['未知の項目 type（password）', (d: any) => d.blocks[2].fields.push({ key: 'p', label: 'P', type: 'password' })],
    ['未知の項目 type（hidden）', (d: any) => d.blocks[2].fields.push({ key: 'h', label: 'H', type: 'hidden' })],
    ['未知の項目 type（url）', (d: any) => d.blocks[2].fields.push({ key: 'u', label: 'U', type: 'url' })],
    ['ブロック 0 個', (d: any) => (d.blocks = [])],
    ['ブロック 21 個', (d: any) => (d.blocks = Array.from({ length: 21 }, () => ({ type: 'heading', text: 'x' })))],
    [
      'アクション 13 個',
      (d: any) => {
        for (let i = 0; i < 13; i++) d.actions[`a${i}`] = { kind: 'query', hook: `h${i}` };
      },
    ],
    ['見出し 41 文字', (d: any) => d.blocks.push({ type: 'heading', text: 'あ'.repeat(41) })],
    ['本文 501 文字', (d: any) => d.blocks.push({ type: 'text', text: 'あ'.repeat(501) })],
    ['ラベル 9 文字（一語）', (d: any) => (d.blocks[1].columns[0].label = 'あ'.repeat(9))],
    ['ボタン 7 文字', (d: any) => (d.blocks[3].items[0].label = 'あ'.repeat(7))],
    ['KPI 5 項目', (d: any) => (d.blocks[0].items = Array.from({ length: 5 }, () => d.blocks[0].items[0]))],
    ['列 9 個', (d: any) => (d.blocks[1].columns = Array.from({ length: 9 }, (_, i) => ({ key: `c${i}`, label: 'x' })))],
    ['項目 13 個', (d: any) => (d.blocks[2].fields = Array.from({ length: 13 }, (_, i) => ({ key: `f${i}`, label: 'x', type: 'text' })))],
    ['ボタン 4 個', (d: any) => (d.blocks[3].items = Array.from({ length: 4 }, () => ({ label: 'x', action: 'remind' })))],
    ['表が submit を参照（種類違い）', (d: any) => (d.blocks[1].source.action = 'create')],
    ['ボタンが query を参照（種類違い）', (d: any) => (d.blocks[3].items[0].action = 'list')],
    ['フォームが query を参照', (d: any) => (d.blocks[2].action = 'list')],
    ['KPI の参照切れ', (d: any) => (d.blocks[0].items[0].source.action = 'nothing')],
    ['refresh が submit を参照', (d: any) => (d.actions.create.refresh = ['done'])],
    ['rowAction があるのに rowKey が無い', (d: any) => delete d.blocks[1].rowKey],
    ['フォームの key が重複', (d: any) => d.blocks[2].fields.push({ key: 'name', label: '名', type: 'text' })],
    ['primary のボタンが 2 つ', (d: any) => d.blocks.push({ type: 'buttons', items: [{ label: 'a', action: 'remind', style: 'primary' }, { label: 'b', action: 'remind', style: 'primary' }] })],
    ['制御文字（NUL）', (d: any) => d.blocks.push({ type: 'heading', text: 'a\u0000b' })],
    ['制御文字（見出しの改行）', (d: any) => d.blocks.push({ type: 'heading', text: 'a\nb' })],
    ['select に options が無い', (d: any) => d.blocks[2].fields.push({ key: 's', label: 'S', type: 'select' })],
    ['text に options', (d: any) => (d.blocks[2].fields[0].options = [{ value: 'a', label: 'A' }])],
    ['text に min', (d: any) => (d.blocks[2].fields[0].min = 1)],
    ['text の maxLength 501', (d: any) => (d.blocks[2].fields[0].maxLength = 501)],
    ['textarea の maxLength 2001', (d: any) => (d.blocks[2].fields[3].maxLength = 2001)],
    ['データ key に記号', (d: any) => (d.blocks[1].columns[0].key = 'a.b')],
    ['アクション ID が大文字', (d: any) => (d.actions.List = { kind: 'query', hook: 'x' })],
    ['アクション ID が __proto__', (d: any) => Object.defineProperty(d.actions, '__proto__', { value: { kind: 'query', hook: 'x' }, enumerable: true })],
  ])('%s', (_name, mutate) => {
    expect(defWith(mutate).success).toBe(false);
  });

  it('定義全体が 32KB を超えると拒否（個々の上限内でも）', () => {
    const texts = (n: number) => Array.from({ length: n }, () => ({ type: 'text', text: 'あ'.repeat(500) }));
    // 20 × 500 文字 × 3 バイト ≒ 30KB は通る
    expect(defWith((d) => (d.blocks = texts(20))).success).toBe(true);
    // 本文 19 個 ＋ 選択肢の多いフォーム 1 個で 32KB を超える
    const options = Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, label: 'あ'.repeat(24) }));
    const r = defWith((d) => {
      d.blocks = [
        ...texts(19),
        {
          type: 'form',
          action: 'create',
          submit: '登録',
          fields: Array.from({ length: 12 }, (_, i) => ({ key: `f${i}`, label: 'x', type: 'select', options })),
        },
      ];
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('32KB');
  });
});

describe('hook / slug（T2: パスを書けない）', () => {
  it.each(['inquiries-list', 'a', 'abc-123', 'x'.repeat(40)])('通る: %s', (v) => {
    expect(pageHookSchema.safeParse(v).success).toBe(true);
    expect(pageSlugSchema.safeParse(v).success).toBe(true);
  });

  it.each([
    'a/b',
    '../x',
    '..',
    'a.b',
    '%2f',
    'a%2fb',
    'http://evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    '/webhook/agent-1',
    'pages/other-org/hook',
    'A',
    '-a',
    'a-',
    'a b',
    '',
    'x'.repeat(41),
    'a\u0000',
  ])('拒否: %j', (v) => {
    expect(pageHookSchema.safeParse(v).success).toBe(false);
    expect(pageSlugSchema.safeParse(v).success).toBe(false);
  });

  it('定義の中の hook に URL・パスを書くと定義ごと拒否', () => {
    for (const hook of ['https://evil.example/x', 'other/x', '..%2fdept-sales']) {
      expect(defWith((d) => (d.actions.list.hook = hook)).success).toBe(false);
    }
  });
});

describe('pageUpsertSchema', () => {
  it.each([
    ['sampleData', { sampleData: { list: { open: 999 } } }],
    ['source', { source: 'SEED' }],
    ['orgId', { orgId: 'other-org' }],
  ])('%s は受け付けない（seed だけが書ける・組織はトークンが決める）', (_k, extra) => {
    expect(pageUpsertSchema.safeParse({ ...clone(SAMPLE_UPSERT), ...extra }).success).toBe(false);
  });

  it('許可リスト外のアイコン・状態・役割を拒否', () => {
    expect(pageUpsertSchema.safeParse({ ...clone(SAMPLE_UPSERT), icon: 'skull' }).success).toBe(false);
    expect(pageUpsertSchema.safeParse({ ...clone(SAMPLE_UPSERT), status: 'ARCHIVED' }).success).toBe(false);
    expect(pageUpsertSchema.safeParse({ ...clone(SAMPLE_UPSERT), minRole: 'GUEST' }).success).toBe(false);
  });

  it('タイトルは 1〜24 文字', () => {
    expect(pageUpsertSchema.safeParse({ ...clone(SAMPLE_UPSERT), title: '' }).success).toBe(false);
    expect(pageUpsertSchema.safeParse({ ...clone(SAMPLE_UPSERT), title: 'あ'.repeat(25) }).success).toBe(false);
    expect(pageUpsertSchema.safeParse({ ...clone(SAMPLE_UPSERT), title: 'あ'.repeat(24) }).success).toBe(true);
  });

  it('アイコンの許可リストは 24 個', () => {
    expect(PAGE_ICONS).toHaveLength(24);
    expect(new Set(PAGE_ICONS).size).toBe(24);
  });
});

describe('toPublicPageDefinition（T17: hook を返さない）', () => {
  it('hook が出ない。kind / confirm / refresh だけ', () => {
    const pub = toPublicPageDefinition(sampleDefinition());
    expect(JSON.stringify(pub)).not.toContain('inquiries-list');
    expect(JSON.stringify(pub)).not.toContain('hook');
    expect(pub.actions.list).toEqual({ kind: 'query' });
    expect(pub.actions.done).toEqual({ kind: 'submit', confirm: '対応済みにしますか' });
    expect(pub.blocks).toHaveLength(4);
  });
});

describe('buildInputSchema', () => {
  const def = sampleDefinition();
  const FORM = { blockIndex: 2 };

  it('フォーム: 必須・型・余分なキー', () => {
    const s = buildInputSchema(def, 'create', FORM)!;
    expect(s).not.toBeNull();
    expect(s.safeParse({ name: '山田', subject: '見積' }).success).toBe(true);
    expect(s.safeParse({ name: '山田', subject: '見積', tel: '03-1234-5678', body: '1行目\n2行目' }).success).toBe(true);
    expect(s.safeParse({ name: '', subject: '見積' }).success).toBe(false); // 必須
    expect(s.safeParse({ name: '   ', subject: '見積' }).success).toBe(false); // 空白だけ
    expect(s.safeParse({ subject: '見積' }).success).toBe(false); // 必須が無い
    expect(s.safeParse({ name: 1, subject: '見積' }).success).toBe(false); // 型違い
    expect(s.safeParse({ name: '山田', subject: '見積', extra: 'x' }).success).toBe(false); // 定義に無い項目
    expect(s.safeParse({ name: '山田', subject: '見積', tel: '<script>' }).success).toBe(false); // 電話の形
    expect(s.safeParse({ name: 'a\nb', subject: '見積' }).success).toBe(false); // text に改行
    expect(s.safeParse({ name: 'あ'.repeat(201), subject: '見積' }).success).toBe(false); // 既定 200
  });

  it('全種類の項目', () => {
    const d = pageDefinitionSchema.parse(clone(ALL_BLOCKS));
    const s = buildInputSchema(d, 's', { blockIndex: 5 })!;
    const ok = { a: 'x', b: 'y', c: 5, d: '2026-11-18', e: 'x', f: true, g: 'a@example.com', h: '+81 90-0000-0000' };
    expect(s.safeParse(ok).success).toBe(true);
    expect(s.safeParse({}).success).toBe(true); // すべて任意
    expect(s.safeParse({ c: null, d: '', e: '', g: '', h: '' }).success).toBe(true); // 空は任意なら通す
    expect(s.safeParse({ c: 11 }).success).toBe(false); // max
    expect(s.safeParse({ c: -1 }).success).toBe(false); // min
    expect(s.safeParse({ c: '5' }).success).toBe(false); // 文字列の数値は受けない
    expect(s.safeParse({ c: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(s.safeParse({ d: '2026-02-30' }).success).toBe(false); // 存在しない日付
    expect(s.safeParse({ d: '2026/11/18' }).success).toBe(false);
    expect(s.safeParse({ e: 'y' }).success).toBe(false); // 選択肢に無い
    expect(s.safeParse({ f: 'true' }).success).toBe(false);
    expect(s.safeParse({ g: 'not-an-email' }).success).toBe(false);
    expect(s.safeParse({ a: 'x'.repeat(51) }).success).toBe(false); // maxLength 50
    expect(s.safeParse({ b: 'x'.repeat(2000) }).success).toBe(true);
    expect(s.safeParse({ b: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('必須の select・checkbox', () => {
    const d = pageDefinitionSchema.parse({
      actions: { s: { kind: 'submit', hook: 's' } },
      blocks: [
        {
          type: 'form',
          action: 's',
          submit: '送信',
          fields: [
            { key: 'e', label: 'E', type: 'select', required: true, options: [{ value: 'x', label: 'X' }] },
            { key: 'f', label: 'F', type: 'checkbox', required: true },
          ],
        },
      ],
    });
    const s = buildInputSchema(d, 's', { blockIndex: 0 })!;
    expect(s.safeParse({ e: 'x', f: true }).success).toBe(true);
    expect(s.safeParse({ e: '', f: true }).success).toBe(false);
    expect(s.safeParse({ e: 'x', f: false }).success).toBe(false);
  });

  it('ボタン: 空オブジェクトだけ', () => {
    const s = buildInputSchema(def, 'remind', { blockIndex: 3 })!;
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse({ x: 1 }).success).toBe(false);
    expect(buildInputSchema(def, 'remind', { blockIndex: 3, itemIndex: 0 })).not.toBeNull();
    expect(buildInputSchema(def, 'remind', { blockIndex: 3, itemIndex: 1 })).toBeNull();
  });

  it('rowAction: { rowId } だけ（128 文字まで）', () => {
    const s = buildInputSchema(def, 'done', { blockIndex: 1 })!;
    expect(s.safeParse({ rowId: 'r1' }).success).toBe(true);
    expect(s.safeParse({ rowId: '' }).success).toBe(false);
    expect(s.safeParse({ rowId: 'x'.repeat(129) }).success).toBe(false);
    expect(s.safeParse({ rowId: 'r1', name: 'x' }).success).toBe(false);
    expect(s.safeParse({ rowId: 1 }).success).toBe(false);
  });

  it('origin のブロックがその action を指していない・query・存在しない action は null', () => {
    expect(buildInputSchema(def, 'create', { blockIndex: 3 })).toBeNull(); // ボタンのブロックからフォームの action
    expect(buildInputSchema(def, 'done', { blockIndex: 2 })).toBeNull();
    expect(buildInputSchema(def, 'list', { blockIndex: 1 })).toBeNull(); // query
    expect(buildInputSchema(def, 'nothing', { blockIndex: 2 })).toBeNull();
    expect(buildInputSchema(def, 'constructor', { blockIndex: 2 })).toBeNull(); // プロトタイプのキー
    expect(buildInputSchema(def, 'create', { blockIndex: 99 })).toBeNull();
    expect(buildInputSchema(def, 'create', { blockIndex: -1 })).toBeNull();
    expect(buildInputSchema(def, 'create', { blockIndex: 1.5 })).toBeNull();
    expect(buildInputSchema(def, 'create', { blockIndex: 0 })).toBeNull(); // KPI
  });
});

describe('projectQueryResult（K12: 宣言した形だけを返す）', () => {
  const def = sampleDefinition();

  it('宣言した key と列だけを返し、未知のキーとネストを落とす', () => {
    const r = projectQueryResult(def, 'list', {
      open: 3,
      month: 12,
      secret: 'x',
      rows: [
        { id: 'r1', date: '2026-11-01', name: '山田', subject: '見積', status: '未対応', email: 'a@example.com' },
        { id: 2, name: { first: 'x' }, subject: ['a'], status: true },
      ],
    });
    expect(r.action).toBe('list');
    expect(r.blocks).toEqual([
      { index: 0, type: 'kpi', values: { 0: 3, 1: 12 } },
      {
        index: 1,
        type: 'table',
        truncated: false,
        rows: [
          { id: 'r1', cells: { date: '2026-11-01', name: '山田', subject: '見積', status: '未対応' } },
          { id: '2', cells: { date: null, name: null, subject: null, status: true } },
        ],
      },
    ]);
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(JSON.stringify(r)).not.toContain('a@example.com');
  });

  it('`<script>` はただの文字列のまま残る（描画側がテキストノードで出す）', () => {
    const r = projectQueryResult(def, 'list', { open: '<script>x</script>', month: 0, rows: [{ id: 'a', name: '<img src=x onerror=alert(1)>' }] });
    expect(r.blocks[0]).toEqual({ index: 0, type: 'kpi', values: { 0: '<script>x</script>', 1: 0 } });
    const table = r.blocks[1] as { rows: { cells: Record<string, unknown> }[] };
    expect(table.rows[0].cells.name).toBe('<img src=x onerror=alert(1)>');
  });

  it('文字列はセル 200 文字・KPI 32 文字で切り、行数は上限で切って truncated', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: `r${i}`, name: 'あ'.repeat(300) }));
    const r = projectQueryResult(def, 'list', { open: 'x'.repeat(40), month: 1, rows });
    expect((r.blocks[0] as { values: Record<number, unknown> }).values[0]).toBe('x'.repeat(32));
    const table = r.blocks[1] as { rows: { cells: Record<string, string> }[]; truncated: boolean };
    expect(table.rows).toHaveLength(200);
    expect(table.truncated).toBe(true);
    expect(table.rows[0].cells.name).toHaveLength(200);
  });

  it('list は 100 行まで・titleKey / subKey / metaKey だけ', () => {
    const d = pageDefinitionSchema.parse(clone(ALL_BLOCKS));
    const items = Array.from({ length: 101 }, (_, i) => ({ t: `t${i}`, s: 's', m: 'm', x: 'drop' }));
    const r = projectQueryResult(d, 'q', { count: 1, rows: [], items });
    const list = r.blocks.find((b) => b.type === 'list') as { rows: { id: unknown; cells: object }[]; truncated: boolean };
    expect(list.rows).toHaveLength(100);
    expect(list.truncated).toBe(true);
    expect(list.rows[0]).toEqual({ id: null, cells: { t: 't0', s: 's', m: 'm' } });
  });

  it('制御文字は空白に置き換える', () => {
    const r = projectQueryResult(def, 'list', { open: 1, month: 1, rows: [{ id: 'a', name: 'a\u0000b\nc' }] });
    expect((r.blocks[1] as { rows: { cells: Record<string, unknown> }[] }).rows[0].cells.name).toBe('a b c');
  });

  it('必須の key が無い・型が違うブロックだけ error（他のブロックは出す）', () => {
    const r = projectQueryResult(def, 'list', { open: 3, month: 1, rows: 'not-an-array' });
    expect(r.blocks[0]).toEqual({ index: 0, type: 'kpi', values: { 0: 3, 1: 1 } });
    expect(r.blocks[1]).toEqual({ index: 1, type: 'table', error: 'INVALID_RESPONSE' });

    const r2 = projectQueryResult(def, 'list', { open: 3, rows: [] }); // month が無い
    expect(r2.blocks[0]).toEqual({ index: 0, type: 'kpi', error: 'INVALID_RESPONSE' });
    expect(r2.blocks[1]).toMatchObject({ index: 1, type: 'table', rows: [] });

    const r3 = projectQueryResult(def, 'list', { open: { nested: 1 }, month: true, rows: [] });
    expect(r3.blocks[0]).toEqual({ index: 0, type: 'kpi', error: 'INVALID_RESPONSE' });
  });

  it('応答がオブジェクトでなければ参照するブロックはすべて error', () => {
    for (const raw of [null, 'text', 42, [], undefined]) {
      const r = projectQueryResult(def, 'list', raw);
      expect(r.blocks.map((b) => 'error' in b)).toEqual([true, true]);
    }
  });

  it('その action を参照しないブロックは返さない・プロトタイプの key を拾わない', () => {
    expect(projectQueryResult(def, 'create', { open: 1 }).blocks).toEqual([]);
    const d = pageDefinitionSchema.parse({
      actions: { q: { kind: 'query', hook: 'q' } },
      blocks: [{ type: 'kpi', items: [{ label: 'x', source: { action: 'q', key: 'toString' } }] }],
    });
    expect(projectQueryResult(d, 'q', {}).blocks[0]).toEqual({ index: 0, type: 'kpi', error: 'INVALID_RESPONSE' });
  });

  it('rowKey の値が無い・長すぎる行は id が null（行の操作を出さない）', () => {
    const r = projectQueryResult(def, 'list', { open: 1, month: 1, rows: [{ name: 'a' }, { id: 'x'.repeat(129) }, { id: 'ok' }] });
    expect((r.blocks[1] as { rows: { id: unknown }[] }).rows.map((x) => x.id)).toEqual([null, null, 'ok']);
  });

  it('非有限の数はセルで null、KPI では error', () => {
    const r = projectQueryResult(def, 'list', { open: Number.NaN, month: 1, rows: [{ id: 'a', name: Number.POSITIVE_INFINITY }] });
    expect(r.blocks[0]).toMatchObject({ error: 'INVALID_RESPONSE' });
    expect((r.blocks[1] as { rows: { cells: Record<string, unknown> }[] }).rows[0].cells.name).toBeNull();
  });
});

describe('pageSubmitResponseSchema', () => {
  it('{ ok, message } だけを受け取り、他は捨てる。message は 140 文字で切る', () => {
    const r = pageSubmitResponseSchema.parse({ ok: true, message: 'あ'.repeat(200), html: '<b>x</b>', redirect: 'https://x' });
    expect(r).toEqual({ ok: true, message: 'あ'.repeat(140) });
    expect(pageSubmitResponseSchema.safeParse({ ok: 'yes' }).success).toBe(false);
    expect(pageSubmitResponseSchema.safeParse({ message: 'x' }).success).toBe(false);
  });
});

describe('プラン上限（設計書 §6）', () => {
  it('ページ数と月間実行数', () => {
    expect(PAGE_LIMITS).toEqual({
      STARTER: { maxPages: 1, actionsPerMonth: 300 },
      PRO: { maxPages: 5, actionsPerMonth: 3000 },
      MAX: { maxPages: 20, actionsPerMonth: 20000 },
    });
  });

  it('canAddPage: 上限未満なら作れる。知らないプランは梅で数える', () => {
    expect(canAddPage('STARTER', 0)).toBe(true);
    expect(canAddPage('STARTER', 1)).toBe(false);
    expect(canAddPage('PRO', 4)).toBe(true);
    expect(canAddPage('PRO', 5)).toBe(false);
    expect(canAddPage('MAX', 19)).toBe(true);
    expect(canAddPage('MAX', 25)).toBe(false); // 降格などで超えている
    expect(canAddPage('ENTERPRISE', 1)).toBe(false);
    expect(canAddPage('ENTERPRISE', 0)).toBe(true);
  });

  it('pageActionState: 8 割で warn、上限で over かつ blocked', () => {
    expect(pageActionState('STARTER', 0)).toEqual({ used: 0, limit: 300, state: 'ok', blocked: false });
    expect(pageActionState('STARTER', 239)).toMatchObject({ state: 'ok', blocked: false });
    expect(pageActionState('STARTER', 240)).toMatchObject({ state: 'warn', blocked: false });
    expect(pageActionState('STARTER', 299)).toMatchObject({ state: 'warn', blocked: false });
    expect(pageActionState('STARTER', 300)).toMatchObject({ state: 'over', blocked: true });
    expect(pageActionState('PRO', 3000)).toMatchObject({ limit: 3000, blocked: true });
    expect(pageActionState('MAX', 19999)).toMatchObject({ limit: 20000, blocked: false });
    expect(pageActionState('UNKNOWN', 300)).toMatchObject({ limit: 300, blocked: true });
    expect(pageActionState('PRO', -5)).toMatchObject({ used: 0, state: 'ok' });
  });
});

describe('utf8ByteLength', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['é', 2],
    ['あ', 3],
    ['𠀋', 4],
  ])('%j → %d', (s, n) => {
    expect(utf8ByteLength(s)).toBe(n);
  });
});

describe('業務フローの結果ページのアクション（canvas-home.md §6.3）', () => {
  const flowPage = (): any => ({
    actions: { latest: { kind: 'flow_query' }, run: { kind: 'flow_submit' } },
    blocks: [
      { type: 'kpi', items: [{ label: '今月', source: { action: 'latest', key: 'total' } }] },
      { type: 'table', source: { action: 'latest', key: 'runs' }, columns: [{ key: 'date', label: '日付' }] },
      { type: 'form', fields: [{ key: 'customer', label: '顧客名', type: 'text', required: true }], action: 'run', submit: '作成' },
      { type: 'buttons', items: [{ label: '実行', action: 'run' }] },
    ],
  });

  it('保存済みの定義を読む側（pageDefinitionSchema）は flow_query / flow_submit を通す', () => {
    expect(pageDefinitionSchema.safeParse(flowPage()).success).toBe(true);
  });

  it('n8n・手動の登録（pageUpsertSchema）は flow_* を拒否する', () => {
    const r = pageUpsertSchema.safeParse({ title: '提案書', definition: flowPage() });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('業務フローの結果ページだけ');
    const one: any = { ...SAMPLE_UPSERT, definition: { ...SAMPLE_UPSERT.definition, actions: { ...SAMPLE_UPSERT.definition.actions, x: { kind: 'flow_query' } } } };
    expect(pageUpsertSchema.safeParse(one).success).toBe(false);
  });

  it('flow_* にフロー ID・hook などを書けない（.strict()）', () => {
    for (const extra of [{ flowId: 'other' }, { hook: 'x' }, { url: 'http://a' }]) {
      const def = flowPage();
      def.actions.run = { kind: 'flow_submit', ...extra };
      expect(pageDefinitionSchema.safeParse(def).success).toBe(false);
    }
  });

  it('n8n のアクションと混ぜない・各 1 つまで・行の操作には使えない', () => {
    const mixed = flowPage();
    mixed.actions.list = { kind: 'query', hook: 'x' };
    expect(pageDefinitionSchema.safeParse(mixed).success).toBe(false);
    const two = flowPage();
    two.actions.again = { kind: 'flow_submit' };
    expect(pageDefinitionSchema.safeParse(two).success).toBe(false);
    const row = flowPage();
    row.blocks[1].rowKey = 'id';
    row.blocks[1].rowAction = { label: '開く', action: 'run' };
    expect(pageDefinitionSchema.safeParse(row).success).toBe(false);
    // 読む側を指すべき所に flow_submit、送る側に flow_query は落ちる
    const swapped = flowPage();
    swapped.blocks[0].items[0].source.action = 'run';
    expect(pageDefinitionSchema.safeParse(swapped).success).toBe(false);
    swapped.blocks[0].items[0].source.action = 'latest';
    swapped.blocks[2].action = 'latest';
    expect(pageDefinitionSchema.safeParse(swapped).success).toBe(false);
  });

  it('利用者に返す定義は kind だけ', () => {
    const def = pageDefinitionSchema.parse(flowPage()) as PageDefinition;
    expect(toPublicPageDefinition(def).actions).toEqual({ latest: { kind: 'flow_query' }, run: { kind: 'flow_submit' } });
  });

  it('flow_submit のフォーム・ボタンの入力スキーマを作れる（行の操作は作らない）', () => {
    const def = pageDefinitionSchema.parse(flowPage()) as PageDefinition;
    const form = buildInputSchema(def, 'run', { blockIndex: 2 });
    expect(form?.safeParse({ customer: 'A 社' }).success).toBe(true);
    expect(form?.safeParse({ customer: 'A 社', extra: 1 }).success).toBe(false);
    expect(buildInputSchema(def, 'run', { blockIndex: 3, itemIndex: 0 })?.safeParse({}).success).toBe(true);
    expect(buildInputSchema(def, 'latest', { blockIndex: 0 })).toBeNull();
    const pub: any = { blocks: [{ ...flowPage().blocks[1], rowKey: 'id', rowAction: { label: '開く', action: 'run' } }], actions: { run: { kind: 'flow_submit' } } };
    expect(buildInputSchema(pub, 'run', { blockIndex: 0 })).toBeNull();
  });

  it('flow_query の結果も projectQueryResult で宣言したキーだけに切り詰める', () => {
    const def = pageDefinitionSchema.parse(flowPage()) as PageDefinition;
    const out = projectQueryResult(def, 'latest', { total: 3, runs: [{ date: '2026-11-18', secret: 'x' }], other: 1 });
    expect(out.blocks).toEqual([
      { index: 0, type: 'kpi', values: { 0: 3 } },
      { index: 1, type: 'table', rows: [{ id: null, cells: { date: '2026-11-18' } }], truncated: false },
    ]);
  });
});
