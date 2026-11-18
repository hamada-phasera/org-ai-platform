/**
 * 業務ページのセル・KPI の表示。値は gateway が切り詰めたスカラーだけ（string / number / boolean / null）。
 * 文字はすべてテキストノードで出す。URL らしい文字列もリンクにしない（設計書 §7.2）。
 */
import type { PageCell } from '@org-ai/shared-types';

export type KpiFormat = 'number' | 'yen' | 'percent' | 'text';
export type CellFormat = 'text' | 'number' | 'yen' | 'date' | 'badge';

const EMPTY = '—';

function num(value: number): string {
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
}

/** `YYYY-MM-DD…` は `YYYY/MM/DD` に。日付の形でなければそのまま（n8n の書き方を推測で壊さない） */
function date(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : value;
}

/**
 * percent は「n8n が百分率の数を返す」前提（12.5 → 12.5%）。0〜1 の比率を推測で 100 倍しない
 * （0.5 が 50% なのか 0.5% なのか、こちらでは決められない）。
 */
export function formatKpi(value: string | number | null | undefined, format: KpiFormat = 'number'): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  if (typeof value === 'string') return value;
  switch (format) {
    case 'yen':
      return `¥${Math.round(value).toLocaleString('ja-JP')}`;
    case 'percent':
      return `${num(value)}%`;
    case 'text':
      return String(value);
    default:
      return num(value);
  }
}

export function formatCell(value: PageCell | undefined, format: CellFormat = 'text'): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  if (typeof value === 'number') {
    if (format === 'yen') return `¥${Math.round(value).toLocaleString('ja-JP')}`;
    if (format === 'number') return num(value);
    return String(value);
  }
  if (format === 'date') return date(value);
  return value;
}

/** 数値の列は右寄せ（金額・件数が縦に並ぶ） */
export function isNumericFormat(format: CellFormat | undefined): boolean {
  return format === 'number' || format === 'yen';
}
