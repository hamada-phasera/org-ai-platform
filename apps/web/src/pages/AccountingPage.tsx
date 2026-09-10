import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { Calculator, MessageCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { Button, Card, PageHeader } from '../components/ui';
import { LiquidTabs } from '../components/motion/LiquidTabs';
import { ProjectLedger } from '../components/Accounting/ProjectLedger';
import { CostApproval } from '../components/Accounting/CostApproval';
import { VendorInvoice } from '../components/Accounting/VendorInvoice';
import { yenShort, type AccountingSummary } from '../components/Accounting/types';

/**
 * 経理部（建設業向け）。
 *
 * 一般の経費精算ではなく、**工事（現場）単位の原価管理**に寄せてある。
 * 原価を材料費・労務費・外注費・経費の4分類で持つのは建設業会計の標準であり、
 * 2025年12月に全面施行された改正建設業法で見積書への内訳記載が努力義務になった区分でもある。
 *
 * ⚠️ 税務判断はしない。集計と期日の可視化までに留める。
 */

type View = 'ledger' | 'costs' | 'vendors';

const TABS = [
  { value: 'ledger' as const, label: '工事台帳' },
  { value: 'costs' as const, label: '原価' },
  { value: 'vendors' as const, label: '取引先・インボイス' },
];

/** 見出しの数字。「今どうなっているか」を4つだけ出す。 */
function SummaryStrip() {
  const q = useQuery({
    queryKey: ['accounting-summary'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: AccountingSummary }>('/accounting/summary');
      return res.data.data;
    },
  });

  const s = q.data;
  const next = s?.invoice.next ?? null;

  const cells: Array<{ label: string; value: string; hint?: string; tone?: 'danger' | 'warning' }> = [
    {
      label: '未成工事支出金',
      value: s ? yenShort(s.workInProgress.total) : '—',
      hint: s ? `施工中 ${s.workInProgress.projectCount} 件の確定原価` : undefined,
    },
    {
      label: '今月の原価',
      value: s ? yenShort(s.monthlyCost.total) : '—',
      hint: s?.month,
    },
    {
      label: '確認待ちの原価',
      value: s ? `${s.pendingCostEntries} 件` : '—',
      hint: 'チャット・LINE から届いたもの',
      tone: s && s.pendingCostEntries > 0 ? 'warning' : undefined,
    },
    {
      label: 'インボイス控除',
      value: s ? `${Math.round(s.invoice.currentRate * 100)}%` : '—',
      hint: next ? `あと ${next.daysLeft} 日で ${Math.round(next.rate * 100)}%` : '経過措置は終了',
      tone: next && next.daysLeft <= 30 ? 'danger' : undefined,
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cells.map((c) => (
        <Card key={c.label} variant="thin" padding="md" radius="2xl">
          <p className="text-micro font-semibold uppercase tracking-[0.15em] text-muted">{c.label}</p>
          <p
            className={`tabular mt-1 text-lg font-bold ${
              c.tone === 'danger' ? 'text-danger' : c.tone === 'warning' ? 'text-warning' : 'text-primary'
            }`}
          >
            {c.value}
          </p>
          {c.hint && <p className="text-micro text-text-muted">{c.hint}</p>}
        </Card>
      ))}
    </div>
  );
}

export default function AccountingPage() {
  const [view, setView] = useState<View>('ledger');
  const navigate = useNavigate();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <PageHeader
        eyebrow="経理部"
        title="工事別 原価管理"
        description="現場ごとに、実行予算と実績原価・粗利を見ます。税務判断はしません（具体的な取り扱いは顧問税理士へ）。"
        actions={
          <Button
            size="sm"
            variant="secondary"
            icon={<MessageCircle size={13} />}
            onClick={() => navigate('/chat')}
          >
            チャットで相談
          </Button>
        }
      />

      <div className="space-y-5">
        <SummaryStrip />

        <LiquidTabs
          id="accounting-view"
          items={TABS}
          value={view}
          onChange={setView}
          label="経理の表示を切り替える"
        />

        <motion.div
          key={view}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
        >
          {view === 'ledger' && <ProjectLedger />}
          {view === 'costs' && <CostApproval />}
          {view === 'vendors' && <VendorInvoice />}
        </motion.div>

        <Card variant="thin" padding="md" radius="2xl">
          <div className="flex items-start gap-2.5">
            <Calculator size={15} className="mt-0.5 flex-shrink-0 text-muted" aria-hidden="true" />
            <p className="text-micro leading-relaxed text-text-muted">
              金額は税抜で集計しています（消費税は預り金であって利益ではないため）。原価の入力は税込のままで構いません。
              画面に出るのは集計と期日の可視化までで、税務上の判断は含みません。
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
