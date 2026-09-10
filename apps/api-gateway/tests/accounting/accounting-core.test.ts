import { describe, it, expect } from 'vitest';
import {
  COST_CATEGORIES,
  INVOICE_TRANSITION_STEPS,
  budgetTotals,
  deductionRateAt,
  emptyTotals,
  estimateInvoiceImpact,
  formatYen,
  isUnfinished,
  nextTransition,
  splitTaxInclusive,
  sumByCategory,
  sumTax,
  summarizeProject,
  totalOf,
  type CostLike,
} from '../../src/routes/accounting/accounting-core';

const BUDGET = {
  budgetMaterial: 300_000,
  budgetLabor: 200_000,
  budgetSubcon: 400_000,
  budgetOther: 100_000,
};

describe('sumByCategory', () => {
  it('正常系: 4分類ごとに合算する', () => {
    const costs: CostLike[] = [
      { category: 'MATERIAL', amount: 35_000 },
      { category: 'MATERIAL', amount: 15_000 },
      { category: 'LABOR', amount: 80_000 },
      { category: 'SUBCON', amount: 250_000 },
      { category: 'OTHER', amount: 3_000 },
    ];
    expect(sumByCategory(costs)).toEqual({
      MATERIAL: 50_000,
      LABOR: 80_000,
      SUBCON: 250_000,
      OTHER: 3_000,
    });
  });

  it('エッジ: 未知の費目は OTHER に寄せる（金額を落とさない）', () => {
    const costs: CostLike[] = [
      { category: 'WELFARE', amount: 1_000 },
      { category: '', amount: 500 },
      { category: 'material', amount: 200 }, // 小文字は別物として扱う
    ];
    const totals = sumByCategory(costs);
    expect(totals.OTHER).toBe(1_700);
    expect(totalOf(totals)).toBe(1_700);
  });

  it('confirmedOnly: DRAFT（AIが読んだが人が未確認）を除外する', () => {
    const costs: CostLike[] = [
      { category: 'MATERIAL', amount: 10_000, status: 'CONFIRMED' },
      { category: 'MATERIAL', amount: 90_000, status: 'DRAFT' },
    ];
    expect(sumByCategory(costs, false).MATERIAL).toBe(100_000);
    expect(sumByCategory(costs, true).MATERIAL).toBe(10_000);
  });

  it('エッジ: 空配列・欠損金額でも NaN を作らない', () => {
    expect(sumByCategory([])).toEqual(emptyTotals());
    const broken = [{ category: 'LABOR', amount: undefined }] as unknown as CostLike[];
    expect(sumByCategory(broken).LABOR).toBe(0);
  });

  it('エッジ: 小数の金額は円に丸める（内部に小数を持ち込まない）', () => {
    const costs: CostLike[] = [{ category: 'OTHER', amount: 1_000.4 }, { category: 'OTHER', amount: 1_000.6 }];
    const totals = sumByCategory(costs);
    expect(totals.OTHER).toBe(2_001);
    expect(Number.isInteger(totals.OTHER)).toBe(true);
  });
});

describe('summarizeProject', () => {
  it('正常系: 粗利と粗利率を出す', () => {
    const costs: CostLike[] = [
      { category: 'MATERIAL', amount: 250_000 },
      { category: 'LABOR', amount: 150_000 },
      { category: 'SUBCON', amount: 300_000 },
    ];
    const s = summarizeProject({ ...BUDGET, contractAmount: 1_000_000 }, costs);
    expect(s.actualTotal).toBe(700_000);
    expect(s.grossProfit).toBe(300_000);
    expect(s.grossMarginRate).toBe(30);
    expect(s.budgetTotal).toBe(1_000_000);
    expect(s.budgetUsageRate).toBe(70);
  });

  it('エッジ: 請負金額 0（見積中）では粗利率を null にする — 0除算を数字に見せない', () => {
    const s = summarizeProject({ ...BUDGET, contractAmount: 0 }, [
      { category: 'MATERIAL', amount: 5_000 },
    ]);
    expect(s.grossMarginRate).toBeNull();
    expect(s.grossProfit).toBe(-5_000); // 粗利そのものは出す（持ち出しが見える）
  });

  it('エッジ: 実行予算が未入力なら消化率を null にする', () => {
    const zeroBudget = { budgetMaterial: 0, budgetLabor: 0, budgetSubcon: 0, budgetOther: 0 };
    const s = summarizeProject({ ...zeroBudget, contractAmount: 500_000 }, [
      { category: 'LABOR', amount: 10_000 },
    ]);
    expect(s.budgetUsageRate).toBeNull();
    expect(s.overBudget).toEqual([]); // 予算 0 の分類は「超過」と言わない
  });

  it('正常系: 予算を超えた分類だけを overBudget に挙げる', () => {
    const s = summarizeProject({ ...BUDGET, contractAmount: 1_000_000 }, [
      { category: 'MATERIAL', amount: 300_001 }, // 1円でも超過
      { category: 'LABOR', amount: 200_000 }, // ちょうどは超過でない
      { category: 'SUBCON', amount: 10_000 },
    ]);
    expect(s.overBudget).toEqual(['MATERIAL']);
  });

  it('粗利率は小数1桁に丸める', () => {
    const s = summarizeProject({ ...BUDGET, contractAmount: 3_000_000 }, [
      { category: 'SUBCON', amount: 1_000_000 },
    ]);
    // 2,000,000 / 3,000,000 = 66.666...%
    expect(s.grossMarginRate).toBe(66.7);
  });

  it('赤字工事では粗利率が負になる', () => {
    const s = summarizeProject({ ...BUDGET, contractAmount: 1_000_000 }, [
      { category: 'SUBCON', amount: 1_200_000 },
    ]);
    expect(s.grossProfit).toBe(-200_000);
    expect(s.grossMarginRate).toBe(-20);
  });
});

describe('isUnfinished（未成工事支出金の対象か）', () => {
  it('完成前は未成工事、完成以降は違う', () => {
    expect(isUnfinished('ESTIMATING')).toBe(true);
    expect(isUnfinished('ORDERED')).toBe(true);
    expect(isUnfinished('IN_PROGRESS')).toBe(true);
    expect(isUnfinished('COMPLETED')).toBe(false);
    expect(isUnfinished('BILLED')).toBe(false);
    expect(isUnfinished('PAID')).toBe(false);
  });

  it('エッジ: 未知の状態は未成工事扱いにしない（資産計上を勝手に増やさない）', () => {
    expect(isUnfinished('WHATEVER')).toBe(false);
    expect(isUnfinished('')).toBe(false);
  });
});

describe('INVOICE_TRANSITION_STEPS（令和8年度税制改正後のスケジュール）', () => {
  it('80% → 70% → 50% → 30% → 終了 の順で下がる', () => {
    expect(INVOICE_TRANSITION_STEPS.map((s) => s.rate)).toEqual([0.8, 0.7, 0.5, 0.3, 0]);
  });

  it('区切り日が昇順に並んでいる（deductionRateAt が順走査で正しく解ける前提）', () => {
    const froms = INVOICE_TRANSITION_STEPS.map((s) => s.from);
    expect([...froms].sort()).toEqual([...froms]);
  });

  it('⚠️ 旧スケジュール（2026-10 に 50%）に戻っていないこと', () => {
    // 令和8年度税制改正前の資料が大量に残っているため、ここは回帰しやすい
    const step2026 = INVOICE_TRANSITION_STEPS.find((s) => s.from === '2026-10-01');
    expect(step2026?.rate).toBe(0.7);
    expect(INVOICE_TRANSITION_STEPS.some((s) => s.from === '2029-10-01')).toBe(false);
  });
});

describe('deductionRateAt', () => {
  it('制度開始前は全額控除（1）— 過去日付の原価を過大に見せない', () => {
    expect(deductionRateAt(new Date('2023-09-30T00:00:00Z'))).toBe(1);
    expect(deductionRateAt(new Date('2020-01-01T00:00:00Z'))).toBe(1);
  });

  it('各区間の割合を返す', () => {
    expect(deductionRateAt(new Date('2023-10-01T00:00:00Z'))).toBe(0.8);
    expect(deductionRateAt(new Date('2026-09-30T00:00:00Z'))).toBe(0.8);
    expect(deductionRateAt(new Date('2026-10-01T00:00:00Z'))).toBe(0.7);
    expect(deductionRateAt(new Date('2028-09-30T00:00:00Z'))).toBe(0.7);
    expect(deductionRateAt(new Date('2028-10-01T00:00:00Z'))).toBe(0.5);
    expect(deductionRateAt(new Date('2030-10-01T00:00:00Z'))).toBe(0.3);
    expect(deductionRateAt(new Date('2031-10-01T00:00:00Z'))).toBe(0);
    expect(deductionRateAt(new Date('2040-01-01T00:00:00Z'))).toBe(0);
  });
});

describe('nextTransition', () => {
  it('正常系: 次の切り替え日と残日数を返す', () => {
    const t = nextTransition(new Date('2026-09-10T00:00:00Z'));
    expect(t).not.toBeNull();
    expect(t?.from).toBe('2026-10-01');
    expect(t?.rate).toBe(0.7);
    expect(t?.daysLeft).toBe(21);
  });

  it('境界: 切り替え当日は「次」に含めない（その日はもう新しい割合）', () => {
    const t = nextTransition(new Date('2026-10-01T00:00:00Z'));
    expect(t?.from).toBe('2028-10-01');
    expect(deductionRateAt(new Date('2026-10-01T00:00:00Z'))).toBe(0.7);
  });

  it('エッジ: 経過措置が終わった後は null', () => {
    expect(nextTransition(new Date('2031-10-01T00:00:00Z'))).toBeNull();
    expect(nextTransition(new Date('2035-01-01T00:00:00Z'))).toBeNull();
  });

  it('残日数は切り上げる（当日中でも「あと1日」を 0 日と言わない）', () => {
    const t = nextTransition(new Date('2026-09-30T12:00:00Z'));
    expect(t?.daysLeft).toBe(1);
  });
});

describe('sumTax', () => {
  it('消費税額だけを合算する（本体価格は混ぜない）', () => {
    const costs: CostLike[] = [
      { category: 'SUBCON', amount: 300_000, taxAmount: 30_000 },
      { category: 'MATERIAL', amount: 100_000, taxAmount: 10_000 },
    ];
    expect(sumTax(costs)).toBe(40_000);
    expect(totalOf(sumByCategory(costs))).toBe(400_000); // 台帳側は税抜のまま
  });

  it('不課税（自社雇用の労務費など）は taxAmount 0 として扱う', () => {
    const costs: CostLike[] = [
      { category: 'LABOR', amount: 500_000 }, // taxAmount 未指定 = 不課税
      { category: 'SUBCON', amount: 100_000, taxAmount: 10_000 },
    ];
    // 税込から 10/110 で割り戻していたら 60,000 円になってしまう場面
    expect(sumTax(costs)).toBe(10_000);
  });

  it('confirmedOnly で DRAFT を除外する', () => {
    const costs: CostLike[] = [
      { category: 'SUBCON', amount: 100_000, taxAmount: 10_000, status: 'CONFIRMED' },
      { category: 'SUBCON', amount: 900_000, taxAmount: 90_000, status: 'DRAFT' },
    ];
    expect(sumTax(costs, true)).toBe(10_000);
    expect(sumTax(costs, false)).toBe(100_000);
  });
});

describe('splitTaxInclusive', () => {
  it('税込を本体価格と消費税に分ける', () => {
    expect(splitTaxInclusive(1_100_000)).toEqual({ amount: 1_000_000, taxAmount: 100_000 });
    // 35,000 × 10/110 = 3,181.8… → 消費税 3,182 円、本体 31,818 円
    expect(splitTaxInclusive(35_000)).toEqual({ amount: 31_818, taxAmount: 3_182 });
  });

  it('端数があっても合計は必ず元の税込金額に戻る', () => {
    for (const total of [1, 7, 99, 333, 1_234, 35_000, 987_654]) {
      const { amount, taxAmount } = splitTaxInclusive(total);
      expect(amount + taxAmount).toBe(total);
      expect(Number.isInteger(amount)).toBe(true);
      expect(Number.isInteger(taxAmount)).toBe(true);
    }
  });

  it('エッジ: 0 や欠損値でも NaN を作らない', () => {
    expect(splitTaxInclusive(0)).toEqual({ amount: 0, taxAmount: 0 });
    expect(splitTaxInclusive(undefined as unknown as number)).toEqual({ amount: 0, taxAmount: 0 });
  });
});

describe('estimateInvoiceImpact', () => {
  it('正常系: 2026-10-01 の 80%→70% で増える負担を出す', () => {
    // 未登録先に払っている消費税が 100,000 円
    const r = estimateInvoiceImpact(100_000, new Date('2026-09-10T00:00:00Z'));
    expect(r.currentRate).toBe(0.8);
    expect(r.nextRate).toBe(0.7);
    expect(r.currentLoss).toBe(20_000); // 100,000 × (1 - 0.8)
    expect(r.nextLoss).toBe(30_000); // 100,000 × (1 - 0.7)
    expect(r.additionalBurden).toBe(10_000);
  });

  it('取引が無ければ全部 0（画面に「0円の負担増」を出せる）', () => {
    const r = estimateInvoiceImpact(0, new Date('2026-09-10T00:00:00Z'));
    expect(r.currentLoss).toBe(0);
    expect(r.nextLoss).toBe(0);
    expect(r.additionalBurden).toBe(0);
  });

  it('経過措置終了後は nextRate が null で、負担は増えない（もう下がらない）', () => {
    const r = estimateInvoiceImpact(100_000, new Date('2032-01-01T00:00:00Z'));
    expect(r.currentRate).toBe(0);
    expect(r.nextRate).toBeNull();
    expect(r.currentLoss).toBe(100_000); // 全額が控除できない
    expect(r.nextLoss).toBe(100_000);
    expect(r.additionalBurden).toBe(0);
  });

  it('最終段（30%→0%）でも増加分を出せる', () => {
    const r = estimateInvoiceImpact(100_000, new Date('2030-10-01T00:00:00Z'));
    expect(r.currentRate).toBe(0.3);
    expect(r.nextRate).toBe(0);
    expect(r.additionalBurden).toBe(30_000); // 70,000 → 100,000
  });

  it('additionalBurden は負にならない', () => {
    for (const iso of ['2023-10-01', '2026-10-01', '2028-10-01', '2030-10-01', '2031-10-01']) {
      const r = estimateInvoiceImpact(500_000, new Date(`${iso}T00:00:00Z`));
      expect(r.additionalBurden).toBeGreaterThanOrEqual(0);
    }
  });

  it('エッジ: 負の消費税額は 0 として扱う', () => {
    const r = estimateInvoiceImpact(-1_000, new Date('2026-09-10T00:00:00Z'));
    expect(r.unregisteredTax).toBe(0);
    expect(r.currentLoss).toBe(0);
  });

  it('金額は円で返す（小数を持ち込まない）', () => {
    const r = estimateInvoiceImpact(33_333, new Date('2026-09-10T00:00:00Z'));
    for (const v of [r.currentLoss, r.nextLoss, r.additionalBurden]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('領収書経路: splitTaxInclusive と繋いでも二重に割り戻さない', () => {
    const { taxAmount } = splitTaxInclusive(1_100_000);
    const r = estimateInvoiceImpact(taxAmount, new Date('2026-09-10T00:00:00Z'));
    expect(r.unregisteredTax).toBe(100_000);
    expect(r.additionalBurden).toBe(10_000);
  });
});

describe('budgetTotals / formatYen', () => {
  it('実行予算を4分類の形に写す', () => {
    expect(budgetTotals(BUDGET)).toEqual({
      MATERIAL: 300_000,
      LABOR: 200_000,
      SUBCON: 400_000,
      OTHER: 100_000,
    });
    expect(COST_CATEGORIES.every((c) => c in budgetTotals(BUDGET))).toBe(true);
  });

  it('円表記に3桁区切りを入れる', () => {
    expect(formatYen(1_234_567)).toBe('¥1,234,567');
    expect(formatYen(0)).toBe('¥0');
    expect(formatYen(-50_000)).toBe('¥-50,000');
  });
});
