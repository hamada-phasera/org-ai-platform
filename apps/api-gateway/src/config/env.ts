// api-gateway が読む環境変数の一覧と、その既定値の唯一の定義場所。
//
// ■ 方針
//   * **読むたびに process.env を読み直す**（キャッシュしない）。テストは env を書き換えたり
//     process.env ごと差し替えたりするので、値を握り込むと壊れる。モジュール読み込み時に
//     値を確定させたい呼び出し側は、従来どおりトップレベルの const で受けること（評価タイミングは不変）。
//   * 検証は「文字列か未設定か」だけに留める。不正値で起動を止める等の新しい挙動は足さない
//     （数値は従来どおり Number()/parseInt() に通すので、不正値は NaN のまま流れる）。
//   * 既定値は移行前のコードと**完全に同じ**にしてある。`??` と `||` の違い
//     （空文字を未設定とみなすか）もそのまま写している。変えるときは呼び出し元の挙動も確認すること。
//   * 秘密の値をログやレスポンスに出さないこと。

import { z } from 'zod';

const optional = z.string().optional();

export const envSchema = z.object({
  NODE_ENV: optional,
  PORT: optional,
  /** 前に立つプロキシの段数（Render は 1）。レート制限の IP を X-Forwarded-For から取る */
  TRUST_PROXY_HOPS: optional,

  // 認証
  JWT_SECRET: optional,
  JWT_EXPIRES_IN: optional,
  OAUTH_STATE_SECRET: optional,
  INVITE_TTL_DAYS: optional,

  // CORS / 自分自身の URL
  FRONTEND_URL: optional,
  ALLOWED_ORIGIN_HOSTS: optional,
  VERCEL_PREVIEW_SUFFIX: optional,
  API_GATEWAY_URL: optional,

  // DB / ファイル
  DATABASE_URL: optional,
  FILES_DIR: optional,
  SUPABASE_URL: optional,
  SUPABASE_SERVICE_ROLE_KEY: optional,
  SUPABASE_STORAGE_BUCKET: optional,

  // ai-engine
  AI_ENGINE_URL: optional,
  INTERNAL_API_TOKEN: optional,

  // n8n
  N8N_CLOUD_URL: optional,
  N8N_URL: optional,
  N8N_API_KEY: optional,
  N8N_WEBHOOK_AUTH_TOKEN: optional,
  N8N_TIMEOUT_MS: optional,
  N8N_CALLBACK_ORG_REQUIRED: optional,

  // RLS Phase 2a（docs/design/multi-tenancy.md §RLS Phase 2a）。off | on
  RLS_MODE: optional,

  // 連携
  CHANNEL_CREDENTIAL_ENC_KEY: optional,
  GOOGLE_OAUTH_CLIENT_ID: optional,
  GOOGLE_OAUTH_CLIENT_SECRET: optional,
  ADMIN_SLACK_CHANNEL: optional,
  CAPABILITY_CONFIDENCE_THRESHOLD: optional,

  // カスタム HTTP ノード
  HTTP_NODE_ENABLED: optional,
  HTTP_NODE_TIMEOUT_MS: optional,
  HTTP_NODE_MAX_RESPONSE_BYTES: optional,
  HTTP_NODE_RATE_PER_MIN: optional,
  HTTP_NODE_BLOCKED_HOSTS: optional,
  HTTP_NODE_ALLOWED_PORTS: optional,

  // RAG（埋め込み）
  EMBEDDING_PROVIDER: optional,
  EMBEDDING_API_KEY: optional,
  EMBEDDING_MODEL: optional,
  EMBEDDING_DIM: optional,
  GEMINI_API_KEY: optional,
  /** ai-engine と同じ値。gateway は「セットアップ状況」の表示にだけ使う */
  GEMINI_PAID_TIER: optional,

  // 運用
  METRICS_URL: optional,
  SHUTDOWN_DRAIN_MS: optional,
  INTERNAL_SCHEDULER_ENABLED: optional,

  // 決済（Stripe）。組み立ては services/billing/billing-core.ts の billingConfigFromEnv
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  STRIPE_PRICE_STARTER_MONTHLY: optional,
  STRIPE_PRICE_STARTER_YEARLY: optional,
  STRIPE_PRICE_PRO_MONTHLY: optional,
  STRIPE_PRICE_PRO_YEARLY: optional,
  STRIPE_PRICE_MAX_MONTHLY: optional,
  STRIPE_PRICE_MAX_YEARLY: optional,
  STRIPE_PRICE_STORAGE_ADDON: optional,
  STRIPE_TAX_RATE_ID: optional,
  BILLING_TRIAL_DAYS: optional,
  APP_BASE_URL: optional,
});

export type Env = z.infer<typeof envSchema>;

/** いまの環境変数を読む。呼ぶたびに読み直す（上の方針を参照）。 */
export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}

/** 既定値。ここ以外に既定値を書かないこと。 */
export const ENV_DEFAULTS = {
  PORT: '4000',
  TRUST_PROXY_HOPS: 1,
  JWT_EXPIRES_IN: '24h',
  INVITE_TTL_DAYS: 7,
  FRONTEND_URL: 'http://localhost:3000',
  ALLOWED_ORIGIN_HOSTS: 'org-ai-platform.vercel.app',
  VERCEL_PREVIEW_SUFFIX: '-hamahiro1668s-projects.vercel.app',
  API_GATEWAY_URL: 'http://localhost:4000',
  /** 呼び出し元すべてで同じ。docker-compose では compose 側で http://ai-engine:8000 を渡す */
  AI_ENGINE_URL: 'http://localhost:8000',
  N8N_URL: 'http://localhost:5678',
  /** chat.ts のワークフロー一覧/実行だけが使う既定（N8N_URL は見ない）。 */
  N8N_CHAT_CLOUD_URL: 'https://hamahiro.app.n8n.cloud',
  N8N_WEBHOOK_AUTH_TOKEN: 'org-ai-n8n-secret-token',
  N8N_TIMEOUT_MS: 30_000,
  RLS_MODE: 'off',
  SUPABASE_STORAGE_BUCKET: 'org-files',
  ADMIN_SLACK_CHANNEL: '#org-ai-admin',
  CAPABILITY_CONFIDENCE_THRESHOLD: 0.7,
  HTTP_NODE_TIMEOUT_MS: 15_000,
  HTTP_NODE_MAX_RESPONSE_BYTES: 256 * 1024,
  HTTP_NODE_RATE_PER_MIN: 60,
  EMBEDDING_PROVIDER: 'gemini',
  EMBEDDING_DIM: 1024,
  METRICS_URL: 'http://localhost:8080',
  SHUTDOWN_DRAIN_MS: 20_000,
  /** 登録時トライアル（カード不要）と Checkout のトライアルの日数 */
  BILLING_TRIAL_DAYS: 30,
} as const;

/** 'false' のときだけ無効。未設定・その他の値は有効（従来の `(X ?? 'true') === 'false'` と同じ）。 */
function enabledUnlessFalse(value: string | undefined): boolean {
  return (value ?? 'true') !== 'false';
}

/**
 * 型付きの設定値。すべて getter なので、参照した時点の process.env を反映する。
 * 呼び出し元ごとに既定値が違うもの（n8n の chat 用 URL）は別の名前で持つ。
 */
export const config = {
  get nodeEnv(): string | undefined {
    return readEnv().NODE_ENV;
  },
  get isProduction(): boolean {
    return readEnv().NODE_ENV === 'production';
  },
  get port(): number {
    return parseInt(readEnv().PORT ?? ENV_DEFAULTS.PORT);
  },
  /**
   * Fastify の trustProxy に渡す段数。0 なら転送ヘッダを信じない。数でない・負の値は既定（1）。
   * ⚠️ true（全部信じる）にはしない。利用者が X-Forwarded-For を書いてレート制限をすり抜けられるため。
   */
  get trustProxyHops(): number {
    const raw = readEnv().TRUST_PROXY_HOPS;
    const n = Number(raw);
    return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : ENV_DEFAULTS.TRUST_PROXY_HOPS;
  },

  // ── 認証 ──
  get jwtSecret(): string | undefined {
    return readEnv().JWT_SECRET;
  },
  get jwtExpiresIn(): string {
    return readEnv().JWT_EXPIRES_IN ?? ENV_DEFAULTS.JWT_EXPIRES_IN;
  },
  get oauthStateSecret(): string | undefined {
    return readEnv().OAUTH_STATE_SECRET;
  },
  get inviteTtlDays(): number {
    return Number(readEnv().INVITE_TTL_DAYS ?? ENV_DEFAULTS.INVITE_TTL_DAYS);
  },

  // ── URL / CORS ──
  /** 生の FRONTEND_URL（カンマ区切り）。未設定時の扱いは呼び出し元ごとに違うので既定値は付けない。 */
  get frontendUrlRaw(): string | undefined {
    return readEnv().FRONTEND_URL;
  },
  get allowedOriginHosts(): string[] {
    return (readEnv().ALLOWED_ORIGIN_HOSTS ?? ENV_DEFAULTS.ALLOWED_ORIGIN_HOSTS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  },
  get vercelPreviewSuffix(): string {
    return readEnv().VERCEL_PREVIEW_SUFFIX ?? ENV_DEFAULTS.VERCEL_PREVIEW_SUFFIX;
  },
  /** 自分自身の公開 URL（末尾スラッシュはそのまま）。 */
  get apiGatewayUrl(): string {
    return readEnv().API_GATEWAY_URL ?? ENV_DEFAULTS.API_GATEWAY_URL;
  },

  // ── DB / ファイル ──
  get databaseUrl(): string | undefined {
    return readEnv().DATABASE_URL;
  },
  get filesDir(): string | undefined {
    return readEnv().FILES_DIR;
  },
  get supabaseUrl(): string | undefined {
    return readEnv().SUPABASE_URL;
  },
  get supabaseServiceRoleKey(): string | undefined {
    return readEnv().SUPABASE_SERVICE_ROLE_KEY;
  },
  get supabaseStorageBucket(): string {
    return readEnv().SUPABASE_STORAGE_BUCKET ?? ENV_DEFAULTS.SUPABASE_STORAGE_BUCKET;
  },

  // ── ai-engine ──
  get aiEngineUrl(): string {
    return readEnv().AI_ENGINE_URL ?? ENV_DEFAULTS.AI_ENGINE_URL;
  },
  get internalApiToken(): string | undefined {
    return readEnv().INTERNAL_API_TOKEN;
  },

  // ── n8n ──
  /** N8N_CLOUD_URL → N8N_URL → localhost の順（末尾スラッシュはそのまま）。 */
  get n8nUrl(): string {
    const env = readEnv();
    return env.N8N_CLOUD_URL ?? env.N8N_URL ?? ENV_DEFAULTS.N8N_URL;
  },
  /** chat.ts 用。N8N_URL は見ず、既定は n8n cloud。 */
  get n8nChatCloudUrl(): string {
    return readEnv().N8N_CLOUD_URL ?? ENV_DEFAULTS.N8N_CHAT_CLOUD_URL;
  },
  get n8nApiKey(): string {
    return readEnv().N8N_API_KEY ?? '';
  },
  get n8nWebhookAuthToken(): string {
    return readEnv().N8N_WEBHOOK_AUTH_TOKEN ?? ENV_DEFAULTS.N8N_WEBHOOK_AUTH_TOKEN;
  },
  /**
   * n8n コールバック（task-complete / task-log / scheduled-job-complete）の body に orgId を必須にするか。
   * 'true' のときだけ必須。既定は移行期間（orgId が無い古いワークフローは警告を出して通す）。
   * orgId が**ある**ときは既定でも照合し、食い違えば 404 にする（docs/design/multi-tenancy.md E1 / Q6）。
   */
  get n8nCallbackOrgRequired(): boolean {
    return readEnv().N8N_CALLBACK_ORG_REQUIRED === 'true';
  },
  /**
   * RLS Phase 2a。'on'（前後空白・大文字小文字は無視）のときだけ、AILog / RiskEvent / FileChunk / MessageEmbedding と
   * raw SQL を 1 トランザクションに包み、先頭で set_config('app.org_id', orgId, true) を呼ぶ（tenancy/tenant-db.ts）。
   * それ以外の値・未設定は off（従来どおり）。on にするのは packages/db-schema/rls/phase2a.sql を流して
   * 接続ユーザーを flow_app に替えてから。
   */
  get rlsMode(): 'off' | 'on' {
    return (readEnv().RLS_MODE ?? ENV_DEFAULTS.RLS_MODE).trim().toLowerCase() === 'on' ? 'on' : 'off';
  },
  /** N8N_WEBHOOK_AUTH_TOKEN が未設定（＝公開されている既定値のまま）か。 */
  get n8nWebhookAuthTokenIsDefault(): boolean {
    const v = readEnv().N8N_WEBHOOK_AUTH_TOKEN;
    return v === undefined || v === ENV_DEFAULTS.N8N_WEBHOOK_AUTH_TOKEN;
  },
  get n8nTimeoutMs(): number {
    return Number(readEnv().N8N_TIMEOUT_MS ?? ENV_DEFAULTS.N8N_TIMEOUT_MS);
  },

  // ── 連携 ──
  get channelCredentialEncKey(): string | undefined {
    return readEnv().CHANNEL_CREDENTIAL_ENC_KEY;
  },
  get googleOAuthClientId(): string | undefined {
    return readEnv().GOOGLE_OAUTH_CLIENT_ID;
  },
  get googleOAuthClientSecret(): string | undefined {
    return readEnv().GOOGLE_OAUTH_CLIENT_SECRET;
  },
  get adminSlackChannel(): string {
    return readEnv().ADMIN_SLACK_CHANNEL ?? ENV_DEFAULTS.ADMIN_SLACK_CHANNEL;
  },
  get capabilityConfidenceThreshold(): number {
    return Number(readEnv().CAPABILITY_CONFIDENCE_THRESHOLD ?? ENV_DEFAULTS.CAPABILITY_CONFIDENCE_THRESHOLD);
  },

  // ── カスタム HTTP ノード ──
  get httpNodeEnabled(): boolean {
    return enabledUnlessFalse(readEnv().HTTP_NODE_ENABLED);
  },
  get httpNodeTimeoutMs(): number {
    return Number(readEnv().HTTP_NODE_TIMEOUT_MS ?? ENV_DEFAULTS.HTTP_NODE_TIMEOUT_MS);
  },
  get httpNodeMaxResponseBytes(): number {
    return Number(readEnv().HTTP_NODE_MAX_RESPONSE_BYTES ?? ENV_DEFAULTS.HTTP_NODE_MAX_RESPONSE_BYTES);
  },
  get httpNodeRatePerMin(): number {
    return Number(readEnv().HTTP_NODE_RATE_PER_MIN ?? ENV_DEFAULTS.HTTP_NODE_RATE_PER_MIN);
  },
  /** 運用で足す拒否ホスト（カンマ区切りの生値。空文字なら空）。 */
  get httpNodeBlockedHostsRaw(): string {
    return readEnv().HTTP_NODE_BLOCKED_HOSTS ?? '';
  },
  /** 許可ポート（カンマ区切りの生値）。空白だけ・空文字は未設定扱い。 */
  get httpNodeAllowedPortsRaw(): string | undefined {
    return readEnv().HTTP_NODE_ALLOWED_PORTS?.trim() || undefined;
  },

  // ── RAG（埋め込み） ──
  get embeddingProvider(): string {
    return (readEnv().EMBEDDING_PROVIDER ?? ENV_DEFAULTS.EMBEDDING_PROVIDER).toLowerCase();
  },
  get embeddingApiKey(): string | undefined {
    return readEnv().EMBEDDING_API_KEY;
  },
  get embeddingModel(): string | undefined {
    return readEnv().EMBEDDING_MODEL;
  },
  get embeddingDim(): number {
    return Number(readEnv().EMBEDDING_DIM ?? ENV_DEFAULTS.EMBEDDING_DIM);
  },
  get geminiApiKey(): string | undefined {
    return readEnv().GEMINI_API_KEY;
  },
  /** 1 / true / yes（ai-engine の settings.gemini_paid_tier と同じ判定）。無料枠は入力が Google の製品改善に使われる。 */
  get geminiPaidTier(): boolean {
    return ['1', 'true', 'yes'].includes(readEnv().GEMINI_PAID_TIER?.trim().toLowerCase() ?? '');
  },

  // ── 運用 ──
  /** 空文字も未設定扱い（従来の `||`）。末尾スラッシュは除く。 */
  get metricsUrl(): string {
    return (readEnv().METRICS_URL || ENV_DEFAULTS.METRICS_URL).replace(/\/+$/, '');
  },
  get shutdownDrainMs(): number {
    return Number(readEnv().SHUTDOWN_DRAIN_MS ?? ENV_DEFAULTS.SHUTDOWN_DRAIN_MS);
  },
  get internalSchedulerEnabled(): boolean {
    return enabledUnlessFalse(readEnv().INTERNAL_SCHEDULER_ENABLED);
  },

  // ── 決済 ──
  /**
   * 決済が設定されているか。STRIPE_SECRET_KEY と梅の月額 price（STRIPE_PRICE_STARTER_MONTHLY）の両方があるときだけ。
   * 未設定の環境ではトライアル切れでも止めない。⚠️ キーだけで price が無いと、期限切れの組織が閲覧のみになるのに
   * 契約もできない詰みになるため、price も見る（計画書 §7 オーケストレーター追記）。
   */
  get billingConfigured(): boolean {
    const env = readEnv();
    return !!env.STRIPE_SECRET_KEY?.trim() && !!env.STRIPE_PRICE_STARTER_MONTHLY?.trim();
  },
  /** トライアルの日数。数でない・負の値は既定に戻す。 */
  get billingTrialDays(): number {
    const raw = readEnv().BILLING_TRIAL_DAYS;
    const n = Number(raw ?? ENV_DEFAULTS.BILLING_TRIAL_DAYS);
    return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0
      ? Math.floor(n)
      : ENV_DEFAULTS.BILLING_TRIAL_DAYS;
  },
};
