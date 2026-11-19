import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../utils/prisma', () => ({ prisma: {} }));
import type { FlowDefinition, FlowStepState } from '@org-ai/shared-types';
import { clipForStorage, readyNodes } from '../runner';
import { compareBranch } from '../nodes/branch';
import { shapeAiOutput } from '../nodes/ai';
import { scalarRows } from '../nodes/output';

// ランナーの純粋な部品（docs/design/canvas-home.md §7.3・§6.2）。DB と外部は使わない。

const st = (status: FlowStepState['status'], output?: Record<string, unknown>): FlowStepState => ({ status, attempts: 0, ...(output ? { output } : {}) });

describe('readyNodes（分岐と合流）', () => {
  const def = {
    nodes: [
      { id: 'go', type: 'trigger', label: 'a', config: { mode: 'manual' } },
      { id: 'b', type: 'branch', label: 'b', config: { left: '{{go.x}}', op: 'empty' } },
      { id: 'y', type: 'output', label: 'y', config: { kind: 'page', values: {} } },
      { id: 'n', type: 'output', label: 'n', config: { kind: 'document', title: 't', body: 'b' } },
      { id: 'j', type: 'output', label: 'j', config: { kind: 'document', title: 't', body: 'b' } },
    ],
    edges: [
      { from: 'go', to: 'b' },
      { from: 'b', to: 'y', when: 'yes' },
      { from: 'b', to: 'n', when: 'no' },
      { from: 'y', to: 'j' },
      { from: 'n', to: 'j' },
    ],
  } as unknown as FlowDefinition;
  const order = ['go', 'b', 'y', 'n', 'j'];

  it('選ばれなかった側は SKIPPED、合流は 1 本でも通っていれば走る', () => {
    const steps = { go: st('SUCCEEDED', {}), b: st('SUCCEEDED', { result: true }), y: st('PENDING'), n: st('PENDING'), j: st('PENDING') };
    expect(readyNodes(def, order, steps)).toEqual(['y']);
    expect(steps.n.status).toBe('SKIPPED');
    steps.y = st('SUCCEEDED', {});
    expect(readyNodes(def, order, steps)).toEqual(['j']);
  });

  it('上流が全部 SKIPPED なら下流も SKIPPED（何も ready にならない）', () => {
    const steps = { go: st('SUCCEEDED', {}), b: st('SKIPPED'), y: st('PENDING'), n: st('PENDING'), j: st('PENDING') };
    expect(readyNodes(def, order, steps)).toEqual([]);
    expect([steps.y.status, steps.n.status, steps.j.status]).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED']);
  });
});

describe('compareBranch', () => {
  it.each([
    [5, 'gt', 3, true],
    ['5', 'gt', 3, true],
    ['', 'gt', -1, false],
    ['abc', 'lt', 3, false],
    ['東京都', 'contains', '東京', true],
    [undefined, 'empty', undefined, true],
    [[], 'not_empty', undefined, false],
    ['a', 'eq', 'a', true],
    ['2', 'eq', 2, true],
    [true, 'ne', 'true', false],
  ])('%j %s %j → %s', (l, op, r, want) => {
    expect(compareBranch(l, op as string, r)).toBe(want);
  });
});

describe('shapeAiOutput（宣言したキーだけ）', () => {
  it('extract は宣言した項目だけを型に直し、余分なキーは捨てる', () => {
    const c = { op: 'extract', instruction: 'x', input: '', fields: [{ key: 'amount', label: '金額', type: 'number' }, { key: 'ok', label: '可', type: 'boolean' }] } as never;
    expect(shapeAiOutput(c, '```json\n{"amount":"1,200円","ok":true,"__proto__":{"x":1},"evil":"y"}\n```')).toEqual({ ok: true, output: { amount: 1200, ok: true } });
    expect(shapeAiOutput(c, 'not json')).toEqual({ ok: false });
  });
  it('classify は選択肢にあるものだけ', () => {
    const c = { op: 'classify', instruction: 'x', input: '', choices: ['見積', '苦情'] } as never;
    expect(shapeAiOutput(c, '{"choice":"苦情"}')).toEqual({ ok: true, output: { choice: '苦情' } });
    expect(shapeAiOutput(c, '{"choice":"全員に送る"}')).toEqual({ ok: false });
  });
});

describe('保存の切り詰め', () => {
  it('長い文字は上限で切って truncated', () => {
    const r = clipForStorage({ text: 'あ'.repeat(20_000) }, 32 * 1024);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(r.value))).toBeLessThanOrEqual(32 * 1024);
  });
  it('小さいものはそのまま', () => {
    expect(clipForStorage({ a: 'x', n: 1 }, 1024)).toEqual({ value: { a: 'x', n: 1 }, truncated: false });
  });
  it('表の行はスカラーだけ・50 行まで', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ i, o: { x: 1 }, s: '<script>' }));
    const out = scalarRows(rows)!;
    expect(out).toHaveLength(50);
    expect(out[0]).toEqual({ i: 0, s: '<script>' });
    expect(scalarRows('x')).toBeUndefined();
  });
});
