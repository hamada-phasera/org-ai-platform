import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// アーキテクチャテスト（docs/design/multi-tenancy.md ADR-5 / §11.2 A1〜A4）。
// 「各ハンドラが毎回 orgId を書く」規律ではなく、構造でテナント分離を守るための検査。
// ESLint（ルートの eslint.config.js の no-restricted-imports）でも同じことを止めている。

const SRC = resolve(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : walk(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}
const files = walk(SRC).map((p) => ({ rel: relative(SRC, p).replace(/\\/g, '/'), src: readFileSync(p, 'utf8') }));
const PRISMA_IMPORT = /from '(?:\.\.?\/)+utils\/prisma'/;

/**
 * 素の prisma（全テナント横断）を使ってよいファイル。**増やすときは理由を書くこと。**
 * ルートは request.tenant.db（tenantDb）だけを使う。
 */
export const RAW_PRISMA_ALLOWLIST: Record<string, string> = {
  // ── 入口・テナントの仕組みそのもの ──
  'index.ts': '/ready の SELECT 1',
  'middleware/auth.ts': '所属の確認（テナントが決まる前）',
  'tenancy/tenant-db.ts': 'テナントクライアントの実体',
  'tenancy/membership-cache.ts': '所属の確認（テナントが決まる前）',
  // ── 認証の無い経路・組織を選ぶ前の経路 ──
  'routes/auth.ts': 'ログイン・登録・所属一覧・組織の切り替え/作成（組織をまたぐ）',
  'routes/members.ts': '招待のプレビュー/受諾（トークンで招待を逆引き）だけ',
  'routes/webhooks.ts': 'n8n コールバック（共有トークン + orgId 照合）',
  'routes/inbox/line-webhook.ts': 'LINE destination から接続を逆引き（署名検証後は runAsTenant）',
  'routes/billing-webhook.ts': 'Stripe webhook（署名検証済み。組織自体を更新する）',
  'services/memberships.ts': '所属一覧・トークン発行（組織をまたぐ）',
  'services/organizations.ts': '組織の作成・作成上限・作成者ごとのトライアル（組織をまたいで数える）',
  'services/billing/sync.ts': 'Stripe の写し込み（組織自体を更新する）',
  'services/lifecycle.ts': 'シャットダウン時の後始末（状態を FAILED にするだけ）',
  'services/schedule-dispatcher.ts': '定期実行の claim と候補スキャン（claim 後は runAsTenant + tenantDb）',
  'services/step-runner.ts': '取り残された実行の回収と、Task の組織での実行（Phase 1.5 で tenantDb へ）',
  // ── 受け取った orgId で必ず where/data を書いているサービス（Phase 1.5 で tenantDb へ移す） ──
  'services/task-executor.ts': 'Task を引数で受け取り、その id/orgId で更新する',
  'services/capability-resolver.ts': 'orgId を引数で受け取る（where に orgId）',
  'services/capability-executor.ts': 'orgId を引数で受け取る（where に orgId）',
  'services/adapters/index.ts': 'ctx.orgId で ProviderConnection を引く',
  'services/google-auth.ts': 'orgId で ProviderConnection を引く',
  'services/integration-sync.ts': 'orgId で RequiredCredential を同期する',
  'services/rag.ts': 'pgvector の raw SQL（"orgId" = ${orgId}）',
  'services/inbox/line-inbox.ts': 'connection.orgId で取り込む（runAsTenant の中）',
  'services/inbox/draft-generator.ts': 'InboundMessage の orgId で下書きを書く',
  'services/inbox/receipt-capture.ts': 'InboundMessage の orgId で原価の下書きを作る',
};

/** raw SQL を書いてよいファイル。どれも "orgId" か "Organization" を条件に含むこと。 */
const RAW_SQL_ALLOWLIST = ['index.ts', 'tenancy/tenant-db.ts', 'routes/files.ts', 'services/rag.ts'];

describe('A1: 素の prisma を import するのは allowlist のファイルだけ', () => {
  const importers = files.filter((f) => PRISMA_IMPORT.test(f.src)).map((f) => f.rel).sort();

  it('allowlist 外に増えていない', () => {
    expect(importers.filter((f) => !(f in RAW_PRISMA_ALLOWLIST))).toEqual([]);
  });

  it('routes 配下は認証の無い経路と組織をまたぐ経路だけ', () => {
    expect(importers.filter((f) => f.startsWith('routes/'))).toEqual([
      'routes/auth.ts',
      'routes/billing-webhook.ts',
      'routes/inbox/line-webhook.ts',
      'routes/members.ts',
      'routes/webhooks.ts',
    ]);
  });

  it('allowlist に使われていないエントリが残っていない（外したら消す）', () => {
    expect(Object.keys(RAW_PRISMA_ALLOWLIST).filter((f) => !importers.includes(f))).toEqual([]);
  });
});

describe('A2: raw SQL は allowlist のファイルだけで、組織の条件を持つ', () => {
  const RAW = /(?:\$(?:queryRaw|executeRaw)(?:<[^>]*>)?\s*|Prisma\.sql)`([\s\S]*?)`/g;
  it('allowlist 外で使っていない', () => {
    const users = files.filter((f) => /\$(queryRaw|executeRaw)/.test(f.src)).map((f) => f.rel).sort();
    expect(users.filter((f) => !RAW_SQL_ALLOWLIST.includes(f))).toEqual([]);
  });
  it('Unsafe 版は使わない', () => {
    expect(files.filter((f) => /\$(queryRaw|executeRaw)Unsafe/.test(f.src)).map((f) => f.rel)).toEqual([]);
  });
  it.each(['routes/files.ts', 'services/rag.ts'])('%s の SQL はすべて "orgId" か "Organization" を含む', (rel) => {
    const src = files.find((f) => f.rel === rel)!.src;
    // 断片（`AND fc."fileId" IN (...)` など）は組織で絞った WHERE に差し込まれるので、文そのものだけを見る
    const sqls = [...src.matchAll(RAW)].map((m) => m[1]).filter((q) => /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(q));
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) expect(/"orgId"|"Organization"/.test(sql)).toBe(true);
  });
});

describe('A3: ai-engine を呼ぶ箇所はすべて aiEngineHeaders() を通す（X-Internal-Token / X-Org-Id）', () => {
  const AI_FETCH = /fetch\(\s*`\$\{(aiEngineUrl|AI_ENGINE_URL|base)\}/g;
  const callers = files.filter((f) => AI_FETCH.test(f.src));
  it('呼び出し箇所が見つかる（検査が空振りしていない）', () => {
    expect(callers.length).toBeGreaterThan(5);
  });
  it.each(callers.map((f) => [f.rel, f] as const))('%s', (_rel, f) => {
    const fetches = [...f.src.matchAll(AI_FETCH)].length;
    const headers = [...f.src.matchAll(/aiEngineHeaders\(/g)].length;
    expect(headers).toBeGreaterThanOrEqual(fetches);
  });
});

describe('A4: ルートは JWT の role / orgId を直接読まない', () => {
  it('request.user のキャストは組織を選ぶ前の経路（auth.ts）と WebSocket（tasks.ts）だけ', () => {
    const users = files
      .filter((f) => f.rel.startsWith('routes/') && /request\.user as/.test(f.src))
      .map((f) => f.rel)
      .sort();
    expect(users).toEqual(['routes/auth.ts', 'routes/tasks.ts']);
  });
  it('payload.role / request.user.role で権限を判定していない（E4 の再発防止）', () => {
    const bad = files.filter(
      (f) => f.rel.startsWith('routes/') && /(payload|request\.user)(\s+as\s+[^)]*\))?\.role\s*[!=]==/.test(f.src),
    );
    expect(bad.map((f) => f.rel)).toEqual([]);
  });
});

describe('A5: process.env を読むのは config/env.ts だけ（CLAUDE.md「環境変数の読み口は1か所」）', () => {
  it('src/ のほかのファイルは process.env に触れない', () => {
    const offenders = files
      .filter((f) => f.rel !== 'config/env.ts')
      // コメント中の言及は数えない（行頭の // と * の行を落とす）
      .filter((f) =>
        f.src
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .some((line) => /\bprocess\.env\b/.test(line)),
      )
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
