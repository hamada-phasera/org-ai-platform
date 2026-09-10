import { describe, it, expect } from 'vitest';
import type { AgentStepDef } from '@org-ai/shared-types';
import {
  NODE_GAP,
  normalizeSteps,
  stepLabel,
  stepRequiresApproval,
  stepsToFlow,
  summarizeArgs,
} from '../stepsToFlow';

const CAPS = [
  { name: 'create_google_doc', displayName: 'Googleドキュメント作成' },
  { name: 'notify_slack', displayName: 'Slack 投稿' },
  { name: 'custom_get', displayName: 'CRM取得', kind: 'http', httpMethod: 'GET' },
  { name: 'custom_post', displayName: 'CRM登録', kind: 'http', httpMethod: 'POST' },
];

describe('normalizeSteps', () => {
  it('null / undefined を空配列にする（Agent.steps は null を取る）', () => {
    expect(normalizeSteps(null)).toEqual([]);
    expect(normalizeSteps(undefined)).toEqual([]);
  });
  it('capabilityName を持たない壊れた要素を落とす', () => {
    const steps = [{ capabilityName: 'a' }, null, { argTemplate: {} }] as never;
    expect(normalizeSteps(steps)).toHaveLength(1);
  });
});

describe('stepRequiresApproval', () => {
  it('外部送信 capability は承認が必要', () => {
    expect(stepRequiresApproval('notify_slack')).toBe(true);
    expect(stepRequiresApproval('send_email')).toBe(true);
  });
  it('成果物作成は承認不要', () => {
    expect(stepRequiresApproval('create_google_doc')).toBe(false);
    expect(stepRequiresApproval('llm_transform')).toBe(false);
  });
  it('カスタム HTTP ノードは GET だけ承認不要（非 GET と不明は承認必要）', () => {
    expect(stepRequiresApproval('custom_get', CAPS[2])).toBe(false);
    expect(stepRequiresApproval('custom_post', CAPS[3])).toBe(true);
    // method 不明は fail-closed（gateway 側と同じ規則）
    expect(stepRequiresApproval('x', { name: 'x', displayName: 'X', kind: 'http' })).toBe(true);
  });
});

describe('stepLabel', () => {
  it('予約ステップは固定の表示名', () => {
    expect(stepLabel('llm_transform')).toBe('AIで加工');
  });
  it('レジストリにあれば displayName、無ければ name をそのまま', () => {
    expect(stepLabel('notify_slack', CAPS[1])).toBe('Slack 投稿');
    expect(stepLabel('unknown_cap')).toBe('unknown_cap');
  });
});

describe('summarizeArgs', () => {
  it('key: value を1行に畳む', () => {
    expect(summarizeArgs({ channel: '#general', text: 'やあ' })).toBe('channel: #general / text: やあ');
  });
  it('文字列でない値も壊さず出す（AI 生成 steps は zod を通らない）', () => {
    expect(summarizeArgs({ rows: [['a', 1]] })).toBe('rows: [["a",1]]');
  });
  it('長すぎる場合は切り詰める', () => {
    const out = summarizeArgs({ text: 'あ'.repeat(200) }, 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('…')).toBe(true);
  });
  it('argTemplate 未設定は空文字', () => {
    expect(summarizeArgs(undefined)).toBe('');
    expect(summarizeArgs(null)).toBe('');
    expect(summarizeArgs('nonsense')).toBe('');
  });
});

describe('stepsToFlow', () => {
  const steps: AgentStepDef[] = [
    { capabilityName: 'create_google_doc', argTemplate: { title: '日報', content: '{{input}}' } },
    { capabilityName: 'notify_slack', argTemplate: { channel: '#general', text: '{{prev}}' } },
  ];

  it('縦一列に並べ、間をエッジで繋ぐ', () => {
    const { nodes, edges } = stepsToFlow(steps, CAPS);
    expect(nodes.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: NODE_GAP },
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'step-0', target: 'step-1' });
  });

  it('実行状態が無ければ全て PENDING', () => {
    const { nodes } = stepsToFlow(steps, CAPS);
    expect(nodes.map((n) => n.data.status)).toEqual(['PENDING', 'PENDING']);
    expect(nodes.every((n) => !n.data.error)).toBe(true);
  });

  it('実行状態をノードに写し、実行中の区間だけ線を流す', () => {
    const { nodes, edges } = stepsToFlow(steps, CAPS, {
      version: 1,
      input: 'x',
      currentIndex: 1,
      steps: [
        { index: 0, capabilityName: 'create_google_doc', status: 'DONE' },
        { index: 1, capabilityName: 'notify_slack', status: 'RUNNING' },
      ],
    });
    expect(nodes.map((n) => n.data.status)).toEqual(['DONE', 'RUNNING']);
    expect(edges[0].animated).toBe(true);
  });

  it('承認待ちと失敗理由がノードに出る', () => {
    const { nodes } = stepsToFlow(steps, CAPS, {
      version: 1,
      input: 'x',
      currentIndex: 1,
      steps: [
        { index: 0, capabilityName: 'create_google_doc', status: 'FAILED', error: '接続が必要です' },
        { index: 1, capabilityName: 'notify_slack', status: 'AWAITING_APPROVAL' },
      ],
    });
    expect(nodes[0].data.error).toBe('接続が必要です');
    expect(nodes[1].data.status).toBe('AWAITING_APPROVAL');
  });

  it('外部送信ノードに承認フラグが立つ', () => {
    const { nodes } = stepsToFlow(steps, CAPS);
    expect(nodes[0].data.requiresApproval).toBe(false);
    expect(nodes[1].data.requiresApproval).toBe(true);
  });

  it('レジストリに無い capability は unknown 印を付けて描く（消さない）', () => {
    const { nodes } = stepsToFlow([{ capabilityName: 'ghost' }], CAPS);
    expect(nodes[0].data.unknown).toBe(true);
    expect(nodes[0].data.label).toBe('ghost');
  });

  it('予約ステップは unknown にしない', () => {
    const { nodes } = stepsToFlow([{ capabilityName: 'llm_transform' }], CAPS);
    expect(nodes[0].data.unknown).toBe(false);
  });

  it('steps が null でも落ちない', () => {
    expect(stepsToFlow(null, CAPS)).toEqual({ nodes: [], edges: [] });
  });
});
