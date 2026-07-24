import { describe, it, expect } from 'vitest';
import {
  toDateKey,
  extractScheduledAt,
  draftDateKey,
  groupDraftsByDate,
  type CalendarTask,
} from '../../src/routes/sns/calendar';

function task(over: Partial<CalendarTask>): CalendarTask {
  return {
    id: 'id',
    title: 't',
    status: 'PENDING_APPROVAL',
    taskType: 'sns',
    output: null,
    createdAt: '2026-07-01T00:00:00+09:00',
    ...over,
  };
}

describe('toDateKey (JST)', () => {
  it('正常系: JST の暦日に丸める', () => {
    // 16:00Z = 翌01:00 JST → 翌日
    expect(toDateKey('2026-07-07T16:00:00Z')).toBe('2026-07-08');
    // 14:59Z = 23:59 JST → 同日
    expect(toDateKey('2026-07-07T14:59:00Z')).toBe('2026-07-07');
  });

  it('正常系: Date オブジェクト入力も受け付ける（scheduledAt カラム由来）', () => {
    expect(toDateKey(new Date('2026-07-07T16:00:00Z'))).toBe('2026-07-08');
  });

  it('エッジ: 無効/空は null', () => {
    expect(toDateKey('not-a-date')).toBeNull();
    expect(toDateKey(null)).toBeNull();
    expect(toDateKey(undefined)).toBeNull();
  });
});

describe('extractScheduledAt', () => {
  it('正常系: output JSON の scheduledAt を返す', () => {
    expect(extractScheduledAt(JSON.stringify({ content: 'x', scheduledAt: '2026-08-01T00:00:00+09:00' }))).toBe(
      '2026-08-01T00:00:00+09:00',
    );
  });
  it('エッジ: 無し/非JSON/無効日付は undefined', () => {
    expect(extractScheduledAt(JSON.stringify({ content: 'x' }))).toBeUndefined();
    expect(extractScheduledAt('ただの文字列')).toBeUndefined();
    expect(extractScheduledAt(JSON.stringify({ scheduledAt: 'bad' }))).toBeUndefined();
    expect(extractScheduledAt(null)).toBeUndefined();
  });
});

describe('draftDateKey', () => {
  it('正常系: scheduledAt カラムを最優先（output/createdAt より優先）', () => {
    expect(
      draftDateKey(
        task({
          scheduledAt: new Date('2026-09-20T10:00:00+09:00'),
          output: JSON.stringify({ scheduledAt: '2026-08-15T10:00:00+09:00' }),
          createdAt: '2026-07-01T00:00:00+09:00',
        }),
      ),
    ).toBe('2026-09-20');
  });

  it('後方互換: scheduledAt カラムが無ければ旧 output JSON の scheduledAt、無ければ createdAt', () => {
    expect(
      draftDateKey(
        task({ scheduledAt: null, output: JSON.stringify({ scheduledAt: '2026-08-15T10:00:00+09:00' }), createdAt: '2026-07-01T00:00:00+09:00' }),
      ),
    ).toBe('2026-08-15');
    expect(draftDateKey(task({ scheduledAt: null, output: null, createdAt: '2026-07-03T09:00:00+09:00' }))).toBe('2026-07-03');
  });
});

describe('groupDraftsByDate', () => {
  it('正常系: 日付昇順でグルーピング', () => {
    const days = groupDraftsByDate([
      task({ id: 'a', createdAt: '2026-07-03T09:00:00+09:00' }),
      task({ id: 'b', createdAt: '2026-07-01T09:00:00+09:00' }),
      task({ id: 'c', createdAt: '2026-07-03T20:00:00+09:00' }),
    ]);
    expect(days.map((d) => d.date)).toEqual(['2026-07-01', '2026-07-03']);
    expect(days[1].items.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('エッジ: 日付を決められない下書きは除外', () => {
    const days = groupDraftsByDate([task({ id: 'bad', createdAt: 'nope', output: null })]);
    expect(days).toEqual([]);
  });
});
