import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_MODELS, CHILD_MODELS, GLOBAL_MODELS, ORG_ROOT_MODEL } from '../tenant-models';

// T8: schema.prisma を読み、orgId を持つモデルとテナントモデルの表が一致することを確かめる。
// 新しいモデルを足したときに表へ足し忘れる（= テナントクライアントが絞らない）のを防ぐ。

const SCHEMA = readFileSync(resolve(__dirname, '../../../../../packages/db-schema/prisma/schema.prisma'), 'utf8');

function models(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^model (\w+) \{([\s\S]*?)^\}/gm;
  for (const m of SCHEMA.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

describe('テナントモデルの表と schema.prisma', () => {
  const all = models();

  it('orgId String（必須）を持つモデル = TENANT_MODELS', () => {
    const withOrg = [...all].filter(([, body]) => /^\s+orgId\s+String\s/m.test(body)).map(([n]) => n);
    expect([...withOrg].sort()).toEqual([...TENANT_MODELS].sort());
  });

  it('orgId String?（null 可）を持つモデル = GLOBAL_MODELS（全体で共有）', () => {
    const nullable = [...all].filter(([, body]) => /^\s+orgId\s+String\?/m.test(body)).map(([n]) => n);
    expect(nullable.sort()).toEqual([...GLOBAL_MODELS].sort());
  });

  it('すべてのモデルがどれか1つの区分に入っている', () => {
    const classified = new Set<string>([...TENANT_MODELS, ...CHILD_MODELS, ...GLOBAL_MODELS, ORG_ROOT_MODEL]);
    const missing = [...all.keys()].filter((n) => !classified.has(n));
    expect(missing).toEqual([]);
  });

  it('子モデルは orgId を持たない（持たせたら TENANT_MODELS へ移す）', () => {
    for (const c of CHILD_MODELS) {
      expect(all.get(c)).toBeDefined();
      expect(/^\s+orgId\s/m.test(all.get(c)!)).toBe(false);
    }
  });
});
