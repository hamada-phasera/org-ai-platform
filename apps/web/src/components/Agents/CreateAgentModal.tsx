import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { X, Sparkles } from 'lucide-react';
import { api } from '../../services/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { DEPARTMENTS } from '../../constants/departments';
import type { SavedAgent } from '../../types/agent';

interface Props {
  onClose: () => void;
  onCreated: (agent: SavedAgent) => void;
  /** チャット等から渡される初期説明文（プリフィル用）。 */
  initialDescription?: string;
  /** チャットのエージェント化提案からプリフィルする名前・指示・部署。 */
  initialName?: string;
  initialInstructions?: string;
  initialDepartment?: string;
}

const ICONS = ['🤖', '📣', '📊', '📈', '🧮', '🛡️', '✨', '📝', '📧', '🔍'];

/** 業務効率化エージェントの作成フォーム。手入力 or 説明文からの AI 提案（inferFromDescription）に対応。 */
export function CreateAgentModal({
  onClose,
  onCreated,
  initialDescription,
  initialName,
  initialInstructions,
  initialDepartment,
}: Props) {
  const [name, setName] = useState(initialName ?? '');
  const [description, setDescription] = useState(initialDescription ?? '');
  const [department, setDepartment] = useState(initialDepartment ?? 'GENERAL');
  const [instructions, setInstructions] = useState(initialInstructions ?? '');
  const [trigger, setTrigger] = useState<'MANUAL' | 'SCHEDULED'>('MANUAL');
  const [icon, setIcon] = useState('🤖');
  const [useInfer, setUseInfer] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  /* a11y: Escape で閉じる */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* a11y: マウント時に最初のフォーカス可能要素へフォーカス */
  useEffect(() => {
    dialogRef.current
      ?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      ?.focus();
  }, []);

  const canSubmit = useInfer
    ? description.trim().length > 0
    : name.trim().length > 0 && instructions.trim().length > 0;

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        department,
        instructions: instructions.trim() || undefined,
        trigger,
        icon,
        inferFromDescription: useInfer || undefined,
      };
      // inferFromDescription 時に name 未入力でも通すため、name 必須を緩める
      if (!useInfer && !body.name) {
        setError('エージェント名を入力してください');
        setSubmitting(false);
        return;
      }
      const res = await api.post<{ success: boolean; data: SavedAgent }>('/agents', body);
      onCreated(res.data.data);
      onClose();
    } catch (e) {
      const msg =
        (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ?? (e instanceof Error ? e.message : '作成に失敗しました');
      setError(msg);
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-agent-title"
        className="bg-elevated border border-border rounded-panel overflow-hidden w-full max-w-lg max-h-[88vh] overflow-y-auto p-6 shadow-elev-3"
        initial={{ scale: 0.95, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="brand-strip -mx-6 -mt-6 mb-5 rounded-none" aria-hidden="true" />
        <div className="flex items-center justify-between mb-4">
          <h2 id="create-agent-title" className="text-body font-semibold text-primary">
            エージェントを作成
          </h2>
          <button onClick={onClose} aria-label="閉じる" className="text-muted hover:text-primary">
            <X size={18} />
          </button>
        </div>

        <label className="flex items-center gap-2 mb-4 text-xs text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={useInfer}
            onChange={(e) => setUseInfer(e.target.checked)}
            className="accent-current"
          />
          <Sparkles size={13} className="text-warning" />
          説明文からAIに内容を提案させる（名前・指示・部署を自動設定）
        </label>

        <div className="space-y-3">
          {!useInfer && (
            <div>
              <label htmlFor="create-agent-name" className="block text-xs text-secondary mb-1">
                エージェント名
              </label>
              <Input
                id="create-agent-name"
                placeholder="例: 週次売上レポート"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
              />
            </div>
          )}

          <div>
            <label htmlFor="create-agent-description" className="block text-xs text-secondary mb-1">
              {useInfer ? '作りたいエージェントの説明（必須）' : '説明（任意）'}
            </label>
            <Input
              id="create-agent-description"
              multiline
              rows={useInfer ? 4 : 2}
              placeholder="例: 毎週月曜に見込み客へフォローメールの下書きを作る"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div>
            <span id="create-agent-department-label" className="block text-xs text-secondary mb-1">
              部署
            </span>
            <div
              role="group"
              aria-labelledby="create-agent-department-label"
              className="flex flex-wrap gap-1.5"
            >
              {DEPARTMENTS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setDepartment(d.key)}
                  disabled={submitting}
                  aria-pressed={department === d.key}
                  className={`text-xs px-2.5 py-1.5 rounded-sm border transition-all ${
                    department === d.key
                      ? 'bg-accent-soft border-accent-soft-border text-accent font-semibold shadow-elev-1'
                      : 'bg-sunken border-border text-secondary hover:text-primary'
                  }`}
                >
                  {d.icon} {d.label}
                </button>
              ))}
            </div>
          </div>

          {!useInfer && (
            <div>
              <label htmlFor="create-agent-instructions" className="block text-xs text-secondary mb-1">
                指示（システムプロンプト）
              </label>
              <Input
                id="create-agent-instructions"
                multiline
                rows={4}
                placeholder="このエージェントが毎回従う役割・指示を具体的に記述"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                disabled={submitting}
              />
            </div>
          )}

          <div className="flex items-center justify-between gap-4">
            <div>
              <span id="create-agent-icon-label" className="block text-xs text-secondary mb-1">
                アイコン
              </span>
              <div role="group" aria-labelledby="create-agent-icon-label" className="flex flex-wrap gap-1">
                {ICONS.map((ic) => (
                  <button
                    key={ic}
                    type="button"
                    onClick={() => setIcon(ic)}
                    disabled={submitting}
                    aria-pressed={icon === ic}
                    className={`text-base w-7 h-7 rounded-sm border transition-all ${
                      icon === ic
                        ? 'bg-accent-soft border-accent-soft-border shadow-elev-1'
                        : 'border-transparent hover:bg-sunken'
                    }`}
                  >
                    {ic}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span id="create-agent-trigger-label" className="block text-xs text-secondary mb-1">
                実行
              </span>
              <div role="group" aria-labelledby="create-agent-trigger-label" className="flex gap-1">
                {(['MANUAL', 'SCHEDULED'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTrigger(t)}
                    disabled={submitting}
                    aria-pressed={trigger === t}
                    className={`text-xs px-2.5 py-1.5 rounded-sm border transition-all ${
                      trigger === t
                        ? 'bg-accent-soft border-accent-soft-border text-accent font-semibold shadow-elev-1'
                        : 'bg-sunken border-border text-secondary hover:text-primary'
                    }`}
                  >
                    {t === 'MANUAL' ? '手動' : '定期'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {error && (
          <p aria-live="polite" className="mt-3 text-xs text-danger">
            {error}
          </p>
        )}

        <div className="mt-5 flex gap-2">
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={!canSubmit || submitting}
          >
            {useInfer ? 'AIに提案させて作成' : '作成する'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            キャンセル
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
