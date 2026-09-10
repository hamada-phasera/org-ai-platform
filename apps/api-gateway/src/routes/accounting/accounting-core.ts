// 建設業経理の純粋ロジック。prisma / fastify を import しない（テストしやすさのため）。
// sales/pipeline-core.ts と同じ流儀。
//
// 建設業の経理が一般の経費精算と決定的に違うのは、**すべてが「工事（現場）」単位**で、
// 原価が材料費・労務費・外注費・経費の4分類に分かれること。
// この4分類は建設業会計の標準であり、2025年12月全面施行の改正建設業法で
// 見積書への内訳記載が努力義務になった区分でもある。

/** 原価の4分類。 */
export const COST_CATEGORIES = ['MATERIAL', 'LABOR', 'SUBCON', 'OTHER'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const COST_CATEGORY_LABEL: Record<CostCategory, string> = {
  MATERIAL: '材料費',
  LABOR: '労務費',
  SUBCON: '外注費',
  OTHER: '経費',
};

/** 工事の進行状態。 */
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

/** 完成していない＝未成工事（原価は資産計上する対象）。 */
export function isUnfinished(status: string): boolean {
  return status === 'ESTIMATING' || status === 'ORDERED' || status === 'IN_PROGRESS';
}

export const VENDOR_KINDS = ['SUBCON', 'SUPPLIER', 'SOLO', 'OTHER'] as const;
export type VendorKind = (typeof VENDOR_KINDS)[number];

export const VENDOR_KIND_LABEL: Record<VendorKind, string> = {
  SUBCON: '下請',
  SUPPLIER: '資材業者',
  SOLO: '一人親方',
  OTHER: 'その他',
};

export interface CostLike {
  category: string;
  /** 本体価格（税抜・円）。台帳の集計はこちらだけを使う */
  amount: number;
  /** 消費税額（円）。インボイスの試算にだけ使う */
  taxAmount?: number;
  status?: string;
}

export interface BudgetLike {
  budgetMaterial: number;
  budgetLabor: number;
  budgetSubcon: number;
  budgetOther: number;
}

export type CategoryTotals = Record<CostCategory, number>;

export function emptyTotals(): CategoryTotals {
  return { MATERIAL: 0, LABOR: 0, SUBCON: 0, OTHER: 0 };
}

/**
 * 原価を4分類で集計する。
 * `confirmedOnly` を立てると DRAFT（AI が読んだが人が未確認）を除外する。
 * 台帳の数字は確定分だけで見たい一方、進捗の把握には未確認も含めたいので切り替えられるようにする。
 */
export function sumByCategory(costs: CostLike[], confirmedOnly = false): CategoryTotals {
  const totals = emptyTotals();
  for (const c of costs) {
    if (confirmedOnly && c.status === 'DRAFT') continue;
    const key = COST_CATEGORIES.includes(c.category as CostCategory)
      ? (c.category as CostCategory)
      : 'OTHER';
    totals[key] += Math.round(c.amount || 0);
  }
  return totals;
}

/**
 * 消費税額だけを合算する。インボイスの負担試算に使う。
 * 台帳の原価集計（sumByCategory）とは別関数にして、税込と税抜が混ざらないようにする。
 */
export function sumTax(costs: CostLike[], confirmedOnly = false): number {
  let tax = 0;
  for (const c of costs) {
    if (confirmedOnly && c.status === 'DRAFT') continue;
    tax += Math.round(c.taxAmount || 0);
  }
  return tax;
}

export function totalOf(totals: CategoryTotals): number {
  return totals.MATERIAL + totals.LABOR + totals.SUBCON + totals.OTHER;
}

export function budgetTotals(b: BudgetLike): CategoryTotals {
  return {
    MATERIAL: b.budgetMaterial ?? 0,
    LABOR: b.budgetLabor ?? 0,
    SUBCON: b.budgetSubcon ?? 0,
    OTHER: b.budgetOther ?? 0,
  };
}

export interface ProjectSummary {
  contractAmount: number;
  budget: CategoryTotals;
  budgetTotal: number;
  actual: CategoryTotals;
  actualTotal: number;
  /** 粗利 = 請負金額 − 実績原価 */
  grossProfit: number;
  /** 粗利率（%、小数1桁）。請負金額 0 なら null（0除算を数字に見せない） */
  grossMarginRate: number | null;
  /** 実行予算に対する消化率（%）。予算 0 なら null */
  budgetUsageRate: number | null;
  /** 予算を超過している分類 */
  overBudget: CostCategory[];
}

/**
 * 工事1件の収支をまとめる。
 *
 * **請負金額も原価も税抜**で引く（消費税は預り金であって利益ではない）。
 * 粗利率は請負金額が 0 のとき null にする（見積中の工事で 0% や Infinity を表示しないため）。
 */
export function summarizeProject(
  project: BudgetLike & { contractAmount: number },
  costs: CostLike[],
  confirmedOnly = false,
): ProjectSummary {
  const budget = budgetTotals(project);
  const actual = sumByCategory(costs, confirmedOnly);
  const budgetTotalValue = totalOf(budget);
  const actualTotal = totalOf(actual);
  const contractAmount = project.contractAmount ?? 0;
  const grossProfit = contractAmount - actualTotal;
  return {
    contractAmount,
    budget,
    budgetTotal: budgetTotalValue,
    actual,
    actualTotal,
    grossProfit,
    grossMarginRate:
      contractAmount > 0 ? Math.round((grossProfit / contractAmount) * 1000) / 10 : null,
    budgetUsageRate:
      budgetTotalValue > 0 ? Math.round((actualTotal / budgetTotalValue) * 1000) / 10 : null,
    overBudget: COST_CATEGORIES.filter((c) => budget[c] > 0 && actual[c] > budget[c]),
  };
}

// ── インボイス（消費税の仕入税額控除） ──────────────────────────
//
// 適格請求書発行事業者でない相手からの課税仕入れは、経過措置で一定割合しか控除できない。
// 元請は「未登録の外注先といくら取引しているか」を持っていないことが多く、
// 会計ソフトも仕訳は持つが取引先の登録状況台帳と将来負担の試算は持たない。ここが空いている。
//
// ⚠️ スケジュールは **令和8年度税制改正で変更された**。
//    旧: 80% →（2026-10）50% →（2029-10）終了
//    新: 80% →（2026-10）70% →（2028-10）50% →（2030-10）30% →（2031-10）終了
//    古い資料が大量に残っているので、ここを直すときは必ず最新の改正を確認すること。

/** 経過措置の区切り（この日付以降、その控除割合になる）。令和8年度税制改正後。 */
export const INVOICE_TRANSITION_STEPS = [
  { from: '2023-10-01', rate: 0.8 },
  { from: '2026-10-01', rate: 0.7 },
  { from: '2028-10-01', rate: 0.5 },
  { from: '2030-10-01', rate: 0.3 },
  { from: '2031-10-01', rate: 0 },
] as const;

/** 消費税率（軽減税率は建設業の原価では基本使わないので標準税率のみ扱う）。 */
export const TAX_RATE = 0.1;

/**
 * その日時点で、未登録事業者からの仕入れに認められる控除割合を返す。
 *
 * 初期値は **1（全額控除）**。インボイス制度開始（2023-10-01）より前の課税仕入れには
 * そもそも登録の有無が関係なく、全額控除できたため。原価明細は過去日付で入力されうるので、
 * ここを 0 にすると過去分の負担額を実際より大きく見せてしまう。
 */
export function deductionRateAt(date: Date | string): number {
  // ⚠️ Date を渡すと UTC の暦日で判定される。JST の会社が使うので、
  //    呼び出し側は jstToday() の文字列を渡すこと（切り替え当日の朝9時間ずれる）
  const iso = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  let rate = 1;
  for (const step of INVOICE_TRANSITION_STEPS) {
    if (iso >= step.from) rate = step.rate;
  }
  return rate;
}

/** 次の切り替え日と、そこまでの残日数。もう無ければ null。 */
export function nextTransition(
  date: Date | string,
): { from: string; rate: number; daysLeft: number } | null {
  const iso = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  // 残日数も暦日どうしで数える。時刻が混ざると「あと1日」と「今日」が入れ替わる
  const todayMs = new Date(`${iso}T00:00:00.000Z`).getTime();
  for (const step of INVOICE_TRANSITION_STEPS) {
    if (iso < step.from) {
      const daysLeft = Math.round((new Date(`${step.from}T00:00:00.000Z`).getTime() - todayMs) / 86_400_000);
      return { from: step.from, rate: step.rate, daysLeft };
    }
  }
  return null;
}

export interface InvoiceImpact {
  /** 未登録先との取引にかかっている消費税額の合計（円） */
  unregisteredTax: number;
  /** 現在の控除割合 */
  currentRate: number;
  /** 切り替え後の控除割合。もう切り替えが無ければ null */
  nextRate: number | null;
  /** 現在の控除できない額（円） */
  currentLoss: number;
  /** 切り替え後の控除できない額（円） */
  nextLoss: number;
  /** 切り替えで増える負担（円） */
  additionalBurden: number;
}

/**
 * 未登録事業者に払っている消費税額から、経過措置の切り替えで増える負担を試算する。
 *
 * 引数は**実際の消費税額**（CostEntry.taxAmount の合計）。税込金額から 10/110 で
 * 割り戻さないのは、自社雇用の労務費のような不課税の支出が混ざると過大に出るため。
 * 領収書のように税込しか分からない場合は `splitTaxInclusive()` で分けてから渡す。
 *
 * ⚠️ これは概算であり、税務判断ではない（画面にもその旨を出すこと）。
 */
export function estimateInvoiceImpact(
  unregisteredTax: number,
  now: Date | string = new Date(),
): InvoiceImpact {
  const tax = Math.max(0, Math.round(unregisteredTax || 0));
  const currentRate = deductionRateAt(now);
  const next = nextTransition(now);
  const nextRate = next ? next.rate : null;
  const currentLoss = Math.round(tax * (1 - currentRate));
  const nextLoss = nextRate === null ? currentLoss : Math.round(tax * (1 - nextRate));
  return {
    unregisteredTax: tax,
    currentRate,
    nextRate,
    currentLoss,
    nextLoss,
    additionalBurden: Math.max(0, nextLoss - currentLoss),
  };
}

/**
 * 税込金額を本体価格と消費税額に分ける（標準税率10%）。
 * 領収書の写真や手入力で税込しか分からないときの入口専用。
 * 端数は本体価格側に寄せて、合計が必ず元の税込金額に戻るようにする。
 */
export function splitTaxInclusive(totalIncl: number, taxRate: number = TAX_RATE): { amount: number; taxAmount: number } {
  const total = Math.round(totalIncl || 0);
  const taxAmount = Math.round((total * taxRate) / (1 + taxRate));
  return { amount: total - taxAmount, taxAmount };
}

/** 円の表示（¥1,234,567）。 */
export function formatYen(amount: number): string {
  return `¥${Math.round(amount).toLocaleString('ja-JP')}`;
}
