/**
 * 送信（submit）の共通の流れ: confirm があれば確認 → POST（requestId は毎回新しく）→ 成功なら refresh の query を取り直す。
 * 送信中はブロックのボタンをすべて止める（連打で二重送信しない。gateway も requestId で 409）。
 */
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PageActionOrigin } from '@org-ai/shared-types';
import { api } from '../../services/api';
import { apiErrorOf, type PageSubmitData } from './pagesApi';
import { pageDataKey, queryActionIdsOf, usePageContext } from './PageContext';
import { ConfirmDialog } from './ConfirmDialog';
import { SubmitFeedback } from './SubmitFeedback';

export interface SubmitResult {
  ok: boolean;
  message: string;
  code: string | null;
}

/** RFC 4122 v4。crypto.randomUUID の無い古いブラウザでも getRandomValues で作る */
export function newRequestId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface Pending {
  actionId: string;
  input: Record<string, unknown>;
  origin: PageActionOrigin;
  onDone?: (r: SubmitResult) => void;
}

export function useSubmit(): {
  trigger: (p: Pending) => void;
  busy: boolean;
  result: SubmitResult | null;
  dialog: ReactNode;
  feedback: ReactNode;
} {
  const { slug, definition } = usePageContext();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [confirming, setConfirming] = useState<Pending | null>(null);

  const run = async (p: Pending) => {
    setBusy(true);
    setResult(null);
    let r: SubmitResult;
    try {
      const res = await api.post<{ success: boolean; data: PageSubmitData }>(
        `/pages/${encodeURIComponent(slug)}/actions/${encodeURIComponent(p.actionId)}`,
        { input: p.input, requestId: newRequestId(), origin: p.origin },
      );
      const data = res.data.data;
      r = {
        ok: data.ok === true,
        message: data.message ?? (data.ok ? '送信しました' : '送信できませんでした'),
        code: null,
      };
      if (r.ok) {
        const action = definition.actions[p.actionId];
        const refresh =
          action?.kind === 'submit' && action.refresh ? action.refresh : queryActionIdsOf(definition);
        await Promise.all([
          ...refresh.map((id) => qc.invalidateQueries({ queryKey: pageDataKey(slug, id) })),
          qc.invalidateQueries({ queryKey: ['page', slug] }),
        ]);
      }
    } catch (err) {
      const e = apiErrorOf(err);
      r = { ok: false, message: e.message ?? '送信できませんでした', code: e.code };
    }
    setResult(r);
    setBusy(false);
    p.onDone?.(r);
  };

  const trigger = (p: Pending) => {
    if (busy) return;
    const action = definition.actions[p.actionId];
    if (action?.kind === 'submit' && action.confirm) setConfirming(p);
    else void run(p);
  };

  const confirmAction = confirming ? definition.actions[confirming.actionId] : undefined;
  const dialog =
    confirming && confirmAction?.kind === 'submit' && confirmAction.confirm ? (
      <ConfirmDialog
        message={confirmAction.confirm}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const p = confirming;
          setConfirming(null);
          void run(p);
        }}
      />
    ) : null;

  return { trigger, busy, result, dialog, feedback: <SubmitFeedback result={result} /> };
}
