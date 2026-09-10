// capability の RequiredCredential.provider 文字列と、セルフサーブ接続
// （ProviderConnection.provider）の対応を一元定義する。
//
// ここに載っている provider だけが native adapter（gateway 直接実行）＋自社DBの
// 接続判定に切り替わる。載っていないもの（gmail / x / google_sheets）は従来どおり
// n8n 実行 + n8n credential 判定のまま。
//
// ⚠️ google_sheets（summarize_sheet = 既存シートの読取）は意図的にマップしない。
// 今回の Google スコープは drive.file（アプリが作成したファイルのみ）で、既存シートは
// 読めないため。誤ってマップすると「gateway 上は CONNECTED なのに実行は AUTH_MISSING」
// という不整合が起きる。

import type { ProviderConnectionProvider } from '@org-ai/shared-types';

/** RequiredCredential.provider → ProviderConnection.provider */
export const NATIVE_PROVIDER_MAP: Record<string, ProviderConnectionProvider> = {
  slack: 'slack',
  googledocs: 'google',
  googlesheets: 'google',
  googleslides: 'google',
};

/** ProviderConnection.provider → RequiredCredential.provider[]（接続/解除時の status 同期用） */
export function credentialProvidersFor(provider: ProviderConnectionProvider): string[] {
  return Object.entries(NATIVE_PROVIDER_MAP)
    .filter(([, v]) => v === provider)
    .map(([k]) => k);
}

export function nativeProviderFor(credentialProvider: string): ProviderConnectionProvider | null {
  return NATIVE_PROVIDER_MAP[credentialProvider] ?? null;
}
