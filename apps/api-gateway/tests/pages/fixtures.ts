// 業務ページのルートテストの共通部品。定義は設計書 §9 のサンプル（問い合わせ）と同じ形。

export const SAMPLE_DEFINITION = {
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
};

export const sampleUpsert = (over: Record<string, unknown> = {}) => ({
  title: '問い合わせ',
  icon: 'inbox',
  definition: JSON.parse(JSON.stringify(SAMPLE_DEFINITION)),
  ...over,
});

/** 見出しだけの小さい定義（一覧・権限のテスト用） */
export const HEADING_DEFINITION = { blocks: [{ type: 'heading', text: '見出し' }], actions: {} };

const now = new Date('2026-11-01T00:00:00Z');

export function pageRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    title: 'ページ', icon: 'file-text', sortOrder: 0, status: 'PUBLISHED', minRole: 'MEMBER', source: 'N8N',
    version: 1, schemaVersion: 1, definition: SAMPLE_DEFINITION, definitionHash: 'h', sampleData: null,
    adminEditedFields: [], createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
    ...over,
  };
}

export function orgRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, name: id, plan: 'PRO', billingEmail: null, subscriptionStatus: null, trialEndsAt: null,
    storageUsedBytes: BigInt(0), storageAddonUnits: 0, createdAt: now,
    ...over,
  };
}

export function userAndMembership(userId: string, orgId: string, role: string) {
  return {
    user: { id: userId, email: `${userId}@example.com`, name: userId, status: 'ACTIVE', role, orgId, createdAt: now },
    membership: { id: `m-${userId}-${orgId}`, userId, orgId, role, status: 'ACTIVE', createdAt: now },
  };
}
