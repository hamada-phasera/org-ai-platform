// 経理ルートで共通の小道具。ここに DB アクセスは置かない。

import type { FastifyReply } from 'fastify';

export type AuthPayload = { orgId: string; sub?: string; role?: string };

export function fail(
  reply: FastifyReply,
  code: number,
  errorCode: string,
  message: string,
): FastifyReply {
  return reply.code(code).send({ success: false, error: { code: errorCode, message } });
}

/**
 * `YYYY-MM-DD` を UTC 深夜の Date にする。
 * ローカルタイムゾーンで解釈すると JST の朝が前日の UTC になり、
 * 月次集計が1日ずれる（日本の会社が使うので必ず起きる）。
 */
export function parseDateOnly(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  // 2026-02-31 のような存在しない日付は Date が繰り上げるので、往復させて検出する
  if (d.toISOString().slice(0, 10) !== iso) return null;
  return d;
}

/** `YYYY-MM` から その月の [開始, 翌月開始) を UTC で返す。 */
export function monthRange(ym: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}$/.test(ym)) return null;
  const [y, m] = ym.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
  return { start, end };
}

/** Date を `YYYY-MM-DD` に戻す（レスポンスの日付は時刻を持たせない）。 */
export function toDateOnly(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Prisma の一意制約違反か。 */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}
