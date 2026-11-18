import { blockDataOf, usePageContext, type BlockData } from '../PageContext';
import { DataNotice } from '../DataNotice';
import { formatKpi } from '../format';
import type { BlockProps } from './types';

/** PC は横並び（間は縦の罫線）、スマホは「ラベル｜数字」の行 */
export function KpiBlock({ block, index }: BlockProps<'kpi'>) {
  const ctx = usePageContext();
  const states = block.items.map((item) => blockDataOf(ctx, item.source.action, index));
  const notice = states.find((s): s is Exclude<BlockData, { state: 'ok' }> => s.state !== 'ok');

  return (
    <div>
      <dl className="divide-y divide-hairline lg:flex lg:divide-x lg:divide-y-0 lg:divide-border">
        {block.items.map((item, i) => {
          const s = states[i];
          const value = s.state === 'ok' && s.block.type === 'kpi' ? s.block.values[i] : null;
          return (
            <div
              key={i}
              className="flex min-h-11 items-center justify-between gap-4 py-2 lg:block lg:flex-1 lg:px-6 lg:py-0 lg:first:pl-0"
            >
              <dt className="text-xs font-semibold text-muted">{item.label}</dt>
              <dd className="tabular font-mono text-lg font-bold text-primary lg:mt-1 lg:text-2xl">
                {formatKpi(value, item.format)}
              </dd>
            </div>
          );
        })}
      </dl>
      {notice && notice.state !== 'loading' && <DataNotice data={notice} />}
    </div>
  );
}
