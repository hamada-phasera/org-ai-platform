import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, CreditCard, HardDrive, Minus, Plus, X } from 'lucide-react';
import type { BillingInterval, BillingOverview, Plan, SubscriptionStatus } from '@org-ai/shared-types';
import { ENTITLED_STATUSES, PLAN_LIMITS, formatBytes, storageQuotaBytes } from '@org-ai/shared-types';
import { api } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { Badge, Button, Card, SkeletonList } from '../ui';
import { LiquidTabs } from '../motion/LiquidTabs';

/**
 * プランとお支払い。
 *
 * ⚠️ カード情報はこの画面で扱わない。新規契約は Stripe Checkout、
 *    変更・解約・支払い方法・請求書は Stripe のカスタマーポータルへ移動する。
 * ⚠️ 金額はコードに持たない。サーバが Stripe の価格から返したものだけを出す。
 */

const PLAN_ORDER: Plan[] = ['STARTER', 'PRO', 'MAX'];

const PLAN_NAME: Record<Plan, { name: string; sub: string }> = {
  STARTER: { name: '梅', sub: 'Starter' },
  PRO: { name: '竹', sub: 'Pro' },
  MAX: { name: '松', sub: 'Max' },
};

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'accent';

const yen = (n: number) => `${n.toLocaleString('ja-JP')}円`;

const dateLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';

const isEntitled = (status: SubscriptionStatus | null) => !!status && ENTITLED_STATUSES.includes(status);

function errorMessage(e: unknown, fallback: string): string {
  const err = e as { response?: { data?: { error?: { message?: string } } } };
  return err.response?.data?.error?.message ?? fallback;
}

function statusOf(b: BillingOverview): { tone: Tone; text: string } {
  switch (b.subscriptionStatus) {
    case null:
      return { tone: 'info', text: 'まだご契約はありません' };
    case 'trialing':
      return { tone: 'accent', text: `無料トライアル中（${dateLabel(b.trialEndsAt)}まで）` };
    case 'active':
      return b.cancelAtPeriodEnd
        ? { tone: 'warning', text: `${dateLabel(b.currentPeriodEnd)}で解約予定` }
        : { tone: 'success', text: `ご契約中（次回更新 ${dateLabel(b.currentPeriodEnd)}）` };
    case 'past_due':
      return { tone: 'danger', text: 'お支払いが確認できていません。お支払い情報をご確認ください' };
    case 'incomplete':
      return { tone: 'warning', text: 'お支払いの手続きが完了していません' };
    case 'paused':
      return { tone: 'warning', text: '契約は一時停止中です' };
    default:
      return { tone: 'warning', text: '契約は終了しています' };
  }
}

function Banner({ tone, children, onClose }: { tone: 'danger' | 'accent'; children: React.ReactNode; onClose?: () => void }) {
  const cls =
    tone === 'danger'
      ? 'border-danger/30 bg-danger/10 text-danger'
      : 'border-accent-soft-border bg-accent-soft text-accent';
  const Icon = tone === 'danger' ? AlertCircle : CheckCircle2;
  return (
    <div className={`mb-4 flex items-start gap-2 rounded-2xl border px-3 py-2.5 text-xs ${cls}`}>
      <Icon size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 leading-relaxed">{children}</p>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="閉じる" className="shrink-0 text-muted hover:text-primary">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function BillingSection() {
  const qc = useQueryClient();
  const isOwner = useAuthStore((s) => s.user?.role) === 'OWNER';
  const [cycle, setCycle] = useState<BillingInterval>('month');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftUnits, setDraftUnits] = useState<number | null>(null);
  // Checkout から ?checkout=success|cancel で戻ってくる
  const [notice, setNotice] = useState<'success' | 'cancel' | null>(() => {
    const v = new URLSearchParams(window.location.search).get('checkout');
    return v === 'success' || v === 'cancel' ? v : null;
  });

  const { data: billing, isLoading } = useQuery({
    queryKey: ['billing'],
    queryFn: async () => (await api.get<{ success: boolean; data: BillingOverview }>('/billing')).data.data,
  });

  // 戻った直後は webhook の反映を待つ。契約が見えるまで数秒おきに取り直す（最大30秒）
  const status = billing?.subscriptionStatus ?? null;
  useEffect(() => {
    if (notice !== 'success' || isEntitled(status)) return;
    let count = 0;
    const timer = window.setInterval(() => {
      count += 1;
      void qc.invalidateQueries({ queryKey: ['billing'] });
      if (count >= 10) window.clearInterval(timer);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [notice, status, qc]);

  const redirectTo = async (key: string, path: string, body: object, fallback: string) => {
    setBusy(key);
    setError(null);
    try {
      const res = await api.post<{ success: boolean; data: { url: string } }>(path, body);
      window.location.assign(res.data.data.url);
    } catch (e) {
      setError(errorMessage(e, fallback));
      setBusy(null);
    }
  };

  const openPortal = () => redirectTo('portal', '/billing/portal', {}, 'お支払い画面を開けませんでした');

  const changePlan = async (plan: Plan, amount: number | null, intervalOnly: boolean) => {
    const label = `${PLAN_NAME[plan].name}（${cycle === 'year' ? '年払い' : '月払い'}${amount !== null ? ` ${yen(amount)}・税抜` : ''}）`;
    // 支払い間隔を変えると、Stripe はその時点で新しい間隔の請求を立てる（残り期間分は差し引かれる）
    const how = intervalOnly
      ? 'その時点で新しい支払い間隔の請求が発生し、残りの期間分は差し引かれます。'
      : '差額は日割りで計算され、次回の請求に反映されます。';
    if (!window.confirm(`${label}に変更します。${how}よろしいですか？`)) return;
    setBusy(`change:${plan}`);
    setError(null);
    try {
      const res = await api.post<{ success: boolean; data: BillingOverview }>('/billing/change-plan', { plan, interval: cycle });
      qc.setQueryData(['billing'], res.data.data);
      void qc.invalidateQueries({ queryKey: ['organization-usage'] });
      void qc.invalidateQueries({ queryKey: ['organization-me'] });
    } catch (e) {
      setError(errorMessage(e, 'プランを変更できませんでした'));
    } finally {
      setBusy(null);
    }
  };

  const saveAddon = async (units: number) => {
    setBusy('addon');
    setError(null);
    try {
      const res = await api.post<{ success: boolean; data: BillingOverview }>('/billing/storage-addon', { units });
      qc.setQueryData(['billing'], res.data.data);
      setDraftUnits(null);
      void qc.invalidateQueries({ queryKey: ['organization-usage'] });
    } catch (e) {
      setError(errorMessage(e, '追加容量を変更できませんでした'));
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) return <SkeletonList count={3} />;
  if (!billing) return null;

  const entitled = isEntitled(billing.subscriptionStatus);
  const current = statusOf(billing);
  const priceOf = (plan: Plan, interval: BillingInterval) =>
    billing.prices.find((p) => p.plan === plan && p.interval === interval)?.amount ?? null;
  const addon = billing.storageAddon;
  const units = draftUnits ?? addon.units;

  return (
    <div>
      {notice === 'success' && (
        <Banner tone="accent" onClose={() => setNotice(null)}>
          お手続きありがとうございます。契約の反映まで数秒かかることがあります。
        </Banner>
      )}
      {notice === 'cancel' && (
        <Banner tone="accent" onClose={() => setNotice(null)}>
          お申し込みを中断しました。料金は発生していません。
        </Banner>
      )}
      {error && (
        <Banner tone="danger" onClose={() => setError(null)}>
          {error}
        </Banner>
      )}

      <Card variant="regular" padding="lg" radius="2xl" className="mb-5">
        <div className="flex items-center gap-2 mb-4">
          <CreditCard size={16} className="text-accent" />
          <h3 className="text-sm font-semibold text-primary">ご契約</h3>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-2xl font-bold text-primary">
            {PLAN_NAME[billing.plan].name}
            <span className="ml-2 text-xs font-medium text-muted">{PLAN_NAME[billing.plan].sub}</span>
          </p>
          <Badge tone={current.tone}>{current.text}</Badge>
          {billing.billingInterval && (
            <span className="text-xs text-muted">{billing.billingInterval === 'year' ? '年払い' : '月払い'}</span>
          )}
          {billing.configured && billing.hasCustomer && isOwner && (
            <Button size="sm" variant="secondary" className="ml-auto" onClick={openPortal} loading={busy === 'portal'}>
              お支払い・契約の管理
            </Button>
          )}
        </div>
        {!billing.configured && (
          <p className="mt-3 text-xs text-muted">決済はまだ準備中です。準備が整い次第、ここからお申し込みいただけます。</p>
        )}
        {billing.configured && !isOwner && (
          <p className="mt-3 text-xs text-muted">プランのお申し込み・変更はオーナーのみ行えます。</p>
        )}
      </Card>

      {billing.configured && (
        <Card variant="regular" padding="lg" radius="2xl" className="mb-5">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-semibold text-primary">プラン</h3>
            <LiquidTabs<BillingInterval>
              id="billing-cycle"
              size="sm"
              label="支払い間隔の切り替え"
              items={[
                { value: 'month', label: '月払い' },
                { value: 'year', label: '年払い（20%お得）' },
              ]}
              value={cycle}
              onChange={setCycle}
            />
            <span className="ml-auto text-xs text-muted">ユーザー数は全プラン無制限・初期費用 0円</span>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {PLAN_ORDER.map((plan) => {
              const amount = priceOf(plan, cycle);
              const limits = PLAN_LIMITS[plan];
              // 同じプランでも支払い間隔が違えば「切り替え」を出す
              const isCurrent = entitled && billing.plan === plan && billing.billingInterval === cycle;
              return (
                <div
                  key={plan}
                  className={`flex flex-col rounded-2xl border p-4 ${
                    isCurrent ? 'border-accent-soft-border bg-accent-soft' : 'border-border bg-sunken'
                  }`}
                >
                  <p className="text-lg font-bold text-primary">
                    {PLAN_NAME[plan].name}
                    <span className="ml-1.5 text-xs font-medium text-muted">{PLAN_NAME[plan].sub}</span>
                  </p>
                  <p className="mt-2 text-xl font-bold text-primary tabular">
                    {amount === null ? '—' : yen(amount)}
                    <span className="ml-1 text-xs font-medium text-muted">/ {cycle === 'year' ? '年' : '月'}（税抜）</span>
                  </p>
                  <p className="mt-0.5 h-4 text-xs text-muted tabular">
                    {cycle === 'year' && amount !== null ? `月あたり ${yen(Math.round(amount / 12))}` : ''}
                  </p>
                  <ul className="mt-3 space-y-1 text-xs text-secondary">
                    <li>AI 呼び出し 月{limits.aiCallsPerMonth.toLocaleString('ja-JP')}回まで</li>
                    <li>保存容量 {formatBytes(limits.storageBytes)}</li>
                    <li>1ファイル {formatBytes(limits.maxFileBytes)} まで</li>
                  </ul>
                  <div className="mt-auto pt-4">
                    {isCurrent ? (
                      <Button size="sm" variant="secondary" fullWidth disabled>
                        ご契約中のプラン
                      </Button>
                    ) : entitled ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        fullWidth
                        disabled={!isOwner || amount === null || (busy !== null && busy !== `change:${plan}`)}
                        loading={busy === `change:${plan}`}
                        onClick={() => changePlan(plan, amount, billing.plan === plan)}
                      >
                        {billing.plan === plan
                          ? cycle === 'year'
                            ? '年払いに切り替える'
                            : '月払いに切り替える'
                          : 'このプランに変更'}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        fullWidth
                        disabled={!isOwner || amount === null || (busy !== null && busy !== `checkout:${plan}`)}
                        loading={busy === `checkout:${plan}`}
                        onClick={() =>
                          redirectTo(`checkout:${plan}`, '/billing/checkout', { plan, interval: cycle }, 'お申し込みを開始できませんでした')
                        }
                      >
                        {billing.trialAvailable ? `${billing.trialDays}日間 無料で始める` : 'このプランで契約する'}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {billing.trialAvailable && !entitled && (
            <p className="mt-3 text-xs text-muted">
              無料期間中はいつでも解約でき、料金は発生しません。無料期間が終わると選んだプランの料金がかかります。
            </p>
          )}
        </Card>
      )}

      {billing.configured && addon.available && (
        <Card variant="regular" padding="lg" radius="2xl" className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            <HardDrive size={16} className="text-accent" />
            <h3 className="text-sm font-semibold text-primary">追加ストレージ</h3>
            {addon.unitAmount !== null && (
              <span className="ml-auto text-xs text-muted">
                {formatBytes(addon.unitBytes)} あたり {yen(addon.unitAmount)} / 月（税抜）
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center gap-1 rounded-xl bg-sunken p-1">
              <button
                type="button"
                aria-label="1口減らす"
                onClick={() => setDraftUnits(Math.max(0, units - 1))}
                disabled={!addon.purchasable || !isOwner || units <= 0}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-secondary hover:text-primary disabled:opacity-40"
              >
                <Minus size={13} />
              </button>
              <span className="w-16 text-center text-sm font-semibold text-primary tabular">
                +{formatBytes(units * addon.unitBytes)}
              </span>
              <button
                type="button"
                aria-label="1口増やす"
                onClick={() => setDraftUnits(Math.min(50, units + 1))}
                disabled={!addon.purchasable || !isOwner || units >= 50}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-secondary hover:text-primary disabled:opacity-40"
              >
                <Plus size={13} />
              </button>
            </div>
            <span className="text-xs text-muted tabular">
              合計 {formatBytes(storageQuotaBytes(billing.plan, units))}
            </span>
            <Button
              size="sm"
              variant="primary"
              className="ml-auto"
              disabled={!addon.purchasable || !isOwner || units === addon.units}
              loading={busy === 'addon'}
              onClick={() => saveAddon(units)}
            >
              変更する
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted">
            {addon.purchasable
              ? '変更は日割りで次回の請求に反映されます。'
              : '課金が始まってから（無料トライアルの終了後に）追加できます。'}
          </p>
        </Card>
      )}

      <p className="text-xs text-muted">
        価格はすべて税抜です。お支払いは Stripe の画面で行われ、カード情報はこのサービスに保存されません。
      </p>
    </div>
  );
}
