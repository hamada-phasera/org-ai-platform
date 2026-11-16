/**
 * JWT から取り出す利用者情報（request.user）。ルート間で共通の最小形。
 * ⚠️ role は JWT 由来なので権限判定に使わない（middleware/auth.ts の requireRole を参照）。
 */
export type AuthPayload = { orgId: string; sub?: string; role?: string };
