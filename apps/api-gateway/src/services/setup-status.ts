// 本番の設定が入っているかを実際に確かめる。
//
// ⚠️ 「環境変数が入っているか」だけでは足りない。値が間違っていても入ってはいるので、
//    保存先は実際に読みに行き、ai-engine には実際に1回投げて確かめる。
// ⚠️ 秘密は返さない。返すのは状態と、人が読んで次の一手が分かる説明だけ。
// ⚠️ オーナー専用。設定の穴（トークン未設定など）は攻撃側に有用な情報になる。

import { billingConfigFromEnv, INTERNALS_FOR_TEST } from './billing/billing-core';
import { aiEngineHeaders } from './ai-engine-auth';
import { currentDriverName, readDriver } from './storage/driver';
import { config } from '../config/env';

export type Health = 'ok' | 'warn' | 'error' | 'unknown';

export interface SetupItem {
  key: 'storage' | 'aiEngine' | 'billing' | 'embeddings' | 'geminiTier' | 'pages';
  label: string;
  health: Health;
  detail: string;
  /** 直し方。ok のときは空 */
  action: string;
}

/** 保存先が実際に読めるか。鍵が違えば例外になる（入っているだけでは通らない）。 */
async function checkStorage(): Promise<SetupItem> {
  const driver = currentDriverName();
  if (driver === 'local') {
    return {
      key: 'storage',
      label: 'ファイルの保存先',
      health: 'error',
      detail: 'ローカルディスクに保存しています。デプロイのたびにアップロードしたファイルが消えます。',
      action: 'Render の api-gateway に SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定してください。',
    };
  }
  try {
    // 存在しないキーを引く。到達できれば null、鍵やバケットが違えば例外になる
    await readDriver('supabase').get('__setup-check__/probe');
    return { key: 'storage', label: 'ファイルの保存先', health: 'ok', detail: 'Supabase Storage に接続できています。', action: '' };
  } catch (e) {
    return {
      key: 'storage',
      label: 'ファイルの保存先',
      health: 'error',
      detail: `Supabase Storage に接続できません（${e instanceof Error ? e.message : '原因不明'}）。`,
      action: 'SUPABASE_SERVICE_ROLE_KEY と、バケット org-files が存在するかを確認してください。',
    };
  }
}

/**
 * ai-engine が無認証で叩ける状態になっていないか。
 *
 * 空のリクエストを1回投げるだけで、LLM は呼ばれない（本文の検証で弾かれる）。
 *   401 → 双方のトークンが食い違っている
 *   422/400 → 本文の検証まで到達した = 認証は通った（こちらが未設定なら「誰でも通る」状態）
 */
async function checkAiEngine(): Promise<SetupItem> {
  const tokenConfigured = !!config.internalApiToken?.trim();
  const base = config.aiEngineUrl;
  const label = 'AI エンジンの保護';

  const unsetItem: SetupItem = {
    key: 'aiEngine',
    label,
    health: 'error',
    detail: 'INTERNAL_API_TOKEN が未設定です。AI エンジンの公開 URL を知っている人が誰でも AI を呼べ、その費用はこちら持ちになります。',
    action: 'openssl rand -hex 32 で作った同じ値を、api-gateway と ai-engine の両方に設定してください。',
  };

  let status: number;
  try {
    const res = await fetch(`${base}/llm/chat`, {
      method: 'POST',
      headers: aiEngineHeaders(),
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
  } catch {
    // 未設定はつながらなくても分かる（「確認できず」で隠さない）
    if (!tokenConfigured) return unsetItem;
    return {
      key: 'aiEngine',
      label,
      health: 'unknown',
      detail: 'AI エンジンに接続できず、確認できませんでした。',
      action: 'AI_ENGINE_URL と、ai-engine が起動しているかを確認してください。',
    };
  }

  if (status === 401) {
    return {
      key: 'aiEngine',
      label,
      health: 'error',
      detail: 'トークンが一致していません。AI の実行が全部失敗します。',
      action: 'api-gateway と ai-engine の INTERNAL_API_TOKEN に同じ値を設定してください。',
    };
  }
  if (!tokenConfigured) return unsetItem;
  return { key: 'aiEngine', label, health: 'ok', detail: 'トークンで保護されています。', action: '' };
}

function checkBilling(): SetupItem {
  const billing = billingConfigFromEnv();
  const label = '決済（Stripe）';
  if (!billing) {
    return {
      key: 'billing',
      label,
      health: 'warn',
      detail: '未設定です。プラン画面は「準備中」と表示され、申し込みはできません。',
      action: 'docs/billing.md の手順で Stripe 側を用意し、STRIPE_SECRET_KEY などを設定してください。',
    };
  }
  const prices = INTERNALS_FOR_TEST.allPriceIds(billing);
  const missing = prices.filter((p) => !p).length;
  const problems: string[] = [];
  if (!billing.webhookSecret) problems.push('webhook の署名鍵が未設定（契約状態が反映されません）');
  if (missing > 0) problems.push(`価格が ${prices.length - missing}/${prices.length} 件しか設定されていません`);
  if (!billing.taxRateId) problems.push('消費税の税率が未設定（税が上乗せされません）');
  if (!billing.storageAddonPrice) problems.push('追加ストレージの価格が未設定');

  if (problems.length === 0) {
    return { key: 'billing', label, health: 'ok', detail: '価格・税率・webhook がそろっています。', action: '' };
  }
  return {
    key: 'billing',
    label,
    health: 'warn',
    detail: problems.join(' / '),
    action: 'docs/billing.md の「Stripe ダッシュボードで用意するもの」を確認してください。',
  };
}

function checkEmbeddings(): SetupItem {
  const configured = !!(config.embeddingApiKey?.trim() || config.geminiApiKey?.trim());
  return configured
    ? { key: 'embeddings', label: 'ファイル検索（RAG）', health: 'ok', detail: '埋め込みの生成が有効です。', action: '' }
    : {
        key: 'embeddings',
        label: 'ファイル検索（RAG）',
        health: 'warn',
        detail: '埋め込みの鍵が無いため、アップロードしたファイルを根拠にした回答ができません。',
        action: 'EMBEDDING_API_KEY（無ければ GEMINI_API_KEY）を設定してください。',
      };
}

/**
 * Gemini の無料枠のまま有料のお客さまを乗せていないか（CLAUDE.md「GEMINI_PAID_TIER」）。
 * 値は ai-engine と同じものを gateway にも入れる前提（render.yaml は両方に置いてある）。
 */
function checkGeminiTier(): SetupItem {
  const label = 'Gemini の利用区分';
  if (config.geminiPaidTier) {
    return { key: 'geminiTier', label, health: 'ok', detail: '有料枠です。', action: '' };
  }
  return {
    key: 'geminiTier',
    label,
    health: 'error',
    detail: '無料枠のままです。梅・竹プランの入力が Google の製品改善に使われることがあります。',
    action: 'Google AI Studio で有料課金に切り替え、api-gateway と ai-engine の GEMINI_PAID_TIER を true にしてください。',
  };
}

/**
 * 業務ページの接続（docs/design/custom-pages.md §7.4）。業務ページは ai-engine へフォールバックしないので（K8）、
 * n8n が無いとデータ部が「未接続」になる。
 *
 * 宛先が明示されていれば n8n の `/healthz` を 1 回だけ GET する（Webhook は叩かない＝ワークフローは動かない）。
 * ⚠️ 宛先の URL・トークンの値は返さない。リダイレクトは追わない（宛先は環境変数だけ。T3）。
 */
async function checkPagesConnection(): Promise<SetupItem> {
  const label = '業務ページの接続';
  if (!config.n8nConfigured) {
    return {
      key: 'pages',
      label,
      health: 'warn',
      detail: 'n8n が未設定です。業務ページのデータと送信は「未接続」になります。',
      action: 'api-gateway に N8N_CLOUD_URL（または N8N_URL）と N8N_WEBHOOK_AUTH_TOKEN を設定してください。',
    };
  }
  if (config.n8nWebhookAuthTokenIsDefault) {
    return {
      key: 'pages',
      label,
      health: 'error',
      detail: 'n8n の Webhook トークンが公開されている既定値のままです。',
      action: 'openssl rand -hex 32 で作った値を N8N_WEBHOOK_AUTH_TOKEN と n8n の credential「org-ai webhook token」に設定してください。',
    };
  }
  try {
    const res = await fetch(`${config.n8nUrl.replace(/\/+$/, '')}/healthz`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return { key: 'pages', label, health: 'ok', detail: 'n8n に接続できています。', action: '' };
  } catch {
    /* 下の「確認できず」 */
  }
  return {
    key: 'pages',
    label,
    health: 'unknown',
    detail: 'n8n に接続できず、確認できませんでした（起動中・スリープ中の可能性があります）。',
    action: 'N8N_CLOUD_URL（または N8N_URL）と、n8n が起動しているかを確認してください。',
  };
}

export async function collectSetupStatus(): Promise<SetupItem[]> {
  const [storage, aiEngine, pages] = await Promise.all([checkStorage(), checkAiEngine(), checkPagesConnection()]);
  return [aiEngine, storage, checkGeminiTier(), checkBilling(), checkEmbeddings(), pages];
}
