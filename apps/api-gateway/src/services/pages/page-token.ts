// ページ登録トークン（docs/design/custom-pages.md §5.4・K4・K19）。
//
// ■ 形式      flowpg_ + randomBytes(32).base64url（256 bit）。接頭辞で何のトークンか分かり、漏洩の検知もしやすい。
// ■ 保存      sha256 のハッシュと先頭 10 文字だけ。生値は発行時の応答に 1 回出るきり（Invitation と同じ流儀）。
//             エントロピーが十分なので bcrypt は使わない。
// ■ 本数      有効なものは組織あたり 2 本まで（新しいのを発行 → n8n の credential を差し替え → 古いのを失効、で止めずに替えられる）。
// ■ 期限      付けない（定期実行のワークフローが黙って止まる方が害が大きい）。lastUsedAt を見せて使われていないものを失効しやすくする。
// ■ 失効      即時。照合のたびに DB を引く（キャッシュしない）。
// ■ 範囲      その組織のページ定義の登録・更新・削除だけ（routes/n8n-pages.ts）。他の API には使えない。
//
// ⚠️ 素の prisma を使うのは resolvePageToken の 1 か所だけ（ハッシュから組織を逆引きする＝テナントが決まる前）。
//    以降は tenantDb(orgId)。アーキテクチャテストの allowlist に理由付きで載せてある。
// ⚠️ 値はログにも監査にも出さない。出してよいのは id と prefix だけ。

import { createHash, randomBytes } from 'crypto';
import { prisma } from '../../utils/prisma';
import type { TenantDb } from '../../tenancy/tenant-db';
import { recordAudit } from '../audit';
import { PageServiceError } from './upsert';

export const PAGE_TOKEN_PREFIX = 'flowpg_';
/** 有効な（失効していない）トークンの本数の上限 */
export const MAX_ACTIVE_PAGE_TOKENS = 2;
/** lastUsedAt を書き直す間隔（毎回書くと登録のたびに 1 行更新が増える） */
const TOUCH_INTERVAL_MS = 60_000;
/** flowpg_ + base64url(32 byte) = 7 + 43 文字。幅を持たせて受ける（形が明らかに違うものは DB を引かずに弾く） */
const TOKEN_SHAPE = /^flowpg_[A-Za-z0-9_-]{32,64}$/;

export function hashPageToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generatePageToken(): { raw: string; hash: string; prefix: string } {
  const raw = `${PAGE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { raw, hash: hashPageToken(raw), prefix: raw.slice(0, 10) };
}

export interface ResolvedPageToken {
  tokenId: string;
  orgId: string;
}

/**
 * ヘッダの生トークン → 組織。失効済み・存在しない・形が違うものはすべて null（呼び出し側は一律 401）。
 * 照合はハッシュの一意検索（値の比較は DB 側）なので、文字列比較の時間差は出ない。
 */
export async function resolvePageToken(raw: unknown): Promise<ResolvedPageToken | null> {
  if (typeof raw !== 'string' || !TOKEN_SHAPE.test(raw)) return null;
  const row = await prisma.pageToken.findUnique({
    where: { tokenHash: hashPageToken(raw) },
    select: { id: true, orgId: true, revokedAt: true },
  });
  if (!row || row.revokedAt) return null;
  return { tokenId: row.id, orgId: row.orgId };
}

/** 最終使用時刻を残す（1 分に 1 回まで）。失敗しても登録は止めない */
export async function touchPageToken(db: TenantDb, tokenId: string, now: Date = new Date()): Promise<void> {
  await db.pageToken.updateMany({
    where: {
      id: tokenId,
      OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - TOUCH_INTERVAL_MS) } }],
    },
    data: { lastUsedAt: now },
  });
}

/** 一覧に出す項目（ハッシュは返さない） */
export const PAGE_TOKEN_PUBLIC_SELECT = {
  id: true,
  label: true,
  prefix: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

export async function listPageTokens(db: TenantDb) {
  return db.pageToken.findMany({ select: PAGE_TOKEN_PUBLIC_SELECT, orderBy: { createdAt: 'desc' } });
}

/** 発行。**生トークンはこの戻り値にしか無い**（呼び出し側は応答に 1 回だけ載せる） */
export async function issuePageToken(db: TenantDb, args: { label: string; actorId: string }) {
  const active = await db.pageToken.count({ where: { revokedAt: null } });
  if (active >= MAX_ACTIVE_PAGE_TOKENS) {
    throw new PageServiceError(
      409,
      'PAGE_TOKEN_LIMIT',
      `有効な登録トークンは ${MAX_ACTIVE_PAGE_TOKENS} 本までです。使っていないトークンを失効してから発行してください。`,
    );
  }
  const { raw, hash, prefix } = generatePageToken();
  const row = await db.pageToken.create({
    data: { orgId: db.orgId, label: args.label, tokenHash: hash, prefix, createdBy: args.actorId },
    select: PAGE_TOKEN_PUBLIC_SELECT,
  });
  // ⚠️ 監査にも値は入れない（id と prefix だけ）
  await recordAudit(db, {
    action: 'page_token.issue',
    actorId: args.actorId,
    targetType: 'page_token',
    targetId: row.id,
    meta: { label: row.label, prefix: row.prefix },
  });
  return { ...row, token: raw };
}

/** 失効。無い（他組織の id を含む）なら 404。既に失効済みなら何もしない（冪等） */
export async function revokePageToken(db: TenantDb, args: { id: string; actorId: string }): Promise<void> {
  const row = await db.pageToken.findUnique({ where: { id: args.id }, select: { id: true, prefix: true, revokedAt: true } });
  if (!row) throw new PageServiceError(404, 'NOT_FOUND', 'トークンが見つかりません');
  if (row.revokedAt) return;
  await db.pageToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await recordAudit(db, {
    action: 'page_token.revoke',
    actorId: args.actorId,
    targetType: 'page_token',
    targetId: row.id,
    meta: { prefix: row.prefix },
  });
}
