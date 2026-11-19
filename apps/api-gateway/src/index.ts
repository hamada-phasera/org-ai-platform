import { buildApp } from './app';
import { installShutdownHandlers } from './services/lifecycle';
import { startInternalScheduler } from './services/schedule-dispatcher';
import { recoverStaleRunningTasks } from './services/step-runner';
import { startFlowRecovery } from './services/flows/queue';
import { config } from './config/env';
import { createLogger } from './utils/logger';

const startupLog = createLogger('startup');

async function start(): Promise<void> {
  // 組み立て（起動チェック・プラグイン・レート制限・全ルート）は app.ts。統合テストも同じ関数を使う
  const app = await buildApp({ logger: true });

  const port = config.port;
  await app.listen({ port, host: '0.0.0.0' });
  startupLog.info(`API Gateway running on port ${port}`);

  // デプロイ・再起動で RUNNING のまま取り残されたエージェント実行を回収する。
  // 放置すると受信ページにも一覧にも「実行中」のまま永久に残るため、起動直後に一度だけ掃除する。
  void recoverStaleRunningTasks()
    .then((n) => {
      if (n > 0) startupLog.info(`中断された実行 ${n} 件を回収しました`);
    })
    .catch((e) => startupLog.error('stale task recovery failed:', e));

  // 定期実行の gateway 内 tick（n8n schedule-dispatcher が未インポートでも定期実行が動く保険。
  // 併走しても enqueue 側の atomic claim が二重発火を防ぐ）
  startInternalScheduler();

  // 業務フローの回収（60 秒ごと・起動直後にも 1 回）: 待ちの着手・心拍の途絶えた実行を FAILED・7 日過ぎた承認待ちを EXPIRED
  startFlowRecovery();

  /* ⚠️ Render はデプロイのたびに SIGTERM を送る。これが無いと、応答後も裏で走っている
     処理（エージェント実行・RAG索引・領収書読み取り・返信下書き）が途中で切られ、
     Task は RUNNING のまま残り、受信箱の処理は誰にも拾われず消える。 */
  installShutdownHandlers(app);
}

start().catch((err) => {
  startupLog.error('起動に失敗しました', err instanceof Error ? err.message : err);
  process.exit(1);
});
