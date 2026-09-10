import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Globe, KeyRound, ShieldCheck, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

/**
 * チャットに貼られた curl / API ドキュメントから起こしたカスタムノードの確認カード。
 *
 * この画面が存在する理由は**APIキーの経路をここ1本に閉じること**にある。
 *   会話に貼られたキー → gateway の secret-scrubber でマスク（DB にも LLM にも平文は残らない）
 *   本物のキー         → このカードの入力欄 → gateway → sealSecret して保存
 * つまり AI は「どこに何を送るか」の構造だけを見て、鍵そのものは一度も見ない。
 *
 * ⚠️ 入力されたキーはこのコンポーネントの state から出さない。
 *    ログにも、チャット本文にも、他のリクエストにも載せないこと。
 */

export interface HttpNodeHeaderDraft {
  name: string;
  value?: string | null;
  secret?: boolean;
}

export interface HttpNodeParamDraft {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
}

export interface NodeDraft {
  name?: string | null;
  displayName?: string | null;
  description?: string | null;
  department?: string;
  params?: HttpNodeParamDraft[];
  http?: {
    method?: string;
    url?: string;
    headers?: HttpNodeHeaderDraft[];
    bodyTemplate?: Record<string, unknown> | null;
    outputPath?: string | null;
  } | null;
  confidence?: number;
  reasoning?: string;
  urlWarning?: string | null;
  /** 会話に実キーが含まれていてマスクされた */
  secretsScrubbed?: boolean;
}

interface Props {
  draft: NodeDraft;
  busy?: boolean;
  error?: string | null;
  /** secrets は ヘッダ名 → 実際の値 */
  onCreate: (secrets: Record<string, string>) => void;
  onDismiss: () => void;
}

/** 表示用にホストだけ取り出す（クエリに値が載りうるので全体は出さない）。 */
function hostOf(url: string): string {
  try {
    return new URL(url.replace(/\{\{[^}]*\}\}/g, 'x')).host;
  } catch {
    return url.slice(0, 40);
  }
}

export function NodeCtaCard({ draft, busy = false, error, onCreate, onDismiss }: Props) {
  const http = draft.http ?? null;
  const secretHeaders = useMemo(
    () => (http?.headers ?? []).filter((h) => h.secret),
    [http?.headers],
  );
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const method = (http?.method ?? 'GET').toUpperCase();
  const needsApproval = method !== 'GET';
  const blocked = !!draft.urlWarning;
  const missingSecret = secretHeaders.some((h) => !(secrets[h.name] ?? '').trim());
  const canCreate = !blocked && !busy && !missingSecret && !!http?.url && !!draft.name;

  return (
    <motion.div
      className="rounded-2xl border border-border bg-elevated p-4 shadow-elev-1"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="mb-2.5 flex items-start gap-2.5">
        <Globe size={16} className="mt-0.5 flex-shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-primary">
            この外部APIに繋げます — {draft.displayName ?? draft.name ?? '新しい接続'}
          </h3>
          {draft.description && (
            <p className="mt-0.5 text-xs leading-relaxed text-secondary">{draft.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="この提案を閉じる"
          className="flex-shrink-0 rounded-sm p-1 text-muted transition-colors hover:bg-sunken hover:text-primary"
        >
          <X size={13} />
        </button>
      </div>

      {/* 接続先 */}
      <div className="mb-2.5 rounded-xl bg-sunken p-3">
        <p className="text-xs text-secondary">
          <span className="font-mono font-bold text-primary">{method}</span>{' '}
          {http?.url ? hostOf(http.url) : '—'}
        </p>
        {(draft.params ?? []).length > 0 && (
          <p className="mt-1 text-micro text-text-muted">
            送る値: {(draft.params ?? []).map((p) => p.name).join('、')}
          </p>
        )}
        {needsApproval && (
          <p className="mt-1.5 flex w-fit items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-micro font-bold text-warning">
            <ShieldCheck size={10} aria-hidden="true" />
            送信のたびに承認が必要です
          </p>
        )}
      </div>

      {draft.urlWarning && (
        <p className="mb-2.5 flex items-start gap-1.5 text-xs text-danger">
          <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          {draft.urlWarning}
        </p>
      )}

      {/* APIキー。ここが実キーの唯一の入口 */}
      {secretHeaders.length > 0 && !blocked && (
        <div className="mb-2.5 space-y-2">
          {secretHeaders.map((h) => (
            <div key={h.name}>
              <label
                htmlFor={`secret-${h.name}`}
                className="mb-1 flex items-center gap-1.5 text-xs font-bold text-primary"
              >
                <KeyRound size={11} className="text-muted" aria-hidden="true" />
                {h.name}
              </label>
              <Input
                id={`secret-${h.name}`}
                size="sm"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="APIキーを貼り付けてください"
                value={secrets[h.name] ?? ''}
                onChange={(e) => setSecrets((prev) => ({ ...prev, [h.name]: e.target.value }))}
                fullWidth
              />
            </div>
          ))}
          <p className="text-micro leading-relaxed text-text-muted">
            ここに入れた値は<b className="text-secondary">会話にもAIにも渡りません。</b>
            暗号化して保存し、以降このノードを実行するときだけ使われます。
          </p>
        </div>
      )}

      {draft.secretsScrubbed && (
        <p className="mb-2.5 text-micro text-text-muted">
          貼り付けた文章にAPIキーらしき値が含まれていたため、会話の記録からは伏せてあります。
          上の欄に改めて入力してください。
        </p>
      )}

      {error && <p className="mb-2.5 text-xs text-danger">{error}</p>}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          loading={busy}
          disabled={!canCreate}
          onClick={() => onCreate(secrets)}
        >
          この接続を登録
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          あとで
        </Button>
        {missingSecret && !blocked && (
          <span className="text-micro text-text-muted">APIキーを入力すると登録できます</span>
        )}
      </div>
    </motion.div>
  );
}

export default NodeCtaCard;
