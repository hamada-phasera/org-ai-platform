/**
 * SNSコンテンツカレンダーの日付ロジック（N-3 の純粋部分）。
 *
 * 下書き Task を「日付」にひも付けて集計する。日付は output.scheduledAt があればそれ、
 * 無ければ createdAt を採用し、指定タイムゾーン（既定 JST）の YYYY-MM-DD で丸める。
 * prisma/fastify を import しない = DB 無しで単体テスト可能。
 */

export const DEFAULT_TZ = 'Asia/Tokyo';

/** カレンダー集計に必要な最小の Task 形。 */
export interface CalendarTask {
  id: string;
  title: string;
  status: string;
  taskType: string | null;
  output: string | null;
  createdAt: string;
}

/** ISO 文字列を指定TZの 'YYYY-MM-DD' に丸める。無効な入力は null。 */
export function toDateKey(iso: string | null | undefined, tz: string = DEFAULT_TZ): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA ロケールは YYYY-MM-DD 形式。timeZone でその地域の暦日に丸める。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** output JSON から scheduledAt を安全に取り出す（無効なら undefined）。 */
export function extractScheduledAt(output: string | null): string | undefined {
  if (!output) return undefined;
  try {
    const j = JSON.parse(output) as { scheduledAt?: unknown };
    if (typeof j.scheduledAt === 'string' && !Number.isNaN(new Date(j.scheduledAt).getTime())) {
      return j.scheduledAt;
    }
  } catch {
    /* 非JSON output は無視 */
  }
  return undefined;
}

/** その下書きが属する日付キー（scheduledAt 優先、無ければ createdAt）。 */
export function draftDateKey(task: CalendarTask, tz: string = DEFAULT_TZ): string | null {
  return toDateKey(extractScheduledAt(task.output) ?? task.createdAt, tz);
}

export interface CalendarDay {
  date: string; // YYYY-MM-DD
  items: CalendarTask[];
}

/**
 * 下書きを日付キーでグルーピングし、日付昇順の配列で返す。
 * 日付を決められない Task は除外する。
 */
export function groupDraftsByDate(tasks: readonly CalendarTask[], tz: string = DEFAULT_TZ): CalendarDay[] {
  const map = new Map<string, CalendarTask[]>();
  for (const t of tasks) {
    const key = draftDateKey(t, tz);
    if (!key) continue;
    const arr = map.get(key);
    if (arr) arr.push(t);
    else map.set(key, [t]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, items]) => ({ date, items }));
}
