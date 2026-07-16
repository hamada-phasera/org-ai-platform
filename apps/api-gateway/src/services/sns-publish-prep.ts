import { prisma } from '../utils/prisma';
import { formatForClipboard, isSnsPlatform } from '../routes/sns/format';

/**
 * SNS 投稿準備 cron（n8n 統合設計 D2・段階1）。
 *
 * APPROVED かつ scheduledAt が到来した SNS 下書き Task を拾い、
 * 「投稿準備」= プレビュー生成・キュー投入マーク までを行う。
 *
 * 【最重要・厳守】実 SNS API への投稿は一切行わない（段階1）。
 * 実投稿（段階2）は将来 `SNS_LIVE_POST=true` の明示解放 + 経営判断でのみ解放される。
 * 現段階ではフラグが立っていても投稿せず、WARN ログを残すのみ。
 *
 * 呼び出し元: POST /api/webhooks/n8n/sns-publish-prep（n8n schedule WF
 * `apps/n8n-workflows/sns-publish-prep.json` などの任意の cron）。
 */

/** 1回の cron で処理する上限（暴走防止。積み残しは次回実行が拾う）。 */
const MAX_BATCH = 50;

export interface PublishPrepResult {
  /** 走査した候補数（APPROVED + scheduledAt 到来）。 */
  checked: number;
  /** 今回投稿準備を行った taskId。 */
  prepared: string[];
  /** 既に準備済みでスキップした taskId。 */
  alreadyPrepared: string[];
}

interface DraftOutput extends Record<string, unknown> {
  publishPrep?: unknown;
  content?: unknown;
  hashtags?: unknown;
  platform?: unknown;
}

function parseOutput(output: string | null): DraftOutput {
  if (!output) return {};
  try {
    return JSON.parse(output) as DraftOutput;
  } catch {
    return {};
  }
}

/** scheduledAt 到来済みの APPROVED SNS 下書きに投稿準備（プレビュー・キュー投入）を行う。 */
export async function prepDueSnsPosts(now: Date = new Date()): Promise<PublishPrepResult> {
  const due = await prisma.task.findMany({
    where: {
      taskType: 'sns',
      status: 'APPROVED',
      scheduledAt: { not: null, lte: now },
    },
    orderBy: { scheduledAt: 'asc' },
    take: MAX_BATCH,
  });

  const prepared: string[] = [];
  const alreadyPrepared: string[] = [];
  const liveFlagSet = process.env.SNS_LIVE_POST === 'true';

  for (const task of due) {
    const draft = parseOutput(task.output);
    if (draft.publishPrep) {
      alreadyPrepared.push(task.id);
      continue;
    }

    const content = typeof draft.content === 'string' ? draft.content : '';
    const hashtags = Array.isArray(draft.hashtags) ? (draft.hashtags as unknown[]).map(String) : [];
    const platform = isSnsPlatform(draft.platform) ? draft.platform : 'twitter';

    draft.publishPrep = {
      preparedAt: now.toISOString(),
      platform,
      preview: formatForClipboard(content, hashtags),
      queued: true,
      livePosted: false, // 段階1: 実投稿はしない
    };

    await prisma.task.update({
      where: { id: task.id },
      data: { output: JSON.stringify(draft) },
    });
    await prisma.taskLog.create({
      data: {
        taskId: task.id,
        message: '投稿準備が完了しました（プレビュー生成・キュー投入。実投稿はしていません）',
        level: 'INFO',
      },
    });
    if (liveFlagSet) {
      // 段階2は未実装。フラグが立っていても投稿しない旨を可視化する。
      await prisma.taskLog.create({
        data: {
          taskId: task.id,
          message: 'SNS_LIVE_POST が有効ですが、実投稿（段階2）は未解放のためシミュレーションに留めました',
          level: 'WARN',
        },
      });
    }
    prepared.push(task.id);
  }

  return { checked: due.length, prepared, alreadyPrepared };
}
