import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Bot, Inbox, RefreshCw, Users, X } from 'lucide-react';
import type { AgentStepApprovalData } from '@org-ai/shared-types';
import { api } from '../services/api';
import { Button, EmptyState, ErrorState, Input, PageHeader, SkeletonList } from '../components/ui';
import { LiquidTabs } from '../components/motion/LiquidTabs';
import { RunPreviewRow } from '../components/exec-kernel/RunPreviewRow';

/**
 * 受信（LINE受信箱 + エージェント承認）。
 *
 * LINEグループで @メンションされた依頼がここに届き、AIの返信下書きを
 * 人が確認・編集してから送信する（全件承認制。自動返信はしない）。
 * 送信は LINE push API 経由 — 承認を待つ設計のため replyToken は使わない。
 *
 * エージェントのステップ実行も、外部に送信するステップ（メール送信・Slack投稿など）は
 * 実行前にここへ積まれる。定期実行で誰も見ていない時間に走っても、送信だけは人が通す。
 */

type InboxStatus =
  | 'RECEIVED'
  | 'DRAFTED'
  | 'DRAFT_FAILED'
  | 'SENT'
  | 'REJECTED'
  | 'SEND_FAILED'
  | 'SKIPPED';

interface InboxMessage {
  id: string;
  sourceType: 'group' | 'room' | 'user';
  groupId: string | null;
  lineUserId: string | null;
  senderName: string | null;
  messageType: string;
  text: string | null;
  status: InboxStatus;
  draft: string | null;
  draftError: string | null;
  replyText: string | null;
  repliedAt: string | null;
  receivedAt: string;
  createdAt: string;
}

type ViewFilter = 'PENDING' | 'AGENT' | 'SENT' | 'REJECTED' | 'ALL';

/** エージェントのステップ承認待ち（Task） */
interface AgentApprovalTask {
  id: string;
  title: string;
  status: string;
  approvalData: string | null;
  createdAt: string;
}

const PENDING_STATUSES: InboxStatus[] = ['RECEIVED', 'DRAFTED', 'DRAFT_FAILED', 'SEND_FAILED'];

/* ステータスの意味色は既存規約: 承認待ち=warning / 送信済み=success / 却下=装飾グレー */
const STATUS_BADGE: Record<InboxStatus, { label: string; className: string }> = {
  RECEIVED: { label: '下書き生成中…', className: 'bg-info/10 text-info' },
  DRAFTED: { label: '承認待ち', className: 'bg-warning/10 text-warning' },
  DRAFT_FAILED: { label: '下書き失敗（手書きで送信可）', className: 'bg-warning/10 text-warning' },
  SENT: { label: '送信済み', className: 'bg-success/10 text-success' },
  REJECTED: { label: '却下', className: 'bg-sunken text-ink-decorative' },
  SEND_FAILED: { label: '送信失敗（再承認で再送）', className: 'bg-danger/10 text-danger' },
  SKIPPED: { label: 'テキスト以外', className: 'bg-sunken text-ink-decorative' },
};

async function fetchMessages(): Promise<InboxMessage[]> {
  const res = await api.get<{ success: boolean; data: InboxMessage[] }>('/inbox/messages');
  return res.data.data;
}

async function fetchAgentApprovals(): Promise<AgentApprovalTask[]> {
  const res = await api.get<{ success: boolean; data: AgentApprovalTask[] }>(
    '/tasks?status=PENDING_APPROVAL&taskType=agent',
  );
  return res.data.data;
}

/** approvalData をエージェントのステップ承認として読む（他形式の承認は無視）。 */
function parseStepApproval(raw: string | null): AgentStepApprovalData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AgentStepApprovalData;
    return parsed?.kind === 'agent_step' ? parsed : null;
  } catch {
    return null;
  }
}

/** 承認画面で編集させる本文フィールド（capability ごとに主役の引数が違う）。 */
function primaryTextKey(args: Record<string, unknown>): string | null {
  for (const key of ['text', 'body', 'content', 'message']) {
    if (typeof args[key] === 'string') return key;
  }
  return null;
}

export default function InboxPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<ViewFilter>('PENDING');
  /* カードごとの下書き編集内容。未編集なら draft をそのまま使う */
  const [edits, setEdits] = useState<Record<string, string>>({});
  /* 送信確認（RunPreviewRow）を開いているメッセージ */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const messagesQ = useQuery({
    queryKey: ['inbox-messages'],
    queryFn: fetchMessages,
    refetchInterval: 15_000,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['inbox-messages'] });

  /* エージェントのステップ承認待ち（LINE 受信箱と同じ 15 秒ポーリングに相乗り） */
  const approvalsQ = useQuery({
    queryKey: ['agent-approvals'],
    queryFn: fetchAgentApprovals,
    refetchInterval: 15_000,
  });
  const invalidateApprovals = () => qc.invalidateQueries({ queryKey: ['agent-approvals'] });
  /* 承認カードで編集中の本文 */
  const [stepEdits, setStepEdits] = useState<Record<string, string>>({});

  const stepApproveMut = useMutation({
    mutationFn: ({ id, editedArgs }: { id: string; editedArgs?: Record<string, unknown> }) =>
      api.post(`/tasks/${id}/approve`, editedArgs ? { editedArgs } : {}),
    onSuccess: invalidateApprovals,
  });
  const stepRejectMut = useMutation({
    mutationFn: (id: string) => api.post(`/tasks/${id}/reject`, {}),
    onSuccess: invalidateApprovals,
  });

  const approveMut = useMutation({
    mutationFn: ({ id, replyText }: { id: string; replyText: string }) =>
      api.post(`/inbox/messages/${id}/approve`, { replyText }),
    onSuccess: () => {
      setConfirmingId(null);
      invalidate();
    },
  });
  const rejectMut = useMutation({
    mutationFn: (id: string) => api.post(`/inbox/messages/${id}/reject`, {}),
    onSuccess: invalidate,
  });
  const regenMut = useMutation({
    mutationFn: (id: string) => api.post(`/inbox/messages/${id}/regenerate`),
    onSuccess: (_res, id) => {
      setEdits((e) => {
        const next = { ...e };
        delete next[id];
        return next;
      });
      invalidate();
    },
  });

  const all = messagesQ.data ?? [];
  const visible = all.filter((m) => {
    if (m.status === 'SKIPPED') return view === 'ALL';
    if (view === 'ALL') return true;
    if (view === 'PENDING') return PENDING_STATUSES.includes(m.status);
    return m.status === view;
  });
  const pendingCount = all.filter((m) => PENDING_STATUSES.includes(m.status)).length;
  const approvals = (approvalsQ.data ?? []).filter((t) => parseStepApproval(t.approvalData));
  const approvalCount = approvals.length;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        eyebrow="Inbox"
        title="受信"
        description="LINEの依頼とエージェントの送信内容を、人が確認してから通します（承認するまで送信されません）。"
        actions={
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Inbox size={18} />
          </div>
        }
      />

      <div className="mb-5 flex items-center justify-between gap-3">
        <LiquidTabs<ViewFilter>
          id="inbox-view"
          size="sm"
          label="受信箱の表示切り替え"
          items={[
            {
              value: 'PENDING',
              label: '対応待ち',
              badge:
                pendingCount > 0 ? (
                  <span className="tabular text-micro font-bold text-warning">{pendingCount}</span>
                ) : undefined,
            },
            {
              value: 'AGENT',
              label: 'エージェント承認',
              badge:
                approvalCount > 0 ? (
                  <span className="tabular text-micro font-bold text-warning">{approvalCount}</span>
                ) : undefined,
            },
            { value: 'SENT', label: '送信済み' },
            { value: 'REJECTED', label: '却下' },
            { value: 'ALL', label: 'すべて' },
          ]}
          value={view}
          onChange={setView}
        />
        <p className="text-micro text-text-muted">15秒ごとに自動更新</p>
      </div>

      {view === 'AGENT' ? (
        approvalsQ.isLoading ? (
          <SkeletonList count={2} />
        ) : approvalsQ.isError ? (
          <ErrorState onRetry={() => approvalsQ.refetch()} />
        ) : approvals.length === 0 ? (
          <EmptyState
            icon={<Bot size={22} />}
            title="承認待ちはありません"
            description="エージェントが外部に送信するステップ（メール送信・Slack投稿など）に来ると、送信前にここへ届きます。"
          />
        ) : (
          <div className="space-y-4">
            {approvals.map((task) => {
              const approval = parseStepApproval(task.approvalData)!;
              const textKey = primaryTextKey(approval.args);
              const editedText =
                textKey !== null ? (stepEdits[task.id] ?? String(approval.args[textKey] ?? '')) : null;
              const args = Object.entries(approval.args).map(([key, value]) => ({
                key,
                value:
                  textKey === key && editedText !== null
                    ? editedText
                    : typeof value === 'string'
                      ? value
                      : JSON.stringify(value),
              }));
              return (
                <motion.article
                  key={task.id}
                  layout
                  className="rounded-lg border border-border bg-elevated p-5 shadow-elev-1"
                >
                  <div className="mb-2.5 flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sunken text-secondary">
                      <Bot size={14} aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-primary">{task.title}</p>
                      <p className="tabular text-micro text-text-muted">
                        {new Date(task.createdAt).toLocaleString('ja-JP')}
                      </p>
                    </div>
                    <span className="rounded-full bg-warning/10 px-2.5 py-1 text-micro font-bold text-warning">
                      送信前の承認待ち
                    </span>
                  </div>

                  {textKey !== null && (
                    <div className="mb-3">
                      <label
                        htmlFor={`step-text-${task.id}`}
                        className="mb-1 block text-micro font-bold uppercase tracking-[0.07em] text-text-muted"
                      >
                        送信内容（編集できます）
                      </label>
                      <Input
                        multiline
                        id={`step-text-${task.id}`}
                        rows={3}
                        value={editedText ?? ''}
                        onChange={(e) =>
                          setStepEdits((prev) => ({ ...prev, [task.id]: e.target.value }))
                        }
                      />
                    </div>
                  )}

                  <RunPreviewRow
                    preview={{ capabilityLabel: approval.capabilityLabel, args }}
                    busy={stepApproveMut.isPending && stepApproveMut.variables?.id === task.id}
                    onApprove={() =>
                      stepApproveMut.mutate({
                        id: task.id,
                        editedArgs:
                          textKey !== null && editedText !== null
                            ? { ...approval.args, [textKey]: editedText }
                            : undefined,
                      })
                    }
                    onCancel={() => stepRejectMut.mutate(task.id)}
                  />
                  {stepApproveMut.isError && stepApproveMut.variables?.id === task.id && (
                    <p className="mt-2 text-xs text-danger" aria-live="polite">
                      実行に失敗しました。時間をおいて再度お試しください。
                    </p>
                  )}
                </motion.article>
              );
            })}
          </div>
        )
      ) : messagesQ.isLoading ? (
        <SkeletonList count={3} />
      ) : messagesQ.isError ? (
        <ErrorState onRetry={() => messagesQ.refetch()} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Inbox size={22} />}
          title={view === 'PENDING' ? '対応待ちはありません' : '該当するメッセージはありません'}
          description="LINEグループで bot を @メンションすると、依頼がここに届きます。接続は 設定 > 連携 から。"
        />
      ) : (
        <div className="space-y-4">
          {visible.map((m) => {
            const replyText = edits[m.id] ?? m.draft ?? '';
            const canAct = PENDING_STATUSES.includes(m.status);
            const confirming = confirmingId === m.id;
            return (
              <motion.article
                key={m.id}
                layout
                className="rounded-lg border border-border bg-elevated p-5 shadow-elev-1"
              >
                <div className="mb-2.5 flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sunken text-secondary">
                    <Users size={14} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-primary">
                      {m.senderName ?? '（表示名不明）'}
                      <span className="ml-2 text-micro font-medium text-text-muted">
                        {m.sourceType === 'user' ? '1:1トーク' : 'グループ'}
                      </span>
                    </p>
                    <p className="tabular text-micro text-text-muted">
                      {new Date(m.receivedAt).toLocaleString('ja-JP')}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-micro font-bold ${STATUS_BADGE[m.status].className}`}
                  >
                    {STATUS_BADGE[m.status].label}
                  </span>
                </div>

                <p className="whitespace-pre-wrap rounded-md bg-sunken px-3.5 py-2.5 text-sm text-primary">
                  {m.text ?? `（${m.messageType}）`}
                </p>

                {m.status === 'SENT' && m.replyText && (
                  <div className="mt-3">
                    <p className="mb-1 text-micro font-bold uppercase tracking-[0.07em] text-text-muted">
                      送信した返信
                    </p>
                    <p className="whitespace-pre-wrap rounded-md border border-border px-3.5 py-2.5 text-sm text-secondary">
                      {m.replyText}
                    </p>
                  </div>
                )}

                {canAct && (
                  <div className="mt-3.5 space-y-3">
                    <div>
                      <label
                        htmlFor={`draft-${m.id}`}
                        className="mb-1 block text-micro font-bold uppercase tracking-[0.07em] text-text-muted"
                      >
                        返信の下書き{m.status === 'DRAFT_FAILED' ? '（AI生成に失敗 — 手書きできます）' : '（編集できます）'}
                      </label>
                      <Input
                        multiline
                        id={`draft-${m.id}`}
                        rows={3}
                        placeholder={m.status === 'RECEIVED' ? 'AIが下書きを生成中です…' : '返信内容'}
                        value={replyText}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [m.id]: e.target.value }))}
                      />
                      {m.draftError && (
                        <p className="mt-1 text-micro text-danger">{m.draftError}</p>
                      )}
                    </div>

                    {confirming ? (
                      <RunPreviewRow
                        preview={{
                          capabilityLabel: 'LINEに返信',
                          args: [
                            { key: '宛先', value: m.sourceType === 'user' ? `${m.senderName ?? ''}さんとの1:1トーク` : 'グループ全員に見えます' },
                            { key: '本文', value: replyText },
                          ],
                        }}
                        busy={approveMut.isPending}
                        onApprove={() => approveMut.mutate({ id: m.id, replyText })}
                        onCancel={() => setConfirmingId(null)}
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={!replyText.trim()}
                          onClick={() => setConfirmingId(m.id)}
                        >
                          返信内容を確認
                        </Button>
                        <Button
                          size="sm"
                          variant="glass"
                          icon={<RefreshCw size={12} />}
                          loading={regenMut.isPending && regenMut.variables === m.id}
                          onClick={() => regenMut.mutate(m.id)}
                        >
                          下書きを再生成
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<X size={12} />}
                          loading={rejectMut.isPending && rejectMut.variables === m.id}
                          onClick={() => rejectMut.mutate(m.id)}
                        >
                          返信しない
                        </Button>
                      </div>
                    )}
                    {approveMut.isError && confirming && (
                      <p className="text-xs text-danger" aria-live="polite">
                        送信に失敗しました。時間をおいて再度承認するとリトライされます。
                      </p>
                    )}
                  </div>
                )}
              </motion.article>
            );
          })}
        </div>
      )}
    </div>
  );
}
