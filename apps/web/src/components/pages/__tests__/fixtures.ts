import type { PageDetail } from '../pagesApi';

/** 設計書 §9 のサンプル（hook を落とした公開定義）に、text・list と未知の type を足したもの */
export function sampleDetail(over: Partial<PageDetail> = {}): PageDetail {
  return {
    slug: 'inquiries',
    title: '問い合わせ',
    icon: 'inbox',
    status: 'PUBLISHED',
    minRole: 'MEMBER',
    version: 1,
    updatedAt: '2026-11-18T00:00:00.000Z',
    connection: 'sample',
    usage: { used: 0, limit: 300, state: 'ok', blocked: false },
    definition: {
      actions: {
        list: { kind: 'query' },
        create: { kind: 'submit' },
        done: { kind: 'submit', confirm: '対応済みにしますか' },
        remind: { kind: 'submit', confirm: '担当へ通知しますか' },
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
        { type: 'text', text: '<script>alert(1)</script>\n2 行目' },
        { type: 'list', source: { action: 'list', key: 'rows' }, titleKey: 'name', subKey: 'subject', empty: '空です' },
        // 定義が新しく web が古いとき（知らない type）
        { type: 'chart', data: [1, 2] } as never,
      ],
    },
    ...over,
  };
}

/** gateway が projectQueryResult を通した後の形（§K23） */
export function sampleData(rows = defaultRows()) {
  return {
    action: 'list',
    sample: true,
    blocks: [
      { index: 0, type: 'kpi', values: { 0: 3, 1: 12 } },
      { index: 1, type: 'table', rows, truncated: false },
      { index: 5, type: 'list', rows, truncated: false },
    ],
  };
}

export function defaultRows() {
  return [
    {
      id: 'r1',
      cells: { date: '2026-11-17', name: '<script>alert("x")</script>', subject: '見積の依頼', status: '未対応' },
    },
    { id: 'r2', cells: { date: '2026-11-16', name: '佐藤', subject: '日程', status: '対応済み' } },
  ];
}
