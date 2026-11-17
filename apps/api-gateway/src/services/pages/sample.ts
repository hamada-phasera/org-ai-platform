// 業務ページのサンプルモード（docs/design/custom-pages.md §8・K13・T16）。
//
// - `PAGES_SAMPLE_MODE=true` かつ**本番でない**とき（config.pagesSampleMode）、かつ行に `sampleData` があるときだけ効く。
// - query は `sampleData[actionId]`（n8n の応答そのもの）を、**本番と同じ projectQueryResult に通して**返す。
// - submit は n8n を呼ばず固定の文言。記録も数えもしない。
// - `sampleData` は seed だけが書ける（登録 API のスキーマに項目が無い）。

import { config } from '../../config/env';

export const SAMPLE_SUBMIT_MESSAGE = 'サンプルのため送信していません';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** このページをサンプルとして動かすか（優先順: サンプル → n8n → 未接続。§8） */
export function isSamplePage(page: { sampleData?: unknown }): boolean {
  return config.pagesSampleMode && isPlainObject(page.sampleData);
}

/** query のサンプル応答。その action の分が無ければ undefined（projectQueryResult がブロック単位の error にする） */
export function sampleQueryResponse(page: { sampleData?: unknown }, actionId: string): unknown {
  const data = page.sampleData;
  if (!isPlainObject(data) || !Object.prototype.hasOwnProperty.call(data, actionId)) return undefined;
  return data[actionId];
}
