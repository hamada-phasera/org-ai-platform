// 運営（プラットフォーム管理者＝FLOW を提供する側）の判定（docs/design/canvas-home.md §8.5・K26・U-11）。
//
// ■ 既存の ADMIN_EMAILS（ai-engine のモデル選択と同じ変数）と、JWT の email（発行時に DB から入れた値）を照合する。
// ■ 組織の OWNER / ADMIN とは別の軸。運営だからといって他組織のデータが見えるわけではない（使い道は「n8n で開く」だけ）。
// ■ 偽なら項目ごと返さない（T23）。

import { config } from '../config/env';

export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return e.length > 0 && config.platformAdminEmails.includes(e);
}
