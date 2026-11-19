import { useId } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Badge } from '../ui';
import { PageIconGlyph } from './PageIconGlyph';
import { canOpenTarget, isApprovalsTarget, isUncreated, nextText, type BusinessRow } from './canvasToList';

interface Props {
  rows: BusinessRow[];
  approvalsCount: number;
  /** テンプレートからフローを作れる（ADMIN 以上） */
  canCreate: boolean;
  onOpen: (row: BusinessRow) => void;
  /** 作成中のノード */
  pendingId?: string | null;
}

/**
 * 業務の縦リスト（docs/design/canvas-home.md §4.2）。スマホのホームと、PC のキャンバスの読み込み中に出す。
 * 区切り線の行・1 列・行全体が押せる（56px 以上）。カードで包まない。
 * 未作成のノードは MEMBER には aria-disabled（押すと「まだ用意されていません」の 1 行だけ。作成はしない）。
 * ⚠️ `@xyflow/react` を import しない（スマホで読み込まない。K20）。
 */
export function BusinessList({ rows, approvalsCount, canCreate, onOpen, pendingId = null }: Props) {
  const idBase = useId();
  if (rows.length === 0) {
    return <p className="py-4 text-sm text-secondary">業務はまだありません</p>;
  }
  return (
    <ul className="divide-y divide-hairline border-y border-border" aria-label="業務">
      {rows.map((row, i) => {
        const enabled = canOpenTarget(row.target, canCreate);
        const next = nextText(row);
        const count = isApprovalsTarget(row.target) ? approvalsCount : 0;
        const pending = pendingId === row.id;
        const uncreated = isUncreated(row.target);
        // 名前は「〇〇を開く」のまま（K68）。補足（次・未作成・承認待ち）は aria-describedby で読ませる
        const rid = `${idBase}-${i}`;
        const describedBy = [next && `${rid}-next`, uncreated && `${rid}-new`, count > 0 && `${rid}-count`]
          .filter(Boolean)
          .join(' ');
        return (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => row.target.kind !== 'missing' && onOpen(row)}
              aria-disabled={!enabled || undefined}
              aria-busy={pending || undefined}
              aria-label={`${row.label}を開く`}
              aria-describedby={describedBy || undefined}
              className={`flex min-h-14 w-full items-center gap-3 px-1 py-2.5 text-left transition-colors duration-fast ${
                enabled ? 'hover:bg-sunken' : 'cursor-default'
              }`}
            >
              <PageIconGlyph name={row.icon} size={18} strokeWidth={2} className="shrink-0 text-secondary" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-bold text-primary">{row.label}</span>
                {next && <span id={`${rid}-next`} className="mt-0.5 block truncate text-xs text-text-muted">
                    次: {next}
                  </span>}
              </span>
              {uncreated && (
                <span id={`${rid}-new`}>
                  <Badge size="xs">未作成</Badge>
                </span>
              )}
              {count > 0 && (
                <span
                  id={`${rid}-count`}
                  className="shrink-0 font-mono text-sm font-bold text-warning tabular"
                  aria-label={`承認待ち ${count}件`}
                >
                  {count}
                </span>
              )}
              {pending ? (
                <Loader2 size={16} className="shrink-0 animate-spin text-text-muted" aria-hidden="true" />
              ) : (
                <ChevronRight size={16} className={`shrink-0 ${enabled ? 'text-text-muted' : 'text-ink-decorative'}`} aria-hidden="true" />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
