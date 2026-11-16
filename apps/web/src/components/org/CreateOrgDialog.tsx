import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '../ui';
import { createOrg } from '../../services/session';
import { sessionDeps } from '../../services/sessionDeps';

/**
 * 新しい組織を作るダイアログ（組織名だけ）。作ったら新しい組織に切り替わる。
 * docs/design/multi-tenancy.md §10.1 / UC1
 */
export function CreateOrgDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createOrg(sessionDeps, name.trim());
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message;
      setError(msg ?? '組織を作成できませんでした');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-org-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-sm space-y-3 rounded-lg border border-border bg-elevated p-5 shadow-lg"
      >
        <h2 id="create-org-title" className="text-sm font-extrabold text-primary">
          新しい組織を作成
        </h2>
        <p className="text-xs leading-relaxed text-muted">
          関連会社や別の事業所など、データを分けて管理したいときに作ります。作った組織のオーナーになり、そのまま切り替わります。
        </p>
        <div>
          <label htmlFor="create-org-name" className="mb-1 block text-xs font-bold text-primary">
            組織名
          </label>
          <Input
            id="create-org-name"
            ref={inputRef}
            size="md"
            fullWidth
            maxLength={120}
            placeholder="株式会社〇〇"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" loading={busy} disabled={!name.trim()}>
            作成して切り替える
          </Button>
        </div>
      </form>
    </div>
  );
}
