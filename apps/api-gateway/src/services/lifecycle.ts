// SIGTERM を受けてからの終了手順。lifecycle-core（純粋な台帳）に DB と signal を配線する。
//
// ⚠️ Render はデプロイのたびに古いプロセスへ SIGTERM を送る。ハンドラが無いと、
//    走行中のバックグラウンド処理が処理の途中で問答無用に切られ、
//    Task は RUNNING のまま残り、受信箱の下書きや領収書読み取りは誰も拾わず消える。

import type { FastifyInstance } from 'fastify';
import { prisma } from '../utils/prisma';
import { jobs, drain, type JobRecord } from './lifecycle-core';

/**
 * 待ちの予算。Render が SIGTERM から強制終了までに与える猶予より短くする
 * （既定 30 秒。render.yaml で maxShutdownDelaySeconds を伸ばしたらここも上げる）。
 */
const DRAIN_BUDGET_MS = Number(process.env.SHUTDOWN_DRAIN_MS ?? 20_000);
const POLL_MS = 250;

/** 中断されたことを人が読んで分かる文言。起動時の回収と同じ言い回しに揃える。 */
export const INTERRUPTED_MESSAGE = 'デプロイまたは再起動により中断されました。もう一度実行してください';

/**
 * 待たずに諦める種類。
 * エージェント実行は分単位でかかりうるので、待つと猶予を使い切って
 * 結局強制終了され、記録も残らない。**待たずに印だけ先に付ける**方が人は気づける。
 */
const LONG_RUNNING = ['agent-run', 'agent-resume'] as const;

/** Task を持つ処理に「中断された」と記録する。RUNNING のものだけを条件付きで塗る。 */
async function markTasksInterrupted(records: JobRecord[]): Promise<number> {
  const taskIds = records
    .filter((r) => r.kind === 'agent-run' || r.kind === 'agent-resume')
    .map((r) => r.ref)
    .filter((v): v is string => typeof v === 'string');
  if (taskIds.length === 0) return 0;

  /* ⚠️ status: 'RUNNING' を条件に入れる。既に DONE / FAILED になっているものを
     上書きすると、成功した実行を失敗に書き換えることになる。 */
  const result = await prisma.task.updateMany({
    where: { id: { in: taskIds }, status: 'RUNNING' },
    data: { status: 'FAILED', lastError: INTERRUPTED_MESSAGE },
  });
  return result.count;
}

/**
 * 受信箱の処理に印を付ける。
 * ⚠️ 領収書は status=CAPTURED のまま本文が null だと、受信箱の既定ビューにも出ず
 *    人が永久に気づけない。本文に中断した旨を書いておく。
 */
async function markInboxInterrupted(records: JobRecord[]): Promise<number> {
  const ids = records
    .filter((r) => r.kind === 'receipt' || r.kind === 'inbox-draft')
    .map((r) => r.ref)
    .filter((v): v is string => typeof v === 'string');
  if (ids.length === 0) return 0;

  const result = await prisma.inboundMessage.updateMany({
    where: { id: { in: ids }, text: null },
    data: { text: '📷 処理中に再起動が入り、読み取りを完了できませんでした。もう一度送ってください。' },
  });
  return result.count;
}

let shuttingDown = false;

/**
 * 終了処理。
 *
 * 順序に意味がある:
 *   1. 新規受付を止める（走行中がこれ以上増えない）
 *   2. HTTP を閉じる（処理中のリクエストは待つ）
 *   3. 長時間かかる種類は待たずに即マーク（猶予を食い潰さない）
 *   4. 残りを予算いっぱいまで待つ
 *   5. 待ちきれなかったものもマークする
 */
export async function shutdown(app: FastifyInstance, signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[lifecycle] ${signal} を受信。終了処理を開始します（走行中 ${jobs.size} 件）`);

  jobs.beginShutdown();

  try {
    await app.close();
  } catch (e) {
    console.error('[lifecycle] app.close に失敗:', e instanceof Error ? e.message : e);
  }

  // 長時間クラスは待たずに印を付ける（処理自体は止めない。プロセスが死ぬまで走る）
  const longRunning = jobs.listByKind(LONG_RUNNING);
  if (longRunning.length > 0) {
    const n = await markTasksInterrupted(longRunning).catch(() => 0);
    console.log(`[lifecycle] 長時間の実行 ${longRunning.length} 件を中断として記録（更新 ${n} 件）`);
  }

  const result = await drain(jobs, {
    budgetMs: DRAIN_BUDGET_MS,
    pollMs: POLL_MS,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    skipKinds: LONG_RUNNING,
  });

  if (result.drained) {
    console.log(`[lifecycle] 走行中の処理はすべて終了しました（${result.waitedMs}ms）`);
  } else {
    console.warn(`[lifecycle] ${result.remaining.length} 件が予算内に終わりませんでした`);
    await markInboxInterrupted(result.remaining).catch(() => 0);
  }

  await prisma.$disconnect().catch(() => undefined);
  console.log('[lifecycle] 終了します');
}

/** signal を配線する。listen のあとに1回だけ呼ぶ。 */
export function installShutdownHandlers(app: FastifyInstance): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(app, signal).finally(() => process.exit(0));
    });
  }
}
