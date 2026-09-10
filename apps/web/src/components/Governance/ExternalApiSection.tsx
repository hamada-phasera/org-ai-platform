import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, PauseCircle, PlayCircle, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { Button, Card, EmptyState, SkeletonList } from '../ui';

/**
 * ガバナンス > 外部API接続。
 *
 * 作るのはチャット、**棚卸しと停止はここ**、という役割分担にしている。
 * 設定 > 連携が「繋ぐ操作」なのに対し、こちらは
 * 「誰がどの外部APIに繋いでいて、最後にいつ・何回使われ、どれだけ失敗したか」を見る場所。
 */

interface CapabilityRow {
  id: string;
  name: string;
  displayName: string;
  description: string;
  status: string;
  kind: string;
  createdBy: string | null;
  createdAt: string;
  httpConfig: {
    method: string;
    url: string;
    params?: Array<{ name: string; required: boolean }>;
    headers?: Array<{ name: string; secret: boolean }>;
  } | null;
}

interface ExecutionLogRow {
  id: string;
  capabilityId: string | null;
  status: string;
  errorType: string | null;
  createdAt: string;
}

interface ProviderConnectionRow {
  provider: string;
  displayName: string | null;
  status: string;
  lastCheckedAt: string | null;
}

/** 表示用にホスト名だけ取り出す（クエリに値が載りうるので全体は出さない）。 */
function hostOf(url: string): string {
  try {
    return new URL(url.replace(/\{\{[^}]*\}\}/g, 'x')).host;
  } catch {
    return url.slice(0, 40);
  }
}

export function ExternalApiSection() {
  const qc = useQueryClient();

  const capsQ = useQuery({
    queryKey: ['capabilities'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: CapabilityRow[] }>('/capabilities');
      return res.data.data;
    },
  });

  /* ⚠️ このエンドポイントはこれまでフロントで一度も使われていなかった。
     外部APIの実行実績が画面に出るのはここが初めて。 */
  const logsQ = useQuery({
    queryKey: ['capability-execution-logs'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: ExecutionLogRow[] }>(
        '/capabilities/execution-logs?limit=200',
      );
      return res.data.data;
    },
  });

  const providersQ = useQuery({
    queryKey: ['provider-connections'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: ProviderConnectionRow[] }>('/integrations');
      return res.data.data;
    },
    retry: false,
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/capabilities/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['capabilities'] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/capabilities/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['capabilities'] }),
    onError: (err) => {
      const data = (err as { response?: { data?: { error?: { message?: string } } } }).response?.data;
      alert(data?.error?.message ?? '削除できませんでした');
    },
  });

  /* capability ごとの実行実績を集計 */
  const stats = useMemo(() => {
    const map = new Map<string, { total: number; failed: number; last: string | null }>();
    for (const log of logsQ.data ?? []) {
      if (!log.capabilityId) continue;
      const cur = map.get(log.capabilityId) ?? { total: 0, failed: 0, last: null };
      cur.total += 1;
      if (log.status !== 'success') cur.failed += 1;
      if (!cur.last || log.createdAt > cur.last) cur.last = log.createdAt;
      map.set(log.capabilityId, cur);
    }
    return map;
  }, [logsQ.data]);

  const customNodes = (capsQ.data ?? []).filter((c) => c.kind === 'http');

  return (
    <div className="space-y-5">
      <Card variant="thin" padding="md" radius="2xl">
        <p className="text-xs leading-relaxed text-secondary">
          チャットから作った外部API接続の一覧です。
          <b className="text-primary">送信を伴うノード（GET 以外）は、実行前に必ず人の承認が入ります。</b>
          怪しい動きがあれば一時停止できます。
        </p>
      </Card>

      {/* ── カスタムノード ── */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Globe size={16} className="text-accent" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-primary">外部API接続（チャットから作成）</h2>
          <span className="ml-auto tabular text-[11px] text-muted">{customNodes.length} 件</span>
        </div>

        {capsQ.isLoading ? (
          <SkeletonList count={2} />
        ) : customNodes.length === 0 ? (
          <EmptyState
            icon={<Globe size={22} />}
            title="外部API接続はまだありません"
            description="チャットに curl コマンドや API ドキュメントを貼ると、AI が接続ノードとして登録できます。"
          />
        ) : (
          <Card variant="regular" padding="none" radius="2xl" className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-sunken">
                  <tr>
                    {['ノード', '接続先', '承認', '実行', '状態', ''].map((h) => (
                      <th
                        key={h}
                        className="px-4 py-3.5 text-left text-micro font-semibold uppercase tracking-[0.15em] text-muted"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {customNodes.map((c) => {
                    const st = stats.get(c.id);
                    const method = c.httpConfig?.method ?? '';
                    const needsApproval = method.toUpperCase() !== 'GET';
                    const disabled = c.status === 'DISABLED';
                    return (
                      <tr key={c.id} className="transition-colors hover:bg-sunken">
                        <td className="px-4 py-3.5">
                          <p className="text-xs font-bold text-primary">{c.displayName}</p>
                          <p className="font-mono text-micro text-text-muted">{c.name}</p>
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="text-xs text-secondary">
                            <span className="font-mono font-bold">{method}</span>{' '}
                            {c.httpConfig ? hostOf(c.httpConfig.url) : '—'}
                          </p>
                          {c.httpConfig?.params && c.httpConfig.params.length > 0 && (
                            <p className="text-micro text-text-muted">
                              送信: {c.httpConfig.params.map((p) => p.name).join(', ')}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          {needsApproval ? (
                            <span className="flex w-fit items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-micro font-bold text-warning">
                              <ShieldCheck size={10} aria-hidden="true" />
                              必須
                            </span>
                          ) : (
                            <span className="text-micro text-text-muted">不要（読み取り）</span>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          {st ? (
                            <p className="tabular text-xs text-secondary">
                              {st.total} 回
                              {st.failed > 0 && (
                                <span className="ml-1 text-danger">（失敗 {st.failed}）</span>
                              )}
                            </p>
                          ) : (
                            <span className="text-micro text-text-muted">なし</span>
                          )}
                          {st?.last && (
                            <p className="tabular text-micro text-text-muted">
                              {new Date(st.last).toLocaleDateString('ja-JP')}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          <span
                            className={`rounded-full px-2 py-0.5 text-micro font-bold ${
                              disabled
                                ? 'bg-sunken text-ink-decorative'
                                : c.status === 'NEEDS_AUTH'
                                  ? 'bg-warning/10 text-warning'
                                  : 'bg-success/10 text-success'
                            }`}
                          >
                            {disabled ? '停止中' : c.status === 'NEEDS_AUTH' ? '要再設定' : '有効'}
                          </span>
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-1">
                            <Button
                              size="xs"
                              variant="ghost"
                              icon={disabled ? <PlayCircle size={11} /> : <PauseCircle size={11} />}
                              loading={toggleMut.isPending && toggleMut.variables?.id === c.id}
                              onClick={() =>
                                toggleMut.mutate({ id: c.id, status: disabled ? 'ACTIVE' : 'DISABLED' })
                              }
                            >
                              {disabled ? '再開' : '停止'}
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              icon={<Trash2 size={11} />}
                              loading={deleteMut.isPending && deleteMut.variables === c.id}
                              onClick={() => {
                                if (confirm(`「${c.displayName}」を削除しますか？`)) deleteMut.mutate(c.id);
                              }}
                              aria-label={`${c.displayName} を削除`}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      {/* ── 連携（設定側で接続したもの） ── */}
      {(providersQ.data ?? []).length > 0 && (
        <section>
          <div className="mb-3 flex items-center gap-2">
            <ShieldCheck size={16} className="text-accent" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-primary">連携サービス</h2>
          </div>
          <Card variant="regular" padding="md" radius="2xl">
            <ul className="divide-y divide-hairline">
              {(providersQ.data ?? []).map((p) => (
                <li key={p.provider} className="flex items-center gap-3 py-2.5">
                  <span className="flex-1 text-xs font-bold capitalize text-primary">{p.provider}</span>
                  <span className="text-micro text-text-muted">{p.displayName ?? ''}</span>
                  {p.lastCheckedAt && (
                    <span className="tabular text-micro text-text-muted">
                      {new Date(p.lastCheckedAt).toLocaleDateString('ja-JP')}
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-micro font-bold ${
                      p.status === 'CONNECTED'
                        ? 'bg-success/10 text-success'
                        : 'bg-warning/10 text-warning'
                    }`}
                  >
                    {p.status === 'CONNECTED' ? '接続済み' : '要再接続'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-micro text-text-muted">
              接続や解除の操作は 設定 &gt; 連携 から行います。ここは棚卸し用の表示です。
            </p>
          </Card>
        </section>
      )}
    </div>
  );
}

export default ExternalApiSection;
