/**
 * チャットの進行状況。
 *
 * 回答は生成が終わってから一括で表示する（逐次表示はしない）。そのあいだ画面が
 * 無反応に見えないよう、いま何をしているかを出す。
 *
 * ⚠️ フェーズは gateway が**実際に起きたイベントでしか進めない**。
 *    「まもなく表示します」は、上流の生成が終わって保存待ちになった時点でだけ出す。
 *    生成の途中で出すと必ず推測になり、長引いたときに画面が嘘をつく。
 */

export const CHAT_PHASES = ['RECEIVED', 'RETRIEVING', 'GENERATING', 'FINALIZING'] as const;
export type ChatPhase = (typeof CHAT_PHASES)[number];

const LABEL: Record<ChatPhase, string> = {
  RECEIVED: '受け付けました',
  RETRIEVING: '関連する資料を探しています',
  GENERATING: '文章を作成しています',
  FINALIZING: 'まもなく表示します',
};

/** 進行が止まって見えるまでの猶予（ms）。これを超えたら「時間がかかっています」を添える。 */
export const STALLED_AFTER_MS = 20_000;

export function phaseLabel(phase: ChatPhase | null): string {
  if (phase === null) return '準備しています';
  return LABEL[phase] ?? '処理しています';
}

/**
 * 補助表示。GENERATING のときだけ、受信済みの文字数を添える。
 * ⚠️ 進捗率は出さない。全体の長さが分からないので「何%」は必ず嘘になる。
 */
export function phaseDetail(phase: ChatPhase | null, chars: number | null): string | null {
  if (phase !== 'GENERATING' || chars === null || chars <= 0) return null;
  return `約${chars.toLocaleString('ja-JP')}文字`;
}

/** 想定より長引いているか。判定は経過時間のみ（推測を混ぜない）。 */
export function isStalled(lastEventAt: number | null, now: number): boolean {
  if (lastEventAt === null) return false;
  return now - lastEventAt > STALLED_AFTER_MS;
}

export function isChatPhase(value: unknown): value is ChatPhase {
  return typeof value === 'string' && (CHAT_PHASES as readonly string[]).includes(value);
}
