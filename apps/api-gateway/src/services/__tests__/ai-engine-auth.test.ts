import { describe, it, expect, vi, afterEach } from 'vitest';

// SY5: aiEngineHeaders() はテナントコンテキストの組織を X-Org-Id に付ける（docs/design/multi-tenancy.md §11.6）
vi.mock('../../utils/prisma', () => ({ prisma: {} }));

const { aiEngineHeaders } = await import('../ai-engine-auth');
const { runAsTenant } = await import('../../tenancy/context');
const { aiEngineNodeHeaders } = await import('../n8n-workflow-builder');

afterEach(() => {
  delete process.env.INTERNAL_API_TOKEN;
});

describe('aiEngineHeaders', () => {
  it('runAsTenant の中では X-Org-Id を付ける', async () => {
    const h = await runAsTenant({ orgId: 'org-A', userId: null, role: null, source: 'scheduler' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return aiEngineHeaders();
    });
    expect(h['X-Org-Id']).toBe('org-A');
  });

  it('コンテキストの外では付けない', () => {
    expect(aiEngineHeaders()['X-Org-Id']).toBeUndefined();
  });

  it('内部トークンは設定したときだけ付ける（従来どおり）', () => {
    expect(aiEngineHeaders()['X-Internal-Token']).toBeUndefined();
    process.env.INTERNAL_API_TOKEN = 'tok';
    expect(aiEngineHeaders()['X-Internal-Token']).toBe('tok');
  });
});

describe('n8n の AI Engine ノードのヘッダ', () => {
  it('X-Org-Id は webhook body の orgId、内部トークンは設定時だけ埋め込む', () => {
    const names = () => Object.fromEntries(aiEngineNodeHeaders().map((p) => [p.name, p.value]));
    expect(names()['X-Org-Id']).toContain('body.orgId');
    expect(names()['X-Internal-Token']).toBeUndefined();
    process.env.INTERNAL_API_TOKEN = 'tok';
    expect(names()['X-Internal-Token']).toBe('tok');
  });
});
