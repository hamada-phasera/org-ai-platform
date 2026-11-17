import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { config, readEnv, ENV_DEFAULTS } from '../env';

const SAVED = { ...process.env };

beforeEach(() => {
  process.env = {};
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe('readEnv', () => {
  it('知らないキーは落とし、知っているキーだけを返す', () => {
    const env = readEnv({ AI_ENGINE_URL: 'https://ai.test', SOMETHING_ELSE: 'x' });
    expect(env).toEqual({ AI_ENGINE_URL: 'https://ai.test' });
  });

  it('引数なしなら process.env を読む（差し替えにも追従する）', () => {
    process.env = { PORT: '1234' };
    expect(readEnv().PORT).toBe('1234');
  });
});

describe('config: 既定値（移行前と同じ）', () => {
  it.each([
    ['port', 4000],
    ['jwtExpiresIn', '24h'],
    ['inviteTtlDays', 7],
    ['apiGatewayUrl', 'http://localhost:4000'],
    ['aiEngineUrl', 'http://localhost:8000'],
    ['n8nUrl', 'http://localhost:5678'],
    ['n8nChatCloudUrl', ENV_DEFAULTS.N8N_CHAT_CLOUD_URL],
    ['n8nApiKey', ''],
    ['n8nWebhookAuthToken', 'org-ai-n8n-secret-token'],
    ['n8nTimeoutMs', 30_000],
    ['supabaseStorageBucket', 'org-files'],
    ['adminSlackChannel', '#org-ai-admin'],
    ['capabilityConfidenceThreshold', 0.7],
    ['httpNodeEnabled', true],
    ['httpNodeTimeoutMs', 15_000],
    ['httpNodeMaxResponseBytes', 256 * 1024],
    ['httpNodeRatePerMin', 60],
    ['httpNodeBlockedHostsRaw', ''],
    ['httpNodeAllowedPortsRaw', undefined],
    ['embeddingProvider', 'gemini'],
    ['embeddingDim', 1024],
    ['metricsUrl', 'http://localhost:8080'],
    ['shutdownDrainMs', 20_000],
    ['internalSchedulerEnabled', true],
    ['isProduction', false],
    ['jwtSecret', undefined],
    ['frontendUrlRaw', undefined],
    ['vercelPreviewSuffix', ENV_DEFAULTS.VERCEL_PREVIEW_SUFFIX],
  ] as const)('%s → %j', (key, expected) => {
    expect(config[key]).toEqual(expected);
  });

  it('allowedOriginHosts は既定の本番ホスト 1 件', () => {
    expect(config.allowedOriginHosts).toEqual(['org-ai-platform.vercel.app']);
  });
});

describe('config: 値の読み方', () => {
  it('getter は参照のたびに読み直す（テストの env 書き換えに追従）', () => {
    process.env.AI_ENGINE_URL = 'https://a.test';
    expect(config.aiEngineUrl).toBe('https://a.test');
    process.env.AI_ENGINE_URL = 'https://b.test';
    expect(config.aiEngineUrl).toBe('https://b.test');
  });

  it('n8nUrl は N8N_CLOUD_URL を N8N_URL より優先する', () => {
    process.env.N8N_URL = 'https://self.test';
    expect(config.n8nUrl).toBe('https://self.test');
    process.env.N8N_CLOUD_URL = 'https://cloud.test';
    expect(config.n8nUrl).toBe('https://cloud.test');
  });

  it('n8nChatCloudUrl は N8N_URL を見ない（従来どおり）', () => {
    process.env.N8N_URL = 'https://self.test';
    expect(config.n8nChatCloudUrl).toBe(ENV_DEFAULTS.N8N_CHAT_CLOUD_URL);
  });

  it('?? の項目は空文字を「設定済み」として扱う', () => {
    process.env.AI_ENGINE_URL = '';
    expect(config.aiEngineUrl).toBe('');
  });

  it('METRICS_URL は空文字なら既定に落ち（||）、末尾スラッシュを除く', () => {
    process.env.METRICS_URL = '';
    expect(config.metricsUrl).toBe('http://localhost:8080');
    process.env.METRICS_URL = 'https://m.test///';
    expect(config.metricsUrl).toBe('https://m.test');
  });

  it("*_ENABLED は 'false' のときだけ無効", () => {
    process.env.HTTP_NODE_ENABLED = 'false';
    process.env.INTERNAL_SCHEDULER_ENABLED = '0';
    expect(config.httpNodeEnabled).toBe(false);
    expect(config.internalSchedulerEnabled).toBe(true);
  });

  it('HTTP_NODE_ALLOWED_PORTS は前後の空白を落とし、空なら未設定扱い', () => {
    process.env.HTTP_NODE_ALLOWED_PORTS = '   ';
    expect(config.httpNodeAllowedPortsRaw).toBeUndefined();
    process.env.HTTP_NODE_ALLOWED_PORTS = ' 443,8443 ';
    expect(config.httpNodeAllowedPortsRaw).toBe('443,8443');
  });

  it('EMBEDDING_PROVIDER は小文字にする', () => {
    process.env.EMBEDDING_PROVIDER = 'OpenAI';
    expect(config.embeddingProvider).toBe('openai');
  });

  it('数値は従来どおり Number()/parseInt() に通す（不正値は NaN のまま）', () => {
    process.env.SHUTDOWN_DRAIN_MS = 'abc';
    process.env.PORT = '8080abc';
    expect(config.shutdownDrainMs).toBeNaN();
    expect(config.port).toBe(8080);
  });

  it('allowedOriginHosts はカンマ区切りを trim し空要素を捨てる', () => {
    process.env.ALLOWED_ORIGIN_HOSTS = ' a.example.com, ,b.example.com ';
    expect(config.allowedOriginHosts).toEqual(['a.example.com', 'b.example.com']);
  });

  it('NODE_ENV=production で isProduction', () => {
    process.env.NODE_ENV = 'production';
    expect(config.isProduction).toBe(true);
    expect(config.nodeEnv).toBe('production');
  });

  it('billingConfigured はキーと梅の月額 price の両方があるときだけ true', () => {
    expect(config.billingConfigured).toBe(false);
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    expect(config.billingConfigured).toBe(false);
    process.env.STRIPE_PRICE_STARTER_MONTHLY = '  ';
    expect(config.billingConfigured).toBe(false);
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_s_m';
    expect(config.billingConfigured).toBe(true);
  });
});
