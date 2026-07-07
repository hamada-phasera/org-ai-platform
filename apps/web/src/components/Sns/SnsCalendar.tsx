import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { GlassCard } from '../ui/GlassCard';

/** N-3: 下書きを日付にひも付けて月グリッドで表示する（読み取り専用）。 */

export interface CalendarDraft {
  id: string;
  status: string;
  output: string | null;
  createdAt: string;
}

const TZ = 'Asia/Tokyo';
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const STATUS_DOT: Record<string, string> = {
  PENDING_APPROVAL: '#F59E0B',
  APPROVED: '#10B981',
  REJECTED: '#94A3B8',
  DONE: '#10B981',
};

/** scheduledAt(あれば) or createdAt を JST の YYYY-MM-DD に丸める。 */
function dateKeyOf(task: CalendarDraft): string | null {
  let iso: string | undefined = task.createdAt;
  if (task.output) {
    try {
      const j = JSON.parse(task.output) as { scheduledAt?: unknown };
      if (typeof j.scheduledAt === 'string' && !Number.isNaN(new Date(j.scheduledAt).getTime())) {
        iso = j.scheduledAt;
      }
    } catch {
      /* ignore */
    }
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function keyFor(year: number, month0: number, day: number): string {
  return `${year}-${String(month0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function SnsCalendar({ tasks }: { tasks: CalendarDraft[] }) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month0: now.getMonth() };
  });

  const byDate = useMemo(() => {
    const m = new Map<string, CalendarDraft[]>();
    for (const t of tasks) {
      const k = dateKeyOf(t);
      if (!k) continue;
      const arr = m.get(k);
      if (arr) arr.push(t);
      else m.set(k, [t]);
    }
    return m;
  }, [tasks]);

  const { year, month0 } = cursor;
  const firstWeekday = new Date(year, month0, 1).getDay();
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const shift = (delta: number) => {
    const d = new Date(year, month0 + delta, 1);
    setCursor({ year: d.getFullYear(), month0: d.getMonth() });
  };

  return (
    <GlassCard variant="regular" className="p-4">
      <div className="flex items-center justify-between mb-3">
        <button onClick={() => shift(-1)} aria-label="前の月" className="text-muted hover:text-primary">
          <ChevronLeft size={18} />
        </button>
        <h3 className="text-sm font-semibold text-primary">
          {year}年{month0 + 1}月
        </h3>
        <button onClick={() => shift(1)} aria-label="次の月" className="text-muted hover:text-primary">
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-[10px] text-muted py-1">
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`b${i}`} />;
          const items = byDate.get(keyFor(year, month0, day)) ?? [];
          return (
            <div
              key={day}
              className="min-h-[52px] rounded-lg p-1 text-left glass-thin"
              title={items.length ? `${items.length}件の下書き` : undefined}
            >
              <div className="text-[10px] text-secondary">{day}</div>
              {items.length > 0 && (
                <div className="mt-0.5 flex flex-wrap gap-0.5 items-center">
                  {items.slice(0, 6).map((t) => (
                    <span
                      key={t.id}
                      className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: STATUS_DOT[t.status] ?? '#94A3B8' }}
                    />
                  ))}
                  {items.length > 6 && <span className="text-[9px] text-muted">+{items.length - 6}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </GlassCard>
  );
}
