// 業務ページのアクションの組織ごとの窓（docs/design/custom-pages.md §5.2 の 4）。
//
// IP ごとの上限（PAGE_ACTION_RATE_LIMIT）は @fastify/rate-limit が見る。こちらは**組織ごと**に
// 取得（query）120 回/分・送信（submit）30 回/分。1 組織の連打・暴走したスクリプトで共有の n8n を詰まらせない（T8・T11）。
//
// ⚠️ 保持はプロセスのメモリ（D8 と同じく gateway 1 台が前提。複数台にするときは保持先を替える。T18）。

export type PageActionKind = 'query' | 'submit';

export const PAGE_ORG_THROTTLE = {
  windowMs: 60_000,
  query: 120,
  submit: 30,
} as const;

interface Window {
  startedAt: number;
  count: number;
}

const windows = new Map<string, Window>();
/** 古い窓を掃除する間隔（Map が組織数 × 2 より大きく育たないように） */
const SWEEP_EVERY = 500;
let calls = 0;

function sweep(now: number): void {
  for (const [key, w] of windows) {
    if (now - w.startedAt >= PAGE_ORG_THROTTLE.windowMs) windows.delete(key);
  }
}

/**
 * 1 回分を取る。上限内なら true（数える）、超えていれば false（数えない）。
 * 固定窓（最初の呼び出しから 1 分）。境界で最大 2 倍まで通りうるが、目的は暴走の抑止なので足りる。
 */
export function takeOrgActionSlot(orgId: string, kind: PageActionKind, now: number = Date.now()): boolean {
  if (++calls % SWEEP_EVERY === 0) sweep(now);
  const key = `${kind}:${orgId}`;
  const limit = PAGE_ORG_THROTTLE[kind];
  const w = windows.get(key);
  if (!w || now - w.startedAt >= PAGE_ORG_THROTTLE.windowMs) {
    windows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (w.count >= limit) return false;
  w.count += 1;
  return true;
}

/** テスト用 */
export function resetOrgThrottle(): void {
  windows.clear();
  calls = 0;
}
