import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../utils/prisma', () => ({ prisma: {} }));
import { FLOW_PARTS, findFlowPart, type FlowPartSpec } from '@org-ai/shared-types';
import { buildPartUrl, partTimeoutMs, shapePartOutput, toCapabilityArgs } from '../part-client';
import { flowScheduleOf, jstHourToUtc } from '../schedule';

// 部品の呼び出しと定期のきっかけの純粋関数（docs/design/canvas-home.md §8.2・§5.5・T6・T9・K57）。

describe('buildPartUrl（T6・T7）', () => {
  it('ベース＋/webhook/parts/<key> だけ。末尾の / は 1 つにする', () => {
    expect(buildPartUrl('https://n8n.example/', 'pdf_make')).toBe('https://n8n.example/webhook/parts/pdf_make');
    expect(buildPartUrl('https://n8n.example', 'pdf_make')).toBe('https://n8n.example/webhook/parts/pdf_make');
  });
  it.each(['../pages/org-A/x', 'pages/org', 'Pdf', 'a', 'cap-send', 'x/y', 'x?y=1', '', 'a'.repeat(41)])('"%s" は投げる', (key) => {
    expect(() => buildPartUrl('https://n8n.example', key)).toThrow();
  });
  it('カタログの key はすべて組み立てられる', () => {
    for (const p of FLOW_PARTS) expect(buildPartUrl('https://n', p.key)).toBe(`https://n/webhook/parts/${p.key}`);
  });
});

describe('partTimeoutMs', () => {
  it('既定 10 秒・最大 30 秒', () => {
    expect(partTimeoutMs({})).toBe(10_000);
    expect(partTimeoutMs({ timeoutMs: 20_000 })).toBe(20_000);
    expect(partTimeoutMs({ timeoutMs: 120_000 })).toBe(30_000);
  });
});

describe('shapePartOutput（T9）', () => {
  const spec: Pick<FlowPartSpec, 'output' | 'sideEffect'> = {
    sideEffect: 'none',
    output: [
      { key: 'url', type: 'text' },
      { key: 'count', type: 'number' },
      { key: 'done', type: 'boolean' },
      { key: 'rows', type: 'rows', columns: [{ key: 'name', type: 'text' }, { key: 'n', type: 'number' }] },
    ],
  };
  it('宣言したキーと列だけを受け取る（入れ子・余分なキーは捨てる）', () => {
    const r = shapePartOutput(spec, {
      url: 'u', count: '3', done: 'true', extra: 'x', __proto__: { polluted: 1 },
      rows: [{ name: 'a', n: 1, secret: 's' }, { name: { x: 1 }, n: 'x' }, 'bad'],
    });
    expect(r).toEqual({
      ok: true,
      output: { url: 'u', count: 3, done: true, rows: [{ name: 'a', n: 1 }, { name: null, n: null }] },
      warnings: [],
    });
  });
  it('無いキーは空にして warnings。配列・null・文字は形が違う', () => {
    const r = shapePartOutput(spec, {});
    expect(r.ok && r.output).toEqual({ url: '', count: null, done: null, rows: [] });
    expect(r.ok && r.warnings.length).toBe(4);
    expect(shapePartOutput(spec, [1]).ok).toBe(false);
    expect(shapePartOutput(spec, null).ok).toBe(false);
    expect(shapePartOutput(spec, 'x').ok).toBe(false);
  });
  it('外へ送る部品の sent は、応答に無ければ true', () => {
    const slack = findFlowPart('slack_notify')!;
    expect(shapePartOutput(slack, { channel: 'C', ts: '1' })).toEqual({ ok: true, output: { sent: true }, warnings: [] });
  });
});

describe('toCapabilityArgs（K38）', () => {
  it('スプレッドシートの見出しと行は文字から配列に', () => {
    expect(toCapabilityArgs('create_google_sheet', { title: 'T', headers: '日付, 売上，客', rows: '11/1,100,A\n\n11/2、200、B' })).toEqual({
      title: 'T',
      headers: ['日付', '売上', '客'],
      rows: [['11/1', '100', 'A'], ['11/2', '200', 'B']],
    });
  });
  it('それ以外はそのまま（空の値は渡さない）', () => {
    expect(toCapabilityArgs('send_email', { to: 'a@b.c', subject: 's', body: 'b', cc: '' })).toEqual({ to: 'a@b.c', subject: 's', body: 'b' });
  });
});

describe('定期のきっかけ（K57）', () => {
  it('日本時間の時を UTC の時に直す', () => {
    expect(jstHourToUtc(9)).toBe(0);
    expect(jstHourToUtc(8)).toBe(23);
    expect(jstHourToUtc(0)).toBe(15);
    expect(jstHourToUtc(23)).toBe(14);
  });
  it('定期のきっかけだけ行の値を返す。曜日・日付は日本時間のまま', () => {
    const t = (config: Record<string, unknown>) => ({ nodes: [{ id: 'go', type: 'trigger', label: 'x', config }] }) as never;
    expect(flowScheduleOf(t({ mode: 'manual' }))).toBeNull();
    expect(flowScheduleOf(t({ mode: 'schedule', frequency: 'weekly', hourJst: 8, dayOfWeek: 1 }))).toEqual({
      frequency: 'weekly', hourUtc: 23, dayOfWeek: 1, dayOfMonth: null,
    });
    expect(flowScheduleOf(t({ mode: 'schedule', frequency: 'monthly', hourJst: 7, dayOfMonth: 1 }))).toEqual({
      frequency: 'monthly', hourUtc: 22, dayOfWeek: null, dayOfMonth: 1,
    });
  });
});
