/* eslint-disable @typescript-eslint/no-explicit-any -- 不正な定義をわざと組み立てるテスト（型で守れない入力を確かめる） */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_DEPARTMENTS,
  FLOW_DEPARTMENTS,
  buildFlowDefinitionSchema,
  canvasLayoutSchema,
  checkFlowDefinition,
  clipUtf8,
  flowDefinitionSchema,
  hasMalformedTemplate,
  isCanvasLinkPath,
  isExternalSendNode,
  outputKeysOf,
  parseTemplateRefs,
  renderTemplate,
  resolveRef,
  templateSlotsOf,
  topoOrder,
  upstreamOf,
  utf8ByteLength,
  type FlowDefinition,
  type FlowPartSpec,
} from '../index';

/** テスト用の部品カタログ（本物はチャンク 2 の flow-parts.ts） */
const PARTS: FlowPartSpec[] = [
  {
    key: 'google_doc',
    title: '文書',
    icon: 'file-text',
    via: { kind: 'capability', name: 'create_google_doc' },
    input: [
      { key: 'title', label: '題名', type: 'text', required: true },
      { key: 'body', label: '本文', type: 'textarea' },
    ],
    output: [
      { key: 'url', type: 'text' },
      { key: 'items', type: 'rows', columns: [{ key: 'name', type: 'text' }] },
    ],
    sideEffect: 'none',
    idempotent: true,
    minPlan: 'STARTER',
  },
  {
    key: 'slack_notify',
    title: 'Slack',
    icon: 'message-circle',
    via: { kind: 'capability', name: 'notify_slack' },
    input: [{ key: 'text', label: '本文', type: 'textarea', required: true }],
    output: [{ key: 'ok', type: 'boolean' }],
    sideEffect: 'external_send',
    idempotent: false,
    minPlan: 'STARTER',
  },
];
const schema = buildFlowDefinitionSchema(PARTS);

/** 提案書（設計書 §3.4）の形: フォーム → AI → 確認 → 文書 */
function proposal(): FlowDefinition {
  return {
    nodes: [
      {
        id: 'form',
        type: 'trigger',
        label: 'フォーム',
        config: {
          mode: 'form',
          fields: [
            { key: 'customer', label: '顧客名', type: 'text', required: true },
            { key: 'budget', label: '予算', type: 'number' },
          ],
        },
      },
      {
        id: 'draft',
        type: 'ai',
        label: '下書き',
        config: { op: 'generate', instruction: '提案書を書いて', input: '顧客: {{form.customer}} 予算: {{ form.budget }}' },
      },
      { id: 'check', type: 'approval', label: '確認', config: { message: '{{form.customer}} 向けを確認', preview: '{{draft.text}}' } },
      {
        id: 'doc',
        type: 'output',
        label: '文書',
        config: { kind: 'document', title: '{{form.customer}} 様 提案書 {{run.date}}', body: '{{draft.text}}' },
      },
    ],
    edges: [
      { from: 'form', to: 'draft' },
      { from: 'draft', to: 'check' },
      { from: 'check', to: 'doc' },
    ],
  };
}

function messagesOf(def: unknown, s: { safeParse: (v: unknown) => any } = schema): string[] {
  const r = s.safeParse(def);
  return r.success ? [] : r.error.issues.map((i: any) => i.message);
}

describe('flowDefinitionSchema: 正常系', () => {
  it('提案書の形が通る', () => {
    expect(messagesOf(proposal())).toEqual([]);
  });

  it('7 型すべてを使った定義が通る（分岐の yes / no・データ・部品・ページ出力）', () => {
    const def: any = {
      nodes: [
        { id: 'start', type: 'trigger', label: '手動', config: { mode: 'manual' } },
        { id: 'deals', type: 'data', label: '案件', config: { resource: 'deal', op: 'list', where: [{ field: 'stage', value: 'LEAD' }], limit: 10 } },
        { id: 'many', type: 'branch', label: '多い', config: { left: '{{deals.count}}', op: 'gt', right: 3 } },
        { id: 'sum', type: 'ai', label: '要約', config: { op: 'summarize', instruction: '要約', input: '{{deals.count}} 件' } },
        { id: 'kind', type: 'ai', label: '分類', config: { op: 'classify', instruction: '分類', input: '{{sum.text}}', choices: ['急ぎ', '普通'] } },
        { id: 'doc', type: 'part', label: '文書', config: { part: 'google_doc', input: { title: '{{kind.choice}}', body: '{{sum.text}}' } } },
        { id: 'ok', type: 'approval', label: '確認', config: { message: '送りますか' } },
        { id: 'tell', type: 'part', label: '通知', config: { part: 'slack_notify', input: { text: '{{doc.url}}' } } },
        { id: 'page', type: 'output', label: '結果', config: { kind: 'page', values: { total: '{{deals.count}}' }, rows: '{{deals.rows}}' } },
      ],
      edges: [
        { from: 'start', to: 'deals' },
        { from: 'deals', to: 'many' },
        { from: 'many', to: 'sum', when: 'yes' },
        { from: 'many', to: 'page', when: 'no' },
        { from: 'sum', to: 'kind' },
        { from: 'kind', to: 'doc' },
        { from: 'doc', to: 'ok' },
        { from: 'ok', to: 'tell' },
      ],
    };
    expect(messagesOf(def)).toEqual([]);
  });

  it('定期のきっかけ（毎週は曜日、毎月は日が要る）', () => {
    const def: any = proposal();
    def.nodes[0] = { id: 'form', type: 'trigger', label: '定期', config: { mode: 'schedule', frequency: 'weekly', hourJst: 9, dayOfWeek: 1 } };
    def.nodes[1].config.input = '今週';
    def.nodes[2].config.message = '確認';
    def.nodes[3].config.title = '週報 {{run.date}}';
    expect(messagesOf(def)).toEqual([]);
    def.nodes[0].config = { mode: 'schedule', frequency: 'monthly', hourJst: 9 };
    expect(messagesOf(def)).toContain('日を選んでください');
    def.nodes[0].config = { mode: 'schedule', frequency: 'monthly', hourJst: 9, dayOfMonth: 31 };
    expect(messagesOf(def).length).toBeGreaterThan(0);
  });
});

describe('flowDefinitionSchema: 許可リスト（T2）', () => {
  it('未知の type は落ちる（コード・HTTP のノードは無い）', () => {
    for (const type of ['code', 'http', 'loop', 'subflow']) {
      const def: any = proposal();
      def.nodes[1] = { id: 'draft', type, label: 'x', config: {} };
      expect(schema.safeParse(def).success).toBe(false);
    }
  });

  it('未知のキーは落ちる（.strict()）', () => {
    const a: any = proposal();
    a.nodes[1].config.url = 'http://evil';
    expect(schema.safeParse(a).success).toBe(false);
    const b: any = proposal();
    b.nodes[1].script = 'x';
    expect(schema.safeParse(b).success).toBe(false);
    const c: any = proposal();
    c.extra = 1;
    expect(schema.safeParse(c).success).toBe(false);
  });

  it('ラベルは一語（8 文字まで）・制御文字なし', () => {
    const a: any = proposal();
    a.nodes[1].label = 'とても長いラベルです';
    expect(schema.safeParse(a).success).toBe(false);
    const b: any = proposal();
    b.nodes[1].label = 'a\u0000b';
    expect(schema.safeParse(b).success).toBe(false);
  });

  it('予約されたノード ID（run / org / constructor）は使えない', () => {
    for (const id of ['run', 'org', 'constructor', 'prototype', '__proto__', 'Upper', '1x']) {
      const def: any = proposal();
      def.nodes[1].id = id;
      def.edges = [
        { from: 'form', to: id },
        { from: id, to: 'check' },
        { from: 'check', to: 'doc' },
      ];
      def.nodes[2].config.preview = 'x';
      def.nodes[3].config.body = 'x';
      expect(schema.safeParse(def).success, id).toBe(false);
    }
  });

  it('上限: ノード 30・AI 5・分岐 5', () => {
    const many: any = { nodes: [{ id: 'start', type: 'trigger', label: 't', config: { mode: 'manual' } }], edges: [] };
    for (let i = 0; i < 6; i++) {
      many.nodes.push({ id: `a${i}`, type: 'ai', label: 'a', config: { op: 'generate', instruction: 'x', input: '' } });
      many.edges.push({ from: i === 0 ? 'start' : `a${i - 1}`, to: `a${i}` });
    }
    expect(messagesOf(many)).toContain('AI は 5 個までです');

    const big: any = { nodes: [{ id: 'start', type: 'trigger', label: 't', config: { mode: 'manual' } }], edges: [] };
    for (let i = 0; i < 30; i++) {
      big.nodes.push({ id: `n${i}`, type: 'approval', label: 'a', config: { message: 'x' } });
      big.edges.push({ from: i === 0 ? 'start' : `n${i - 1}`, to: `n${i}` });
    }
    expect(schema.safeParse(big).success).toBe(false);
  });

  it('64KB を超える定義は落ちる', () => {
    const def: any = proposal();
    def.nodes[3].config.body = 'あ'.repeat(15000);
    def.nodes[1].config.input = 'い'.repeat(4000);
    expect(messagesOf(def)).toEqual([]);
    const big: any = proposal();
    for (let i = 0; i < 4; i++) {
      big.nodes.push({ id: `d${i}`, type: 'output', label: 'd', config: { kind: 'document', title: 't', body: 'あ'.repeat(19000) } });
      big.edges.push({ from: 'check', to: `d${i}` });
    }
    big.edges = big.edges.filter((e: any) => !(e.from === 'check' && e.to === 'd3'));
    big.edges.push({ from: 'draft', to: 'd3' });
    expect(messagesOf(big).some((m) => m.includes('64KB'))).toBe(true);
  });
});

describe('flowDefinitionSchema: グラフ（DAG・到達・線）', () => {
  it('循環（A → B → A）は落ちる', () => {
    const def: any = proposal();
    def.edges.push({ from: 'check', to: 'draft' });
    expect(messagesOf(def)).toContain('線が輪になっています（繰り返しはできません）');
  });

  it('自己ループ・重複・端が無い線は落ちる', () => {
    const a: any = proposal();
    a.edges.push({ from: 'draft', to: 'draft' });
    expect(messagesOf(a)).toContain('自分に戻る線は引けません');
    const b: any = proposal();
    b.edges.push({ from: 'form', to: 'draft' });
    expect(messagesOf(b)).toContain('同じ線が重複しています');
    const c: any = proposal();
    c.edges.push({ from: 'draft', to: 'ghost' });
    expect(messagesOf(c)).toContain('線の端のノードがありません');
  });

  it('きっかけ 2 つ・きっかけ無し・きっかけに入る線は落ちる', () => {
    const two: any = proposal();
    two.nodes.push({ id: 'again', type: 'trigger', label: '手動', config: { mode: 'manual' } });
    two.edges.push({ from: 'again', to: 'draft' });
    expect(messagesOf(two)).toContain('きっかけはちょうど 1 つ必要です');
    const none: any = proposal();
    none.nodes[0] = { id: 'form', type: 'approval', label: 'x', config: { message: 'x' } };
    expect(messagesOf(none)).toContain('きっかけはちょうど 1 つ必要です');
    const into: any = proposal();
    into.edges.push({ from: 'doc', to: 'form' });
    expect(messagesOf(into)).toContain('きっかけに入る線は引けません');
  });

  it('浮いたノード（きっかけから届かない）は落ちる', () => {
    const def: any = proposal();
    def.nodes.push({ id: 'alone', type: 'approval', label: '浮き', config: { message: 'x' } });
    def.nodes.push({ id: 'alone2', type: 'approval', label: '浮き', config: { message: 'x' } });
    def.edges.push({ from: 'alone', to: 'alone2' });
    expect(messagesOf(def)).toContain('きっかけから線がつながっていません');
  });

  it('分岐の線: yes / no が要る、各 1 本まで。分岐以外の線に when は付けない。並列は 3 本まで', () => {
    const base = (): any => ({
      nodes: [
        { id: 'start', type: 'trigger', label: 't', config: { mode: 'manual' } },
        { id: 'b', type: 'branch', label: '分岐', config: { left: '{{run.date}}', op: 'not_empty' } },
        { id: 'x', type: 'approval', label: 'x', config: { message: 'x' } },
        { id: 'y', type: 'approval', label: 'y', config: { message: 'y' } },
      ],
      edges: [
        { from: 'start', to: 'b' },
        { from: 'b', to: 'x', when: 'yes' },
        { from: 'b', to: 'y', when: 'no' },
      ],
    });
    expect(messagesOf(base())).toEqual([]);
    const noWhen = base();
    delete noWhen.edges[1].when;
    expect(messagesOf(noWhen)).toContain('分岐から出る線には yes か no が要ります');
    const twoYes = base();
    twoYes.edges[2].when = 'yes';
    expect(messagesOf(twoYes)).toContain('yes の線は 1 本までです');
    const whenElse = base();
    whenElse.edges[0].when = 'yes';
    expect(messagesOf(whenElse)).toContain('yes / no は分岐から出る線だけに付けます');

    const fan: any = { nodes: [{ id: 'start', type: 'trigger', label: 't', config: { mode: 'manual' } }], edges: [] };
    for (let i = 0; i < 4; i++) {
      fan.nodes.push({ id: `p${i}`, type: 'approval', label: 'p', config: { message: 'x' } });
      fan.edges.push({ from: 'start', to: `p${i}` });
    }
    expect(messagesOf(fan)).toContain('出る線は 3 本までです');
  });

  it('分岐の比べ方: 大小は数、empty には right を書かない', () => {
    const def: any = {
      nodes: [
        { id: 'start', type: 'trigger', label: 't', config: { mode: 'manual' } },
        { id: 'b', type: 'branch', label: '分岐', config: { left: '{{run.id}}', op: 'gt', right: 'a' } },
        { id: 'x', type: 'approval', label: 'x', config: { message: 'x' } },
      ],
      edges: [
        { from: 'start', to: 'b' },
        { from: 'b', to: 'x', when: 'yes' },
      ],
    };
    expect(messagesOf(def)).toContain('大小は数で比べます');
    def.nodes[1].config = { left: '{{run.id}}', op: 'empty', right: 1 };
    expect(messagesOf(def)).toContain('比べる値は要りません');
    def.nodes[1].config = { left: 'run.id', op: 'empty' };
    expect(schema.safeParse(def).success).toBe(false);
  });
});

describe('flowDefinitionSchema: 参照（式）', () => {
  it('下流の値は参照できない', () => {
    const def: any = proposal();
    def.nodes[1].config.input = '{{doc.taskId}}';
    expect(messagesOf(def)).toContain('{{doc.taskId}} は前のノードではありません');
  });

  it('上流のノードに無いキー・知らないノード・組み込みに無いキーは落ちる', () => {
    const a: any = proposal();
    a.nodes[1].config.input = '{{form.nothing}}';
    expect(messagesOf(a)).toContain('{{form.nothing}} はありません');
    const b: any = proposal();
    b.nodes[1].config.input = '{{ghost.text}}';
    expect(messagesOf(b)).toContain('{{ghost.text}} は前のノードではありません');
    const c: any = proposal();
    c.nodes[1].config.input = '{{run.secret}}';
    expect(messagesOf(c)).toContain('{{run.secret}} はありません');
  });

  it('形の違う式（{{ x }}・{{a.b.c}}・閉じ忘れ）は落ちる', () => {
    for (const bad of ['{{ customer }}', '{{form.customer.name}}', '{{form.customer', 'x }}', '{{form.__proto__}}']) {
      const def: any = proposal();
      def.nodes[1].config.input = bad;
      expect(messagesOf(def), bad).toContain('差し込みの形が違います（{{ノード.キー}}）');
    }
  });

  it('表（rows）は文字に入れられない・rows 欄には表だけ', () => {
    const def: any = {
      nodes: [
        { id: 'start', type: 'trigger', label: 't', config: { mode: 'manual' } },
        { id: 'deals', type: 'data', label: '案件', config: { resource: 'deal', op: 'list' } },
        { id: 'sum', type: 'ai', label: '要約', config: { op: 'summarize', instruction: 'x', input: '{{deals.rows}}' } },
      ],
      edges: [
        { from: 'start', to: 'deals' },
        { from: 'deals', to: 'sum' },
      ],
    };
    expect(messagesOf(def)).toContain('{{deals.rows}} は表なので文字に入れられません');
    def.nodes[2] = { id: 'sum', type: 'output', label: '結果', config: { kind: 'page', values: {}, rows: '{{deals.count}}' } };
    expect(messagesOf(def)).toContain('{{deals.count}} は表ではありません');
  });

  it('分岐の反対側のノードも上流ではない', () => {
    const def: any = {
      nodes: [
        { id: 'start', type: 'trigger', label: 't', config: { mode: 'manual' } },
        { id: 'b', type: 'branch', label: '分岐', config: { left: '{{run.id}}', op: 'not_empty' } },
        { id: 'x', type: 'ai', label: 'x', config: { op: 'generate', instruction: 'x', input: '' } },
        { id: 'y', type: 'ai', label: 'y', config: { op: 'generate', instruction: 'x', input: '{{x.text}}' } },
      ],
      edges: [
        { from: 'start', to: 'b' },
        { from: 'b', to: 'x', when: 'yes' },
        { from: 'b', to: 'y', when: 'no' },
      ],
    };
    expect(messagesOf(def)).toContain('{{x.text}} は前のノードではありません');
  });
});

describe('flowDefinitionSchema: 承認なしの外部送信（T5）', () => {
  it('external_send の部品の直前に確認が無ければ落ちる', () => {
    const def: any = proposal();
    def.nodes.push({ id: 'tell', type: 'part', label: '通知', config: { part: 'slack_notify', input: { text: '{{draft.text}}' } } });
    def.edges.push({ from: 'draft', to: 'tell' });
    expect(messagesOf(def)).toContain('送る前に「確認」を置いてください');
  });

  it('通知の出力も直前に確認が要る。確認の後に AI を挟むと落ちる', () => {
    const def: any = proposal();
    def.nodes[3] = { id: 'doc', type: 'output', label: '送信', config: { kind: 'notify', channel: 'email', to: 'a@example.com', body: '{{draft.text}}' } };
    expect(messagesOf(def)).toEqual([]);
    def.nodes.push({ id: 'again', type: 'ai', label: '再生成', config: { op: 'generate', instruction: 'x', input: '' } });
    def.edges = [
      { from: 'form', to: 'draft' },
      { from: 'draft', to: 'check' },
      { from: 'check', to: 'again' },
      { from: 'again', to: 'doc' },
    ];
    expect(messagesOf(def)).toContain('送る前に「確認」を置いてください');
  });

  it('合流: 入る線のどれか 1 本でも確認でなければ落ちる', () => {
    const def: any = proposal();
    def.nodes[3] = { id: 'doc', type: 'output', label: '送信', config: { kind: 'notify', channel: 'slack', body: 'x' } };
    def.edges.push({ from: 'draft', to: 'doc' });
    expect(messagesOf(def)).toContain('送る前に「確認」を置いてください');
  });
});

describe('flowDefinitionSchema: 部品', () => {
  it('カタログに無い部品は落ちる（flowDefinitionSchema は FLOW_PARTS で照合する）', () => {
    const def: any = proposal();
    def.nodes.push({ id: 'p', type: 'part', label: '文書', config: { part: 'google_doc', input: { title: 'x' } } });
    def.edges.push({ from: 'draft', to: 'p' });
    expect(messagesOf(def)).toEqual([]);
    // 本物のカタログの google_doc は本文（content）が必須
    expect(messagesOf(def, flowDefinitionSchema)).toContain('「本文」は必須です');
    def.nodes[4].config.input = { title: 'x', content: '{{draft.text}}' };
    expect(messagesOf(def, flowDefinitionSchema)).toEqual([]);
    expect(messagesOf(def, buildFlowDefinitionSchema([]))).toContain('部品 "google_doc" はありません');
    def.nodes[4].config.part = 'unknown_part';
    expect(messagesOf(def)).toContain('部品 "unknown_part" はありません');
    expect(messagesOf(def, flowDefinitionSchema)).toContain('部品 "unknown_part" はありません');
  });

  it('部品に無い項目・必須の欠け・パスや URL のキーは落ちる', () => {
    const def: any = proposal();
    def.nodes.push({ id: 'p', type: 'part', label: '文書', config: { part: 'google_doc', input: { title: 'x', url: 'http://a' } } });
    def.edges.push({ from: 'draft', to: 'p' });
    expect(messagesOf(def)).toContain('部品に項目 "url" はありません');
    def.nodes[4].config.input = { body: 'x' };
    expect(messagesOf(def)).toContain('「題名」は必須です');
    def.nodes[4].config = { part: '../pages/x', input: {} };
    expect(schema.safeParse(def).success).toBe(false);
  });
});

describe('flowDefinitionSchema: AI・データ・出力の設定', () => {
  const withNode = (node: any): any => {
    const def: any = proposal();
    def.nodes.push(node);
    def.edges.push({ from: 'draft', to: node.id });
    return def;
  };

  it('extract は項目が要り、classify は選択肢が要る', () => {
    expect(messagesOf(withNode({ id: 'e', type: 'ai', label: '抽出', config: { op: 'extract', instruction: 'x', input: '' } }))).toContain(
      '取り出す項目が要ります',
    );
    expect(messagesOf(withNode({ id: 'e', type: 'ai', label: '分類', config: { op: 'classify', instruction: 'x', input: '', choices: ['a'] } })).length).toBeGreaterThan(0);
    expect(
      messagesOf(withNode({ id: 'e', type: 'ai', label: 'x', config: { op: 'generate', instruction: 'x', input: '', choices: ['a', 'b'] } })),
    ).toContain('選択肢は「分類」のときだけ書けます');
  });

  it('extract の項目は次のノードから参照できる', () => {
    const def = withNode({
      id: 'e',
      type: 'ai',
      label: '抽出',
      config: { op: 'extract', instruction: 'x', input: '{{draft.text}}', fields: [{ key: 'amount', label: '金額', type: 'number' }] },
    });
    def.nodes.push({ id: 'k', type: 'approval', label: '確認', config: { message: '{{e.amount}} 円' } });
    def.edges.push({ from: 'e', to: 'k' });
    expect(messagesOf(def)).toEqual([]);
  });

  it('データ: 資源に無い操作・列は落ちる（T14）。原価は作成だけ', () => {
    expect(messagesOf(withNode({ id: 'd', type: 'data', label: '工事', config: { resource: 'project', op: 'create', values: { name: 'x' } } }))).toContain(
      'この資源では create はできません',
    );
    expect(
      messagesOf(withNode({ id: 'd', type: 'data', label: '案件', config: { resource: 'deal', op: 'list', where: [{ field: 'ownerId', value: 'x' }] } })),
    ).toContain('"ownerId" では絞り込めません');
    expect(
      messagesOf(withNode({ id: 'd', type: 'data', label: '原価', config: { resource: 'cost_entry', op: 'create', values: { projectId: 'p', status: 'CONFIRMED' } } })),
    ).toContain('"status" は書けません');
    expect(
      messagesOf(withNode({ id: 'd', type: 'data', label: '原価', config: { resource: 'cost_entry', op: 'create', values: { projectId: 'p' } } })),
    ).toContain('"amount" は必須です');
    for (const resource of ['user', 'membership', 'auditEvent', 'providerConnection']) {
      expect(schema.safeParse(withNode({ id: 'd', type: 'data', label: 'x', config: { resource, op: 'list' } })).success).toBe(false);
    }
  });

  it('データ: 更新は id の条件 1 つだけ、件数は一覧だけ、取得には条件が要る', () => {
    expect(
      messagesOf(withNode({ id: 'd', type: 'data', label: '案件', config: { resource: 'deal', op: 'update', where: [{ field: 'stage', value: 'LEAD' }], values: { stage: 'WON' } } })),
    ).toContain('更新は id の条件 1 つだけです');
    expect(messagesOf(withNode({ id: 'd', type: 'data', label: '案件', config: { resource: 'deal', op: 'get', limit: 3 } }))).toEqual(
      expect.arrayContaining(['件数は一覧のときだけ書けます', '条件が要ります']),
    );
    expect(messagesOf(withNode({ id: 'd', type: 'data', label: '案件', config: { resource: 'deal', op: 'list', limit: 51 } })).length).toBeGreaterThan(0);
  });

  it('ページの出力は 1 つまで', () => {
    const def = withNode({ id: 'p1', type: 'output', label: '結果', config: { kind: 'page', values: { a: '{{draft.text}}' } } });
    def.nodes.push({ id: 'p2', type: 'output', label: '結果', config: { kind: 'page', values: {} } });
    def.edges.push({ from: 'draft', to: 'p2' });
    expect(messagesOf(def)).toContain('ページの出力は 1 つまでです');
  });

  it('キーに組み込みのプロパティ名（constructor など）は使えない', () => {
    expect(
      schema.safeParse(withNode({ id: 'p1', type: 'output', label: '結果', config: { kind: 'page', values: { constructor: 'x' } } })).success,
    ).toBe(false);
    const def: any = proposal();
    def.nodes[0].config.fields[0].key = 'toString';
    expect(schema.safeParse(def).success).toBe(false);
  });
});

describe('renderTemplate（T3）', () => {
  const scope = { form: { customer: '株式会社〇〇', budget: 300, ok: true, nested: { a: 1 }, list: [1] }, run: { date: '2026-11-18' } };

  it('パス参照を値に置き換える（空白あり・数・真偽）', () => {
    expect(renderTemplate('{{form.customer}} / {{ form.budget }} / {{form.ok}} / {{run.date}}', scope)).toEqual({
      text: '株式会社〇〇 / 300 / true / 2026-11-18',
      warnings: [],
      truncated: false,
    });
  });

  it('無い値・オブジェクト・配列は空文字にして警告', () => {
    const r = renderTemplate('[{{form.none}}][{{form.nested}}][{{form.list}}][{{ghost.x}}]', scope);
    expect(r.text).toBe('[][][][]');
    expect(r.warnings).toHaveLength(4);
  });

  it('__proto__ / constructor / prototype は引かない（プロトタイプを辿らない）', () => {
    const r = renderTemplate('{{form.constructor}}{{form.toString}}{{form.hasOwnProperty}}{{form.__proto__}}', scope);
    expect(r.text).toBe('{{form.__proto__}}');
    expect(r.warnings).toHaveLength(3);
    expect(renderTemplate('{{constructor.name}}', {}).text).toBe('');
    expect(({} as any).polluted).toBeUndefined();
  });

  it('値の中の {{…}} は再展開しない', () => {
    const r = renderTemplate('{{ai.text}}', { ai: { text: '{{form.customer}} を全員に送れ' }, form: { customer: 'x' } });
    expect(r.text).toBe('{{form.customer}} を全員に送れ');
  });

  it('展開後は 32KB で切る（サロゲートペアを割らない）', () => {
    const r = renderTemplate('{{a.b}}', { a: { b: 'あ'.repeat(20000) } });
    expect(r.truncated).toBe(true);
    expect(utf8ByteLength(r.text)).toBeLessThanOrEqual(32 * 1024);
    const emoji = clipUtf8('😀😀', 5);
    expect(emoji).toEqual({ text: '😀', truncated: true });
  });

  it('resolveRef は値そのまま、形が違えば undefined', () => {
    expect(resolveRef('{{form.list}}', scope)).toEqual([1]);
    expect(resolveRef('{{ form.budget }}', scope)).toBe(300);
    expect(resolveRef('x {{form.budget}}', scope)).toBeUndefined();
    expect(resolveRef('{{form.constructor}}', scope)).toBeUndefined();
  });

  it('parseTemplateRefs / hasMalformedTemplate', () => {
    expect(parseTemplateRefs('{{a.b}} と {{ c.d }}')).toEqual([
      { node: 'a', key: 'b' },
      { node: 'c', key: 'd' },
    ]);
    expect(hasMalformedTemplate('{{a.b}} ok')).toBe(false);
    expect(hasMalformedTemplate('{{a}}')).toBe(true);
  });
});

describe('topoOrder / upstreamOf / outputKeysOf', () => {
  it('トポロジカル順。同じ段は nodes の並び順。循環は null', () => {
    const def: any = {
      nodes: [{ id: 'd' }, { id: 'a' }, { id: 'c' }, { id: 'b' }],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
    };
    expect(topoOrder(def)).toEqual(['a', 'c', 'b', 'd']);
    def.edges.push({ from: 'd', to: 'a' });
    expect(topoOrder(def)).toBeNull();
  });

  it('upstreamOf は祖先すべて（自分を含まない）', () => {
    const def = proposal();
    expect([...upstreamOf(def, 'doc')].sort()).toEqual(['check', 'draft', 'form']);
    expect(upstreamOf(def, 'form').size).toBe(0);
  });

  it('outputKeysOf: 型ごとの出力', () => {
    const def = proposal();
    expect(outputKeysOf(def.nodes[0])).toEqual([
      { key: 'customer', type: 'text' },
      { key: 'budget', type: 'number' },
    ]);
    expect(outputKeysOf(def.nodes[1])).toEqual([{ key: 'text', type: 'text' }]);
    expect(outputKeysOf(def.nodes[2]).map((k) => k.key)).toEqual(['approvedBy', 'approvedAt']);
    expect(outputKeysOf(def.nodes[3])).toEqual([{ key: 'taskId', type: 'text' }]);
    const part: any = { id: 'p', type: 'part', label: 'x', config: { part: 'google_doc', input: {} } };
    expect(outputKeysOf(part, PARTS)).toEqual([
      { key: 'url', type: 'text' },
      { key: 'items', type: 'rows', columns: ['name'] },
    ]);
    expect(outputKeysOf(part)).toEqual([]);
    const list: any = { id: 'l', type: 'data', label: 'x', config: { resource: 'vendor', op: 'list' } };
    expect(outputKeysOf(list)[0]).toEqual({ key: 'rows', type: 'rows', columns: ['id', 'name', 'kind', 'invoiceRegistered'] });
  });

  it('templateSlotsOf は式を書ける欄を返す', () => {
    const def = proposal();
    expect(templateSlotsOf(def.nodes[1]).map((s) => s.path.join('.'))).toEqual(['config.instruction', 'config.input']);
    expect(templateSlotsOf(def.nodes[0])).toEqual([]);
  });

  it('isExternalSendNode: 知らない部品は送る側に倒す', () => {
    const unknown: any = { id: 'p', type: 'part', label: 'x', config: { part: 'nope', input: {} } };
    expect(isExternalSendNode(unknown, PARTS)).toBe(true);
    const doc: any = { id: 'p', type: 'part', label: 'x', config: { part: 'google_doc', input: {} } };
    expect(isExternalSendNode(doc, PARTS)).toBe(false);
  });

  it('checkFlowDefinition はノード ID を付けて返す（画面の印）', () => {
    const def: any = proposal();
    def.nodes[1].config.input = '{{doc.taskId}}';
    expect(checkFlowDefinition(def, PARTS)).toEqual([
      expect.objectContaining({ nodeId: 'draft', path: ['nodes', 1, 'config', 'input'] }),
    ]);
  });
});

describe('canvasLayoutSchema（§6.6）', () => {
  const layout = (): any => ({
    nodes: [
      { id: 'inquiry', label: '問い合わせ', icon: 'inbox', x: 0, y: 0, target: { kind: 'link', to: '/inbox' } },
      { id: 'proposal', label: '提案書', icon: 'file-text', x: 240.6, y: -9999, target: { kind: 'template', templateKey: 'proposal' } },
      { id: 'mine', label: '日報', icon: 'clipboard-list', x: 480, y: 0, target: { kind: 'flow', flowId: 'clx123abc' } },
      { id: 'page', label: '台帳', icon: 'folder', x: 0, y: 160, target: { kind: 'link', to: '/p/ledger' } },
    ],
    edges: [
      { from: 'inquiry', to: 'proposal' },
      { from: 'proposal', to: 'inquiry' },
    ],
  });

  it('通る。座標は整数に丸め −5000〜5000 に収める。循環は許す', () => {
    const r = canvasLayoutSchema.safeParse(layout());
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.nodes[1].x).toBe(241);
      expect(r.data.nodes[1].y).toBe(-5000);
    }
  });

  it('外部 URL・javascript:・// と許可リストに無いパスは書けない（T6）', () => {
    for (const to of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '/admin', '/p/../x', '/agents/a/b', '/inbox?tab=x', '/p/', '']) {
      const l = layout();
      l.nodes[0].target.to = to;
      expect(canvasLayoutSchema.safeParse(l).success, to).toBe(false);
    }
  });

  it('知らないテンプレート・知らないアイコン・自己ループ・重複・端の無い線・ID の重複は落ちる', () => {
    const cases: ((l: any) => void)[] = [
      (l) => (l.nodes[1].target.templateKey = 'nope'),
      (l) => (l.nodes[0].icon = 'skull'),
      (l) => l.edges.push({ from: 'mine', to: 'mine' }),
      (l) => l.edges.push({ from: 'inquiry', to: 'proposal' }),
      (l) => l.edges.push({ from: 'inquiry', to: 'ghost' }),
      (l) => (l.nodes[1].id = 'inquiry'),
      (l) => (l.nodes[0].target = { kind: 'url', to: 'https://x' }),
      (l) => (l.nodes[2].target.flowId = '../x'),
      (l) => (l.nodes[0].onClick = 'x'),
    ];
    for (const mutate of cases) {
      const l = layout();
      mutate(l);
      expect(canvasLayoutSchema.safeParse(l).success, String(mutate)).toBe(false);
    }
  });

  it('ノード 40・線 80 まで', () => {
    const l: any = { nodes: [], edges: [] };
    for (let i = 0; i < 41; i++) l.nodes.push({ id: `n${i}`, label: 'x', icon: 'star', x: 0, y: 0, target: { kind: 'link', to: '/chat' } });
    expect(canvasLayoutSchema.safeParse(l).success).toBe(false);
    l.nodes.pop();
    expect(canvasLayoutSchema.safeParse(l).success).toBe(true);
  });

  it('isCanvasLinkPath', () => {
    expect(isCanvasLinkPath('/inbox?tab=approvals')).toBe(true);
    expect(isCanvasLinkPath('/agents/clx1')).toBe(true);
    expect(isCanvasLinkPath('/agents/')).toBe(false);
    expect(isCanvasLinkPath(1)).toBe(false);
  });
});

describe('構造の固定（ソーステスト）', () => {
  /** コメントを除いた本文（説明文の「eval を使わない」に引っかからないように） */
  const src = (name: string) =>
    readFileSync(join(__dirname, '..', name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('flows-core.ts と flows-plan.ts は zod を import しない（初回ロードに zod を載せない）', () => {
    for (const name of ['flows-core.ts', 'flows-plan.ts', 'pages-plan.ts', 'flow-parts.ts', 'flow-templates.ts']) {
      expect(src(name), name).not.toMatch(/from ['"]zod['"]/);
      // zod を読むファイル（flows.ts / pages.ts）からは型だけ
      expect(src(name), name).not.toMatch(/^import \{[^}]*\} from '\.\/(flows|pages)';/m);
    }
  });

  it('eval / new Function / vm を使わない（T2・K13）', () => {
    for (const name of ['flows-core.ts', 'flows-plan.ts', 'flows.ts', 'flow-parts.ts', 'flow-templates.ts']) {
      const s = src(name);
      expect(s, name).not.toMatch(/\beval\s*\(/);
      expect(s, name).not.toMatch(/new\s+Function\b/);
      expect(s, name).not.toMatch(/node:vm|from ['"]vm['"]/);
    }
  });

  it('FLOW_DEPARTMENTS は AGENT_DEPARTMENTS と同じ', () => {
    expect([...FLOW_DEPARTMENTS]).toEqual(AGENT_DEPARTMENTS);
  });
});
