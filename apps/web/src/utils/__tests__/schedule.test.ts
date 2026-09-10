import { describe, it, expect } from 'vitest';
import {
  jstScheduleToUtc,
  utcScheduleToJst,
  nextRunAt,
  describeSchedule,
} from '../schedule';

describe('jstScheduleToUtc', () => {
  it('JST 9:00 は UTC 0:00（日付は動かない）', () => {
    expect(jstScheduleToUtc({ frequency: 'daily', hourJst: 9 })).toEqual({
      frequency: 'daily',
      hourUtc: 0,
      dayOfWeek: null,
      dayOfMonth: null,
    });
  });

  it('JST 18:00 は UTC 9:00', () => {
    expect(jstScheduleToUtc({ frequency: 'daily', hourJst: 18 }).hourUtc).toBe(9);
  });

  it('JST 8:00（9時より前）は UTC 前日 23:00 になり、weekly は曜日が 1 つ戻る', () => {
    const r = jstScheduleToUtc({ frequency: 'weekly', hourJst: 8, dayOfWeekJst: 3 }); // 水曜 8:00 JST
    expect(r.hourUtc).toBe(23);
    expect(r.dayOfWeek).toBe(2); // UTC では火曜 23:00
  });

  it('日曜 0:00 JST は UTC 土曜 15:00（週の折り返し）', () => {
    const r = jstScheduleToUtc({ frequency: 'weekly', hourJst: 0, dayOfWeekJst: 0 });
    expect(r.hourUtc).toBe(15);
    expect(r.dayOfWeek).toBe(6);
  });

  it('9時以降の weekly は曜日が変わらない', () => {
    const r = jstScheduleToUtc({ frequency: 'weekly', hourJst: 9, dayOfWeekJst: 1 });
    expect(r.dayOfWeek).toBe(1);
  });

  it('monthly は日付をそのまま渡す（UI が 9-23 時に限定して跨ぎを回避）', () => {
    const r = jstScheduleToUtc({ frequency: 'monthly', hourJst: 10, dayOfMonthJst: 1 });
    expect(r).toEqual({ frequency: 'monthly', hourUtc: 1, dayOfWeek: null, dayOfMonth: 1 });
  });
});

describe('utcScheduleToJst（往復変換）', () => {
  it('daily は往復して元に戻る', () => {
    for (const hourJst of [0, 8, 9, 15, 23]) {
      const utc = jstScheduleToUtc({ frequency: 'daily', hourJst });
      expect(utcScheduleToJst(utc).hourJst).toBe(hourJst);
    }
  });

  it('weekly は曜日込みで往復して元に戻る', () => {
    for (const hourJst of [0, 8, 9, 23]) {
      for (let dayOfWeekJst = 0; dayOfWeekJst < 7; dayOfWeekJst++) {
        const utc = jstScheduleToUtc({ frequency: 'weekly', hourJst, dayOfWeekJst });
        const back = utcScheduleToJst(utc);
        expect({ h: back.hourJst, d: back.dayOfWeekJst }).toEqual({ h: hourJst, d: dayOfWeekJst });
      }
    }
  });
});

describe('nextRunAt', () => {
  it('daily: 今日の実行時刻を過ぎていれば翌日', () => {
    const now = new Date('2026-09-10T05:30:00Z'); // UTC 5:30
    const next = nextRunAt({ frequency: 'daily', hourUtc: 0, dayOfWeek: null, dayOfMonth: null }, now);
    expect(next?.toISOString()).toBe('2026-09-11T00:00:00.000Z');
  });

  it('daily: これから来る時刻なら当日', () => {
    const now = new Date('2026-09-10T05:30:00Z');
    const next = nextRunAt({ frequency: 'daily', hourUtc: 9, dayOfWeek: null, dayOfMonth: null }, now);
    expect(next?.toISOString()).toBe('2026-09-10T09:00:00.000Z');
  });

  it('weekly: 指定曜日まで進む', () => {
    const now = new Date('2026-09-10T05:30:00Z'); // 木曜
    const next = nextRunAt({ frequency: 'weekly', hourUtc: 0, dayOfWeek: 1, dayOfMonth: null }, now);
    expect(next?.getUTCDay()).toBe(1); // 月曜
    expect(next?.toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });

  it('monthly: 指定日まで進む', () => {
    const now = new Date('2026-09-10T05:30:00Z');
    const next = nextRunAt({ frequency: 'monthly', hourUtc: 0, dayOfWeek: null, dayOfMonth: 1 }, now);
    expect(next?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('monthly 31日は 31 日がある月まで飛ぶ（無い月を飛ばす）', () => {
    const now = new Date('2026-09-10T05:30:00Z'); // 9月は30日まで
    const next = nextRunAt({ frequency: 'monthly', hourUtc: 0, dayOfWeek: null, dayOfMonth: 31 }, now);
    expect(next?.getUTCMonth()).toBe(9); // 10月 (0-indexed)
    expect(next?.getUTCDate()).toBe(31);
  });
});

describe('describeSchedule', () => {
  it('JST 表記で読める文字列になる', () => {
    expect(describeSchedule({ frequency: 'daily', hourUtc: 0, dayOfWeek: null, dayOfMonth: null })).toBe(
      '毎日 09:00',
    );
    expect(describeSchedule({ frequency: 'weekly', hourUtc: 0, dayOfWeek: 1, dayOfMonth: null })).toBe(
      '毎週月曜 09:00',
    );
    expect(describeSchedule({ frequency: 'monthly', hourUtc: 1, dayOfWeek: null, dayOfMonth: 1 })).toBe(
      '毎月1日 10:00',
    );
  });
});
