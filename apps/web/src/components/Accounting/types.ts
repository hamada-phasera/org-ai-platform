/** 経理ページで共有する型と表示ヘルパー。計算はサーバ側（accounting-core）が正本。 */

export const COST_CATEGORIES = ['MATERIAL', 'LABOR', 'SUBCON', 'OTHER'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const COST_CATEGORY_LABEL: Record<CostCategory, string> = {
  MATERIAL: '材料費',
  LABOR: '労務費',
  SUBCON: '外注費',
  OTHER: '経費',
};

export const PROJECT_STATUSES = [
  'ESTIMATING',
  'ORDERED',
  'IN_PROGRESS',
  'COMPLETED',
  'BILLED',
  'PAID',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  ESTIMATING: '見積中',
  ORDERED: '受注',
  IN_PROGRESS: '施工中',
  COMPLETED: '完成',
  BILLED: '請求済',
  PAID: '入金済',
};

export const VENDOR_KINDS = ['SUBCON', 'SUPPLIER', 'SOLO', 'OTHER'] as const;
export type VendorKind = (typeof VENDOR_KINDS)[number];

export const VENDOR_KIND_LABEL: Record<VendorKind, string> = {
  SUBCON: '下請',
  SUPPLIER: '資材業者',
  SOLO: '一人親方',
  OTHER: 'その他',
};

export type CategoryTotals = Record<CostCategory, number>;

export interface ProjectRow {
  id: string;
  code: string;
  name: string;
  client: string | null;
  status: string;
  progressRate: number;
  startOn: string | null;
  dueOn: string | null;
  note: string | null;
  contractAmount: number;
  budget: CategoryTotals;
  budgetTotal: number;
  actual: CategoryTotals;
  actualTotal: number;
  grossProfit: number;
  grossMarginRate: number | null;
  budgetUsageRate: number | null;
  overBudget: CostCategory[];
}

export interface CostRow {
  id: string;
  projectId: string;
  vendorId: string | null;
  incurredOn: string;
  category: string;
  amount: number;
  taxAmount: number;
  description: string | null;
  source: string;
  status: string;
  project?: { id: string; code: string; name: string } | null;
  vendor?: { id: string; name: string; kind: string; invoiceRegistered: boolean } | null;
}

export interface VendorRow {
  id: string;
  name: string;
  kind: string;
  invoiceRegistered: boolean;
  invoiceNumber: string | null;
  note: string | null;
  stats: { entryCount: number; amount: number; taxAmount: number };
}

export interface InvoiceImpact {
  unregisteredTax: number;
  currentRate: number;
  nextRate: number | null;
  currentLoss: number;
  nextLoss: number;
  additionalBurden: number;
}

export interface AccountingSummary {
  month: string;
  projectCounts: Record<string, number>;
  workInProgress: { byCategory: CategoryTotals; total: number; projectCount: number };
  monthlyCost: { byCategory: CategoryTotals; total: number };
  pendingCostEntries: number;
  invoice: {
    currentRate: number;
    next: { from: string; rate: number; daysLeft: number } | null;
  };
}

export function yen(amount: number): string {
  return `¥${Math.round(amount).toLocaleString('ja-JP')}`;
}

/** 大きい金額を「1,234万円」に畳む。表の中で桁を数えさせないため。 */
export function yenShort(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 100_000_000) return `${(amount / 100_000_000).toFixed(1)}億円`;
  if (abs >= 10_000) return `${Math.round(amount / 10_000).toLocaleString('ja-JP')}万円`;
  return yen(amount);
}

export function percent(rate: number | null): string {
  return rate === null ? '—' : `${rate}%`;
}

/**
 * 粗利率の見た目。建設業の一般的な目安として 10% 未満は要注意、
 * マイナスは赤字。**閾値は目安であって税務・経営判断ではない**。
 */
export function marginTone(rate: number | null): 'danger' | 'warning' | 'normal' {
  if (rate === null) return 'normal';
  if (rate < 0) return 'danger';
  if (rate < 10) return 'warning';
  return 'normal';
}

export const SOURCE_LABEL: Record<string, string> = {
  MANUAL: '手入力',
  CHAT: 'チャット',
  LINE: 'LINE',
};
