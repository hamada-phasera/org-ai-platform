/* eslint-disable @typescript-eslint/no-explicit-any -- 不正な入力をわざと組み立てるテスト */
import { describe, it, expect } from 'vitest';
import {
  APPROVAL_REQUIRED_CAPS,
  DEFAULT_CANVAS_LAYOUT,
  FLOW_DEFINITION_LIMITS,
  FLOW_PARTS,
  FLOW_PART_KEY_PATTERN,
  FLOW_RUN_LIMITS,
  FLOW_TAX_NOTICE,
  FLOW_TEMPLATES,
  FLOW_TEMPLATE_KEYS,
  PAGE_ICONS,
  buildPartInputSchema,
  canvasLayoutSchema,
  cloneFlowTemplate,
  defaultCanvasLayout,
  findFlowPart,
  flowDefinitionSchema,
  isExternalSendNode,
  isFlowKey,
  pageFieldSchema,
  topoOrder,
} from '../index';

const issuesOf = (r: { success: boolean; error?: any }) =>
  r.success ? [] : (r.error.issues as any[]).map((i) => `${i.path.join('.')}: ${i.message}`);

describe('FLOW_TEMPLATES（§5.6）', () => {
  it('テンプレートのキーは FLOW_TEMPLATE_KEYS とちょうど同じ', () => {
    expect(Object.keys(FLOW_TEMPLATES).sort()).toEqual([...FLOW_TEMPLATE_KEYS].sort());
    for (const [key, t] of Object.entries(FLOW_TEMPLATES)) expect(t.key).toBe(key);
  });

  it.each(FLOW_TEMPLATE_KEYS)('%s は flowDefinitionSchema（本物の部品カタログ）を通る', (key) => {
    const r = flowDefinitionSchema.safeParse(FLOW_TEMPLATES[key].definition);
    expect(issuesOf(r)).toEqual([]);
  });

  it.each(FLOW_TEMPLATE_KEYS)('%s: 名前・アイコン・版・位置が揃っている', (key) => {
    const t = FLOW_TEMPLATES[key];
    expect(t.name.length).toBeGreaterThanOrEqual(1);
    expect(t.name.length).toBeLessThanOrEqual(FLOW_DEFINITION_LIMITS.nameMax);
    expect(PAGE_ICONS).toContain(t.icon);
    expect(Number.isInteger(t.version) && t.version >= 1).toBe(true);
    // 位置は全ノードぶん・余分なし・整数
    expect(Object.keys(t.layout).sort()).toEqual(t.definition.nodes.map((n) => n.id).sort());
    for (const p of Object.values(t.layout)) {
      expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
    }
    expect(topoOrder(t.definition)).not.toBeNull();
  });

  it('テンプレートに外へ送るノードは無い（下書きまで。SNS も実投稿しない）', () => {
    for (const t of Object.values(FLOW_TEMPLATES)) {
      expect(t.definition.nodes.filter((n) => isExternalSendNode(n, FLOW_PARTS))).toEqual([]);
    }
  });

  it('見積・請求の文書には「税務判断はしない」の注記が入る（U-10）', () => {
    for (const key of ['estimate', 'invoice'] as const) {
      const doc = FLOW_TEMPLATES[key].definition.nodes.find((n) => n.type === 'output');
      expect(doc?.type === 'output' && doc.config.kind === 'document' && doc.config.body.includes(FLOW_TAX_NOTICE)).toBe(true);
    }
    expect(FLOW_TAX_NOTICE).toContain('税務判断をしません');
  });

  it('提案書の入力項目は routes/sales/proposals.ts と同じ（顧客名・背景・要件・予算）', () => {
    const trigger = FLOW_TEMPLATES.proposal.definition.nodes[0];
    expect(trigger.type).toBe('trigger');
    const keys = trigger.type === 'trigger' && trigger.config.mode === 'form' ? trigger.config.fields.map((f) => f.key) : [];
    expect(keys).toEqual(['customerName', 'background', 'requirements', 'budget']);
  });

  it('複製は深いコピーで、毎回同じ結果（LLM・乱数を使わない。K4）', () => {
    const a = cloneFlowTemplate('proposal');
    const b = cloneFlowTemplate('proposal');
    expect(a).toEqual(b);
    expect(a).toEqual(FLOW_TEMPLATES.proposal);
    (a.definition.nodes[0] as any).label = '改変';
    a.layout.form.x = 999;
    expect(FLOW_TEMPLATES.proposal.definition.nodes[0].label).toBe('フォーム');
    expect(FLOW_TEMPLATES.proposal.layout.form.x).toBe(0);
  });
});

describe('DEFAULT_CANVAS_LAYOUT（§5.6）', () => {
  it('canvasLayoutSchema を通り、丸めても変わらない', () => {
    const r = canvasLayoutSchema.safeParse(DEFAULT_CANVAS_LAYOUT);
    expect(issuesOf(r)).toEqual([]);
    expect(r.success && r.data).toEqual(DEFAULT_CANVAS_LAYOUT);
  });

  it('テンプレートのノードは全テンプレートを指し、ラベルは一語', () => {
    const templates = DEFAULT_CANVAS_LAYOUT.nodes.flatMap((n) => (n.target.kind === 'template' ? [n.target.templateKey] : []));
    expect(templates.sort()).toEqual([...FLOW_TEMPLATE_KEYS].sort());
    expect(DEFAULT_CANVAS_LAYOUT.nodes.every((n) => n.target.kind !== 'flow')).toBe(true);
  });

  it('既定のノードと線（問い合わせ → 提案書 → 見積 → 請求、提案書 → 承認）', () => {
    expect(DEFAULT_CANVAS_LAYOUT.nodes.map((n) => n.label)).toEqual([
      '問い合わせ',
      '提案書',
      '見積',
      '請求',
      '承認',
      '原価',
      'SNS',
      '数字',
    ]);
    const label = (id: string) => DEFAULT_CANVAS_LAYOUT.nodes.find((n) => n.id === id)?.label;
    expect(DEFAULT_CANVAS_LAYOUT.edges.map((e) => `${label(e.from)}→${label(e.to)}`)).toEqual([
      '問い合わせ→提案書',
      '提案書→見積',
      '見積→請求',
      '提案書→承認',
    ]);
    const approvals = DEFAULT_CANVAS_LAYOUT.nodes.find((n) => n.id === 'approvals');
    expect(approvals?.target).toEqual({ kind: 'link', to: '/inbox?tab=approvals' });
  });

  it('defaultCanvasLayout() は深いコピー', () => {
    const a = defaultCanvasLayout();
    a.nodes[0].label = 'x';
    expect(DEFAULT_CANVAS_LAYOUT.nodes[0].label).toBe('問い合わせ');
  });
});

describe('FLOW_PARTS（§5.7）', () => {
  it('キーは形どおりで重複しない。v1 の 5 つ', () => {
    const keys = FLOW_PARTS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(FLOW_PART_KEY_PATTERN);
    expect(keys).toEqual(['google_doc', 'google_sheet', 'slack_notify', 'email_send', 'pdf_make']);
  });

  it('カタログに URL・パスを書く欄が無い（K6・T6）', () => {
    for (const p of FLOW_PARTS) {
      expect(Object.keys(p.via).sort()).toEqual(p.via.kind === 'n8n' ? ['kind'] : ['kind', 'name']);
      expect(JSON.stringify(p)).not.toMatch(/https?:|\/\/|webhook/i);
    }
  });

  it('入力の項目は業務ページの Field、出力のキーは使える形。タイムアウトは 30 秒まで', () => {
    for (const p of FLOW_PARTS) {
      expect(p.title.length).toBeLessThanOrEqual(8);
      expect(PAGE_ICONS).toContain(p.icon);
      for (const f of p.input) expect(issuesOf(pageFieldSchema.safeParse(f)), `${p.key}.${f.key}`).toEqual([]);
      const inKeys = p.input.map((f) => f.key);
      expect(new Set(inKeys).size).toBe(inKeys.length);
      for (const o of p.output) expect(isFlowKey(o.key), `${p.key}.${o.key}`).toBe(true);
      if (p.timeoutMs !== undefined) expect(p.timeoutMs).toBeLessThanOrEqual(FLOW_RUN_LIMITS.partTimeoutMaxMs);
    }
  });

  it('APPROVAL_REQUIRED_CAPS に載る capability は external_send（§8.3）', () => {
    for (const p of FLOW_PARTS) {
      if (p.via.kind !== 'capability') continue;
      const needsApproval = (APPROVAL_REQUIRED_CAPS as readonly string[]).includes(p.via.name);
      expect(p.sideEffect === 'external_send', p.key).toBe(needsApproval);
    }
    // 送る部品は再試行しない（§7.3）
    for (const p of FLOW_PARTS.filter((x) => x.sideEffect === 'external_send')) expect(p.idempotent).toBe(false);
  });

  it('PDF は n8n 経由で竹以上（上位プランの理由）', () => {
    expect(findFlowPart('pdf_make')).toMatchObject({ via: { kind: 'n8n' }, minPlan: 'PRO' });
    expect(findFlowPart('nope')).toBeUndefined();
  });
});

describe('buildPartInputSchema（T8）', () => {
  const email = buildPartInputSchema(findFlowPart('email_send')!);

  it('部品の項目だけを通す（.strict()）', () => {
    expect(email.safeParse({ to: 'a@example.com', subject: '件名', body: '本文' }).success).toBe(true);
    expect(email.safeParse({ to: 'a@example.com', subject: '件名', body: '本文', bcc: 'x@example.com' }).success).toBe(false);
    expect(email.safeParse({ to: 'a@example.com', subject: '件名', body: '本文', url: 'http://evil' }).success).toBe(false);
  });

  it('必須・型・長さ', () => {
    expect(email.safeParse({ to: 'a@example.com', subject: '件名' }).success).toBe(false);
    expect(email.safeParse({ to: 'a@example.com', subject: '', body: 'x' }).success).toBe(false);
    expect(email.safeParse({ to: 'not-an-email', subject: 's', body: 'x' }).success).toBe(false);
    expect(email.safeParse({ to: 'a@example.com', subject: 's', body: 'x'.repeat(2001) }).success).toBe(false);
    // 任意の項目は空文字（展開して値が無かった）でも通る
    expect(email.safeParse({ to: 'a@example.com', subject: 's', body: 'x', cc: '' }).success).toBe(true);
  });

  it('number と checkbox は展開後の文字から直す', () => {
    const s = buildPartInputSchema({
      input: [
        { key: 'qty', label: '数量', type: 'number', required: true, min: 0 },
        { key: 'note', label: '注', type: 'number' },
        { key: 'ok', label: '可', type: 'checkbox' },
      ],
    });
    expect(s.parse({ qty: ' 12 ', note: '', ok: 'true' })).toEqual({ qty: 12, ok: true });
    expect(s.safeParse({ qty: 'abc' }).success).toBe(false);
    expect(s.safeParse({ qty: '-1' }).success).toBe(false);
    expect(s.safeParse({ qty: '' }).success).toBe(false);
    expect(s.safeParse({ qty: '1', ok: 'yes' }).success).toBe(false);
  });
});

describe('テンプレートの slug・空のフロー・フローの位置（チャンク 4）', () => {
  it('テンプレートの slug は slug の形で、キーの _ を - にしたもの', async () => {
    const { flowTemplateSlug, FLOW_TEMPLATE_SLUGS, FLOW_SLUG_PATTERN } = await import('../index');
    expect(flowTemplateSlug('sns_post')).toBe('sns-post');
    expect(flowTemplateSlug('proposal')).toBe('proposal');
    expect(FLOW_TEMPLATE_SLUGS).toHaveLength(FLOW_TEMPLATE_KEYS.length);
    for (const s of FLOW_TEMPLATE_SLUGS) expect(FLOW_SLUG_PATTERN.test(s)).toBe(true);
  });

  it('空のフローはスキーマを通り、外へ送るノードを持たない', async () => {
    const { emptyFlowDefinition } = await import('../index');
    const { definition, layout } = emptyFlowDefinition();
    expect(flowDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(definition.nodes.some((n) => isExternalSendNode(n as any, FLOW_PARTS))).toBe(false);
    expect(Object.keys(layout).sort()).toEqual(definition.nodes.map((n) => n.id).sort());
    // 毎回別のオブジェクト（書き換えても次に影響しない）
    expect(emptyFlowDefinition()).not.toBe(emptyFlowDefinition());
  });

  it('flowLayoutSchema は座標を丸め、未知キー・ノード ID でないキー・上限超えを拒否する', async () => {
    const { flowLayoutSchema } = await import('../index');
    expect(flowLayoutSchema.parse({ a: { x: 1.6, y: -99999 } })).toEqual({ a: { x: 2, y: -5000 } });
    expect(flowLayoutSchema.safeParse({ a: { x: 0, y: 0, z: 1 } }).success).toBe(false);
    expect(flowLayoutSchema.safeParse({ 'Bad-Id': { x: 0, y: 0 } }).success).toBe(false);
    expect(flowLayoutSchema.safeParse({ __proto__x: { x: 0, y: 0 } }).success).toBe(false);
    expect(flowLayoutSchema.safeParse({ a: { x: Number.NaN, y: 0 } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: FLOW_DEFINITION_LIMITS.maxNodes + 1 }, (_, i) => [`n${i}`, { x: 0, y: 0 }]));
    expect(flowLayoutSchema.safeParse(many).success).toBe(false);
  });
});
