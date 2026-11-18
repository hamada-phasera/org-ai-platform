import type { PageRow } from '@org-ai/shared-types';
import { Badge, Button } from '../../ui';
import { blockDataOf, usePageContext } from '../PageContext';
import { DataNotice } from '../DataNotice';
import { formatCell, isNumericFormat } from '../format';
import { useSubmit } from '../useSubmit';
import type { BlockOf, BlockProps } from './types';

type Column = BlockOf<'table'>['columns'][number];

function Cell({ row, column }: { row: PageRow; column: Column }) {
  const text = formatCell(row.cells[column.key], column.format);
  if (column.format === 'badge' && row.cells[column.key] !== null && row.cells[column.key] !== undefined) {
    return <Badge size="xs">{text}</Badge>;
  }
  return <>{text}</>;
}

/**
 * PC は表（hidden lg:block）、スマホは縦積みの行（lg:hidden）。横スクロールを出さない。
 * スマホは primary の列（無ければ先頭）を 1 行目、残りは「ラベル 値」で最大 4 つ。
 */
export function TableBlock({ block, index }: BlockProps<'table'>) {
  const ctx = usePageContext();
  const data = blockDataOf(ctx, block.source.action, index);
  const submit = useSubmit();

  if (data.state !== 'ok' || data.block.type === 'kpi') {
    return data.state === 'ok' ? null : <DataNotice data={data} />;
  }
  const { rows, truncated } = data.block;
  if (rows.length === 0) return <p className="py-2 text-sm text-muted">{block.empty ?? 'まだありません'}</p>;

  const primary = block.columns.find((c) => c.primary) ?? block.columns[0];
  const rest = block.columns.filter((c) => c !== primary).slice(0, 4);
  const rowAction = block.rowAction;
  const runRow = (row: PageRow) => {
    if (!rowAction || row.id === null) return;
    submit.trigger({ actionId: rowAction.action, input: { rowId: row.id }, origin: { blockIndex: index } });
  };

  return (
    <div className="space-y-2">
      <div className="hidden lg:block">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              {block.columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={`py-2 pr-4 text-xs font-semibold text-muted ${isNumericFormat(c.format) ? 'text-right' : ''}`}
                >
                  {c.label}
                </th>
              ))}
              {rowAction && (
                <th scope="col" className="w-24 py-2">
                  <span className="sr-only">操作</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={row.id ?? `r${r}`} className="border-b border-hairline last:border-b-0">
                {block.columns.map((c) => (
                  <td
                    key={c.key}
                    className={`break-words py-2.5 pr-4 text-primary ${isNumericFormat(c.format) ? 'tabular text-right font-mono' : ''}`}
                  >
                    <Cell row={row} column={c} />
                  </td>
                ))}
                {rowAction && (
                  <td className="py-1.5 text-right">
                    {row.id !== null && (
                      <Button size="xs" variant="secondary" disabled={submit.busy} onClick={() => runRow(row)}>
                        {rowAction.label}
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-hairline lg:hidden">
        {rows.map((row, r) => (
          <li key={row.id ?? `r${r}`} className="space-y-1.5 py-3">
            <p className="break-words text-sm font-semibold text-primary">
              <Cell row={row} column={primary} />
            </p>
            {rest.length > 0 && (
              <dl className="space-y-1">
                {rest.map((c) => (
                  <div key={c.key} className="flex gap-3 text-sm">
                    <dt className="w-16 shrink-0 text-muted">{c.label}</dt>
                    <dd className={`min-w-0 break-words text-secondary ${isNumericFormat(c.format) ? 'tabular font-mono' : ''}`}>
                      <Cell row={row} column={c} />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {rowAction && row.id !== null && (
              <Button size="sm" variant="secondary" fullWidth disabled={submit.busy} onClick={() => runRow(row)}>
                {rowAction.label}
              </Button>
            )}
          </li>
        ))}
      </ul>

      {truncated && <p className="text-xs text-muted">先頭 {rows.length} 件を表示</p>}
      {rowAction && submit.feedback}
      {submit.dialog}
    </div>
  );
}
