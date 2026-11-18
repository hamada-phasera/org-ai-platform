import { blockDataOf, usePageContext } from '../PageContext';
import { DataNotice } from '../DataNotice';
import { formatCell } from '../format';
import type { BlockProps } from './types';

/** 区切り線の行（TOP の案内やメニューと同じ見た目） */
export function ListBlock({ block, index }: BlockProps<'list'>) {
  const ctx = usePageContext();
  const data = blockDataOf(ctx, block.source.action, index);
  if (data.state !== 'ok') return <DataNotice data={data} />;
  if (data.block.type === 'kpi') return null;
  const { rows, truncated } = data.block;
  if (rows.length === 0) return <p className="py-2 text-sm text-muted">{block.empty ?? 'まだありません'}</p>;

  return (
    <div className="space-y-2">
      <ul className="divide-y divide-hairline">
        {rows.map((row, r) => (
          <li key={row.id ?? `r${r}`} className="flex min-h-11 items-center justify-between gap-4 py-2.5">
            <div className="min-w-0">
              <p className="break-words text-sm font-semibold text-primary">{formatCell(row.cells[block.titleKey])}</p>
              {block.subKey && (
                <p className="break-words text-xs text-muted">{formatCell(row.cells[block.subKey])}</p>
              )}
            </div>
            {block.metaKey && (
              <span className="tabular shrink-0 font-mono text-xs text-muted">{formatCell(row.cells[block.metaKey])}</span>
            )}
          </li>
        ))}
      </ul>
      {truncated && <p className="text-xs text-muted">先頭 {rows.length} 件を表示</p>}
    </div>
  );
}
