import { FileText, Table, Presentation, MessageSquare, Loader2 } from 'lucide-react';

export type DeliverableKind = 'doc' | 'sheet' | 'slides' | 'slack';

const ITEMS: { kind: DeliverableKind; label: string; icon: React.ReactNode }[] = [
  { kind: 'doc', label: 'ドキュメント', icon: <FileText size={13} /> },
  { kind: 'sheet', label: 'スプレッドシート', icon: <Table size={13} /> },
  { kind: 'slides', label: 'スライド', icon: <Presentation size={13} /> },
  { kind: 'slack', label: 'Slack投稿', icon: <MessageSquare size={13} /> },
];

interface Props {
  onCreate: (kind: DeliverableKind) => void;
  busy: DeliverableKind | null;
  disabled?: boolean;
}

/** チャットで固まった直近の内容を Google ドキュメント等の成果物に変換するバー。 */
export function DeliverableBar({ onCreate, busy, disabled }: Props) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] text-text-muted">この内容から成果物を作成:</span>
      {ITEMS.map((it) => (
        <button
          key={it.kind}
          type="button"
          disabled={disabled || busy !== null}
          onClick={() => onCreate(it.kind)}
          className="flex items-center gap-1 rounded-full border border-border bg-white px-2.5 py-1 text-[11px] text-secondary transition-all hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {busy === it.kind ? <Loader2 size={13} className="animate-spin" /> : it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}
