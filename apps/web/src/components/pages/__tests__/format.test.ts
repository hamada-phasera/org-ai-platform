import { describe, expect, it } from 'vitest';
import { PAGE_ICONS } from '@org-ai/shared-types';
import { FileText } from 'lucide-react';
import { formatCell, formatKpi, isNumericFormat } from '../format';
import { PAGE_ICON_COMPONENTS, pageIconOf } from '../icons';
import { toInput, validateForm } from '../blocks/FormBlock';
import { buildInputSchema } from '@org-ai/shared-types';
import { sampleDetail } from './fixtures';

describe('formatKpi', () => {
  it('数値・円・百分率・文字・空', () => {
    expect(formatKpi(1234567)).toBe('1,234,567');
    expect(formatKpi(1234.5, 'yen')).toBe('¥1,235');
    expect(formatKpi(12.5, 'percent')).toBe('12.5%');
    expect(formatKpi(3, 'text')).toBe('3');
    expect(formatKpi('順調')).toBe('順調');
    expect(formatKpi(null)).toBe('—');
    expect(formatKpi(undefined)).toBe('—');
  });
});

describe('formatCell', () => {
  it('日付は YYYY/MM/DD、形でなければそのまま', () => {
    expect(formatCell('2026-11-17', 'date')).toBe('2026/11/17');
    expect(formatCell('2026-11-17T09:00:00Z', 'date')).toBe('2026/11/17');
    expect(formatCell('昨日', 'date')).toBe('昨日');
  });
  it('数・円・真偽・空', () => {
    expect(formatCell(1500, 'yen')).toBe('¥1,500');
    expect(formatCell(1500, 'number')).toBe('1,500');
    expect(formatCell(1500)).toBe('1500');
    expect(formatCell(true)).toBe('はい');
    expect(formatCell(false)).toBe('いいえ');
    expect(formatCell(null)).toBe('—');
    expect(formatCell('')).toBe('—');
  });
  it('URL らしい文字もただの文字', () => {
    expect(formatCell('javascript:alert(1)')).toBe('javascript:alert(1)');
  });
  it('数値の列だけ右寄せ', () => {
    expect(isNumericFormat('yen')).toBe(true);
    expect(isNumericFormat('number')).toBe(true);
    expect(isNumericFormat('badge')).toBe(false);
    expect(isNumericFormat(undefined)).toBe(false);
  });
});

describe('アイコンの表', () => {
  it('許可リストのすべてにコンポーネントがある（余りも無い）', () => {
    expect(Object.keys(PAGE_ICON_COMPONENTS).sort()).toEqual([...PAGE_ICONS].sort());
    for (const name of PAGE_ICONS) expect(PAGE_ICON_COMPONENTS[name]).toBeTruthy();
  });
  it('知らない名前は既定のアイコン', () => {
    expect(pageIconOf('skull')).toBe(FileText);
    expect(pageIconOf(undefined)).toBe(FileText);
  });
});

describe('フォームの値', () => {
  const def = sampleDetail().definition;
  const form = def.blocks[2];
  if (form.type !== 'form') throw new Error('fixture');

  it('数値の空は null、数にならない文字はそのまま、チェックは真偽', () => {
    const fields = [
      { key: 'n', label: '数', type: 'number' as const },
      { key: 'm', label: '数', type: 'number' as const },
      { key: 'c', label: '同意', type: 'checkbox' as const },
    ];
    expect(toInput(fields, { n: '', m: '1x', c: true })).toEqual({ n: null, m: '1x', c: true });
    expect(toInput(fields, { n: ' 12 ', m: '-3.5', c: false })).toEqual({ n: 12, m: -3.5, c: false });
  });

  it('gateway と同じスキーマで検証する（必須・型）', () => {
    const schema = buildInputSchema(def, form.action, { blockIndex: 2 });
    expect(schema).not.toBeNull();
    const empty = toInput(form.fields, { name: '', tel: '', subject: '', body: '' });
    expect(validateForm(form.fields, empty, schema)).toEqual({ name: '必須です', subject: '必須です' });
    const bad = toInput(form.fields, { name: 'a', tel: 'x', subject: 'b', body: '' });
    expect(Object.keys(validateForm(form.fields, bad, schema))).toEqual(['tel']);
    const good = toInput(form.fields, { name: 'a', tel: '03-1234-5678', subject: 'b', body: '' });
    expect(validateForm(form.fields, good, schema)).toEqual({});
  });
});
