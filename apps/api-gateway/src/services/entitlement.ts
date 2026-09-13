// 契約が切れた組織の扱い。
//
// ⚠️ データは消さないし、読めなくもしない。止めるのは「新しく作る・実行する」だけ。
//    建設業は帳簿を残す意識が強く、台帳が見えなくなることへの抵抗が大きい。
//    閲覧と書き出しの原価はほぼゼロなので、止める理由もない。
// ⚠️ subscriptionStatus が null の組織は「まだ決済を繋いでいない」＝課金開始前の利用者。
//    ここを read_only にすると、Stripe を設定した瞬間に既存の利用者が全員止まる。

import { ENTITLED_STATUSES } from '@org-ai/shared-types';

export type Entitlement = 'full' | 'read_only';

export function entitlementOf(status: string | null | undefined): Entitlement {
  if (!status) return 'full';
  return (ENTITLED_STATUSES as readonly string[]).includes(status) ? 'full' : 'read_only';
}

export const READ_ONLY_MESSAGE =
  'ご契約が終了しているため、新しい実行と保存はできません。台帳・ファイル・過去のやり取りの閲覧と書き出しはそのままご利用いただけます。設定 > プラン から再開できます。';

/** 契約が切れていても通す経路。請求の手続きと認証を止めると、再開する手段が無くなる。 */
export const ALWAYS_ALLOWED_PREFIXES = ['/api/billing', '/api/auth', '/api/webhooks'];

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** この要求で契約を確認する必要があるか（読み取りでは DB を引かない）。 */
export function needsEntitlementCheck(method: string | undefined, url: string | undefined): boolean {
  // Fastify は必ず両方を持つ。欠けるのはテストの作り物なので、確認せず通す
  if (!method || !url) return false;
  if (!WRITE_METHODS.has(method.toUpperCase())) return false;
  const path = url.split('?')[0];
  return !ALWAYS_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}
