import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertStartupConfig, StartupConfigError } from '../startup-checks';
import { ENV_DEFAULTS } from '../env';

// チャンク 7: 起動拒否（本番で n8n トークンが既定値・未設定なら起動しない）

const SAVED = { ...process.env };
const JWT = 'j'.repeat(32);
const N8N = ['unit', 'n8n', 'token'].join('-');

beforeEach(() => {
  process.env = { JWT_SECRET: JWT };
});
afterEach(() => {
  process.env = { ...SAVED };
});

describe('assertStartupConfig', () => {
  it('開発では n8n トークン未設定でも起動する', () => {
    process.env.NODE_ENV = 'development';
    expect(() => assertStartupConfig()).not.toThrow();
    delete process.env.NODE_ENV;
    expect(() => assertStartupConfig()).not.toThrow();
  });

  it('本番で n8n トークン未設定なら例外', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertStartupConfig()).toThrow(StartupConfigError);
    expect(() => assertStartupConfig()).toThrow(/N8N_WEBHOOK_AUTH_TOKEN/);
  });

  it('本番で n8n トークンが公開されている既定値・空なら例外', () => {
    process.env.NODE_ENV = 'production';
    process.env.N8N_WEBHOOK_AUTH_TOKEN = ENV_DEFAULTS.N8N_WEBHOOK_AUTH_TOKEN;
    expect(() => assertStartupConfig()).toThrow(StartupConfigError);
    process.env.N8N_WEBHOOK_AUTH_TOKEN = '   ';
    expect(() => assertStartupConfig()).toThrow(StartupConfigError);
  });

  it('本番でも独自の n8n トークンがあれば起動する', () => {
    process.env.NODE_ENV = 'production';
    process.env.N8N_WEBHOOK_AUTH_TOKEN = N8N;
    expect(() => assertStartupConfig()).not.toThrow();
  });

  it('JWT_SECRET が無い・32 文字未満なら環境を問わず例外', () => {
    delete process.env.JWT_SECRET;
    expect(() => assertStartupConfig()).toThrow(/JWT_SECRET/);
    process.env.JWT_SECRET = 'short';
    expect(() => assertStartupConfig()).toThrow(/JWT_SECRET/);
  });

  it('⚠️ 例外の文言に秘密の値を入れない', () => {
    process.env.NODE_ENV = 'production';
    process.env.N8N_WEBHOOK_AUTH_TOKEN = ENV_DEFAULTS.N8N_WEBHOOK_AUTH_TOKEN;
    try {
      assertStartupConfig();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(ENV_DEFAULTS.N8N_WEBHOOK_AUTH_TOKEN);
      expect((e as Error).message).not.toContain(JWT);
    }
  });
});

describe('config.trustProxyHops', () => {
  it('既定 1、数なら使う、不正値は既定', async () => {
    const { config } = await import('../env');
    expect(config.trustProxyHops).toBe(1);
    process.env.TRUST_PROXY_HOPS = '0';
    expect(config.trustProxyHops).toBe(0);
    process.env.TRUST_PROXY_HOPS = '2';
    expect(config.trustProxyHops).toBe(2);
    for (const bad of ['-1', 'true', '1.5', '']) {
      process.env.TRUST_PROXY_HOPS = bad;
      expect(config.trustProxyHops).toBe(1);
    }
  });
});
