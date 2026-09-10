// 定期実行のスケジュール変換。UI は日本時間（JST）で入力させ、API は UTC で保存する。
// JST は UTC+9 固定（日本にサマータイムは無いのでオフセット計算だけで足りる）。

import type { ScheduleFrequency } from '@org-ai/shared-types';

const JST_OFFSET_HOURS = 9;

export interface JstSchedule {
  frequency: ScheduleFrequency;
  /** 0-23（日本時間） */
  hourJst: number;
  /** weekly のみ。0=日曜（日本時間の曜日） */
  dayOfWeekJst?: number | null;
  /** monthly のみ。1-31（日本時間の日付） */
  dayOfMonthJst?: number | null;
}

export interface UtcSchedule {
  frequency: ScheduleFrequency;
  hourUtc: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
}

/**
 * JST の指定を UTC に変換する。
 * JST 0:00-8:59 は UTC では前日になるため、weekly は曜日を 1 日戻す。
 * monthly は月末跨ぎ（1日 JST → 前月末 UTC）が煩雑なので UI 側で JST 9:00-23:00 に
 * 限定し、ここでは日付をずらさない（ずれない範囲しか選ばせない）。
 */
export function jstScheduleToUtc(s: JstSchedule): UtcSchedule {
  const rolledBack = s.hourJst < JST_OFFSET_HOURS; // UTC では前日に落ちる
  const hourUtc = (s.hourJst - JST_OFFSET_HOURS + 24) % 24;

  let dayOfWeek: number | null = null;
  if (s.frequency === 'weekly' && s.dayOfWeekJst != null) {
    dayOfWeek = rolledBack ? (s.dayOfWeekJst + 6) % 7 : s.dayOfWeekJst;
  }

  return {
    frequency: s.frequency,
    hourUtc,
    dayOfWeek,
    dayOfMonth: s.frequency === 'monthly' ? (s.dayOfMonthJst ?? null) : null,
  };
}

/** UTC 保存値を JST 表示に戻す（編集フォームの初期値用）。 */
export function utcScheduleToJst(s: UtcSchedule): JstSchedule {
  const hourJst = (s.hourUtc + JST_OFFSET_HOURS) % 24;
  const rolledForward = s.hourUtc + JST_OFFSET_HOURS >= 24; // JST では翌日に進む
  let dayOfWeekJst: number | null = null;
  if (s.frequency === 'weekly' && s.dayOfWeek != null) {
    dayOfWeekJst = rolledForward ? (s.dayOfWeek + 1) % 7 : s.dayOfWeek;
  }
  return {
    frequency: s.frequency,
    hourJst,
    dayOfWeekJst,
    dayOfMonthJst: s.dayOfMonth,
  };
}

/**
 * 次回実行時刻（UTC 基準で計算し Date を返す。表示時に toLocaleString で JST になる）。
 * 実行判定は「毎時ちょうどに hourUtc / 曜日 / 日付が一致するか」なので、それを前方探索する。
 */
export function nextRunAt(
  s: Pick<UtcSchedule, 'frequency' | 'hourUtc' | 'dayOfWeek' | 'dayOfMonth'>,
  now: Date = new Date(),
): Date | null {
  const candidate = new Date(now);
  candidate.setUTCMinutes(0, 0, 0);
  // 現在の時間帯は既に走った可能性があるため次の時間から探す
  candidate.setUTCHours(candidate.getUTCHours() + 1);

  // 最大 400 日分（monthly の 31 日指定が無い月をまたぐケースを吸収）
  for (let i = 0; i < 400 * 24; i++) {
    if (candidate.getUTCHours() === s.hourUtc) {
      if (s.frequency === 'daily') return candidate;
      if (s.frequency === 'weekly' && candidate.getUTCDay() === s.dayOfWeek) return candidate;
      if (s.frequency === 'monthly' && candidate.getUTCDate() === s.dayOfMonth) return candidate;
    }
    candidate.setUTCHours(candidate.getUTCHours() + 1);
  }
  return null;
}

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** 「毎日 9:00」「毎週 木曜 9:00」「毎月 1日 9:00」のような表示文字列（JST）。 */
export function describeSchedule(s: UtcSchedule): string {
  const jst = utcScheduleToJst(s);
  const time = `${String(jst.hourJst).padStart(2, '0')}:00`;
  if (s.frequency === 'daily') return `毎日 ${time}`;
  if (s.frequency === 'weekly') {
    const day = jst.dayOfWeekJst != null ? WEEKDAY_LABELS[jst.dayOfWeekJst] : '—';
    return `毎週${day}曜 ${time}`;
  }
  return `毎月${jst.dayOfMonthJst ?? '—'}日 ${time}`;
}

/** 「9/12(木) 9:00」のような短い日時表示（JST）。 */
export function formatNextRun(date: Date): string {
  const jst = new Date(date.getTime());
  const month = jst.toLocaleString('ja-JP', { month: 'numeric', timeZone: 'Asia/Tokyo' });
  const day = jst.toLocaleString('ja-JP', { day: 'numeric', timeZone: 'Asia/Tokyo' });
  const weekday = jst.toLocaleString('ja-JP', { weekday: 'short', timeZone: 'Asia/Tokyo' });
  const time = jst.toLocaleString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  });
  return `${month}/${day}(${weekday}) ${time}`;
}
