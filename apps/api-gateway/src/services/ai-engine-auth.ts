/**
 * ai-engine を呼ぶときの共通ヘッダ。
 *
 * ⚠️ ai-engine は Render の `type: web` で**公開 URL を持つ**。認証を1つも持たないと、
 *    URL を知っている第三者が `/llm/chat` や `/vision/receipt` を直接叩けてしまう:
 *      - Anthropic の課金がこちら持ちで発生する（画像入力は特に単価が高い）
 *      - `org_id` は検証されないので、他組織の id で AILog に行を書き込める
 *    ブラウザ向けの CORS は curl には効かないので、共有シークレットで塞ぐ。
 *
 * `INTERNAL_API_TOKEN` が未設定なら何も付けない。ai-engine 側も未設定なら素通しするので、
 * 「先に片方だけデプロイして全部落ちる」ことがない。**設定して初めて有効になる**。
 */
export function aiEngineHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = process.env.INTERNAL_API_TOKEN;
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'X-Internal-Token': token } : {}),
    ...extra,
  };
}
