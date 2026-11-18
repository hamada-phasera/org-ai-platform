import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const currentDriverName = vi.fn();
const storageGet = vi.fn();
vi.mock('../../src/services/storage/driver', () => ({
  currentDriverName: () => currentDriverName(),
  readDriver: () => ({ get: storageGet }),
  writeDriver: () => ({ get: storageGet }),
}));
vi.mock('../../src/services/ai-engine-auth', () => ({
  aiEngineHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

const { collectSetupStatus } = await import('../../src/services/setup-status');

const TOKEN = ['unit', 'test', 'token'].join('-');
const ENV_KEYS = [
  'INTERNAL_API_TOKEN', 'AI_ENGINE_URL', 'EMBEDDING_API_KEY', 'GEMINI_API_KEY', 'GEMINI_PAID_TIER',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_TAX_RATE_ID', 'STRIPE_PRICE_STORAGE_ADDON',
  'STRIPE_PRICE_STARTER_MONTHLY', 'STRIPE_PRICE_STARTER_YEARLY', 'STRIPE_PRICE_PRO_MONTHLY',
  'STRIPE_PRICE_PRO_YEARLY', 'STRIPE_PRICE_MAX_MONTHLY', 'STRIPE_PRICE_MAX_YEARLY',
  'N8N_CLOUD_URL', 'N8N_URL', 'N8N_WEBHOOK_AUTH_TOKEN',
];

const fetchMock = vi.fn();
const item = (items: Awaited<ReturnType<typeof collectSetupStatus>>, key: string) =>
  items.find((i) => i.key === key)!;

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  vi.stubGlobal('fetch', fetchMock);
  currentDriverName.mockReturnValue('supabase');
  storageGet.mockResolvedValue(null);
  // 既定は「本文の検証まで到達した」= 認証は通っている
  fetchMock.mockResolvedValue(new Response('{}', { status: 422 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('保存先', () => {
  it('ローカル保存はエラー扱い（デプロイのたびに消えるため）', async () => {
    currentDriverName.mockReturnValue('local');
    const s = item(await collectSetupStatus(), 'storage');
    expect(s.health).toBe('error');
    expect(s.detail).toContain('消えます');
    expect(s.action).toContain('SUPABASE_URL');
  });

  it('実際に読みに行けたら ok（環境変数の有無だけで判定しない）', async () => {
    const s = item(await collectSetupStatus(), 'storage');
    expect(s.health).toBe('ok');
    expect(storageGet).toHaveBeenCalled();
  });

  it('鍵やバケットが違って例外になったらエラーにする', async () => {
    storageGet.mockRejectedValue(new Error('ストレージからの取得に失敗しました (HTTP 400)'));
    const s = item(await collectSetupStatus(), 'storage');
    expect(s.health).toBe('error');
    expect(s.detail).toContain('HTTP 400');
    expect(s.action).toContain('org-files');
  });
});

describe('AI エンジンの保護', () => {
  it('トークン未設定なら、誰でも叩ける状態としてエラーにする', async () => {
    const s = item(await collectSetupStatus(), 'aiEngine');
    expect(s.health).toBe('error');
    expect(s.detail).toContain('誰でも');
    expect(s.action).toContain('両方');
  });

  it('双方のトークンが一致していれば ok', async () => {
    process.env.INTERNAL_API_TOKEN = TOKEN;
    const s = item(await collectSetupStatus(), 'aiEngine');
    expect(s.health).toBe('ok');
  });

  it('401 が返るのは食い違い。AI が全部失敗するのでエラーにする', async () => {
    process.env.INTERNAL_API_TOKEN = TOKEN;
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    const s = item(await collectSetupStatus(), 'aiEngine');
    expect(s.health).toBe('error');
    expect(s.detail).toContain('一致していません');
  });

  it('トークンを設定済みで接続できなければ unknown（設定の問題と断定しない）', async () => {
    process.env.INTERNAL_API_TOKEN = TOKEN;
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const s = item(await collectSetupStatus(), 'aiEngine');
    expect(s.health).toBe('unknown');
  });

  it('トークン未設定は、接続できなくても「要対応」（未設定は確かめなくても分かる。チャンク 7）', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const s = item(await collectSetupStatus(), 'aiEngine');
    expect(s.health).toBe('error');
    expect(s.detail).toContain('INTERNAL_API_TOKEN');
  });

  it('確認のために LLM を呼ばない（空の本文を1回だけ投げる）', async () => {
    await collectSetupStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/llm/chat');
    expect(init.body).toBe('{}');
  });
});

describe('決済', () => {
  const configureStripe = (full: boolean) => {
    process.env.STRIPE_SECRET_KEY = ['sk', 'test', 'unit'].join('_');
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_s_m';
    if (!full) return;
    process.env.STRIPE_WEBHOOK_SECRET = ['whsec', 'unit'].join('_');
    process.env.STRIPE_PRICE_STARTER_YEARLY = 'price_s_y';
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_p_m';
    process.env.STRIPE_PRICE_PRO_YEARLY = 'price_p_y';
    process.env.STRIPE_PRICE_MAX_MONTHLY = 'price_x_m';
    process.env.STRIPE_PRICE_MAX_YEARLY = 'price_x_y';
    process.env.STRIPE_TAX_RATE_ID = 'txr_jp10';
    process.env.STRIPE_PRICE_STORAGE_ADDON = 'price_addon';
  };

  it('未設定は warn（他の機能は動くのでエラーにしない）', async () => {
    const s = item(await collectSetupStatus(), 'billing');
    expect(s.health).toBe('warn');
    expect(s.detail).toContain('準備中');
  });

  it('途中まで設定なら、足りないものを並べる', async () => {
    configureStripe(false);
    const s = item(await collectSetupStatus(), 'billing');
    expect(s.health).toBe('warn');
    expect(s.detail).toContain('1/6');
    expect(s.detail).toContain('webhook');
    expect(s.detail).toContain('消費税');
  });

  it('全部そろえば ok', async () => {
    configureStripe(true);
    expect(item(await collectSetupStatus(), 'billing').health).toBe('ok');
  });
});

describe('Gemini の利用区分', () => {
  it('GEMINI_PAID_TIER 未設定・false は「要対応」（無料枠は入力が製品改善に使われる）', async () => {
    expect(item(await collectSetupStatus(), 'geminiTier').health).toBe('error');
    process.env.GEMINI_PAID_TIER = 'false';
    const s = item(await collectSetupStatus(), 'geminiTier');
    expect(s.health).toBe('error');
    expect(s.action).toContain('GEMINI_PAID_TIER');
  });

  it.each(['true', 'TRUE', '1', 'yes'])('%s なら ok（ai-engine と同じ判定）', async (v) => {
    process.env.GEMINI_PAID_TIER = v;
    expect(item(await collectSetupStatus(), 'geminiTier').health).toBe('ok');
  });
});

describe('ファイル検索', () => {
  it('鍵が無ければ warn', async () => {
    expect(item(await collectSetupStatus(), 'embeddings').health).toBe('warn');
  });

  it('GEMINI_API_KEY でも有効になる', async () => {
    process.env.GEMINI_API_KEY = 'unit-test-key';
    expect(item(await collectSetupStatus(), 'embeddings').health).toBe('ok');
  });
});

describe('業務ページの接続', () => {
  const N8N_TOKEN = ['n8n', 'unit', 'token'].join('-');
  const configure = () => {
    process.env.N8N_CLOUD_URL = 'https://n8n.example.test/';
    process.env.N8N_WEBHOOK_AUTH_TOKEN = N8N_TOKEN;
  };
  const healthCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/healthz'));

  it('n8n が未設定なら warn で、n8n には何も投げない', async () => {
    const s = item(await collectSetupStatus(), 'pages');
    expect(s.health).toBe('warn');
    expect(s.detail).toContain('未接続');
    expect(s.action).toContain('N8N_CLOUD_URL');
    expect(healthCalls()).toHaveLength(0);
  });

  it('共有トークンが既定値のままなら要対応（接続は確かめない）', async () => {
    process.env.N8N_CLOUD_URL = 'https://n8n.example.test';
    const s = item(await collectSetupStatus(), 'pages');
    expect(s.health).toBe('error');
    expect(s.action).toContain('N8N_WEBHOOK_AUTH_TOKEN');
    expect(healthCalls()).toHaveLength(0);
  });

  it('/healthz を GET 1 回だけ叩き（Webhook は叩かない・リダイレクトを追わない）、通れば ok', async () => {
    configure();
    fetchMock.mockImplementation(async (url: string) =>
      new Response('{}', { status: String(url).includes('/healthz') ? 200 : 422 }),
    );
    const s = item(await collectSetupStatus(), 'pages');
    expect(s.health).toBe('ok');
    const calls = healthCalls();
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toBe('https://n8n.example.test/healthz');
    expect(calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/webhook/'))).toBe(false);
  });

  it.each([
    ['非 2xx', () => fetchMock.mockImplementation(async () => new Response('', { status: 503 }))],
    ['接続できない', () => fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))],
  ])('%s なら「確認できず」', async (_name, arrange) => {
    configure();
    arrange();
    expect(item(await collectSetupStatus(), 'pages').health).toBe('unknown');
  });

  it('⚠️ n8n の URL もトークンも応答に出さない', async () => {
    configure();
    const body = JSON.stringify(await collectSetupStatus());
    expect(body).not.toContain('n8n.example.test');
    expect(body).not.toContain(N8N_TOKEN);
  });
});

describe('安全性', () => {
  it('⚠️ 応答に秘密の値を含めない', async () => {
    process.env.INTERNAL_API_TOKEN = TOKEN;
    process.env.STRIPE_SECRET_KEY = ['sk', 'test', 'unit'].join('_');
    process.env.GEMINI_API_KEY = 'gemini-unit-test-key';
    const body = JSON.stringify(await collectSetupStatus());
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain('sk_test_unit');
    expect(body).not.toContain('gemini-unit-test-key');
  });
});
