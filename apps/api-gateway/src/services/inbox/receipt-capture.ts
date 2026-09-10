// LINE で届いた領収書の写真を、工事原価の下書きにする。
//
// ここが FLOW でしかできない一周になる部分:
//   現場監督が LINE で撮って送る → AI が読む → 経理が承認 → 工事台帳に載る
//
// 現場アプリが3週目に使われなくなる最大の理由は入力項目の多さなので、
// **入力項目ゼロ**にすること自体が機能。フォームを簡素にする方向の改善では届かない。
//
// ⚠️ 画像は保存しない。読み取った値だけを DB に持つ。
//    保管すると電子帳簿保存法の保管要件を背負うことになるため、v1 では持たない。

import { prisma } from '../../utils/prisma';
import { splitTaxInclusive } from '../../routes/accounting/accounting-core';
import { fetchLineMessageContent } from './line-client';

export interface ReceiptExtraction {
  amountIncludingTax: number | null;
  taxAmount: number | null;
  incurredOn: string | null;
  vendorHint: string | null;
  category: string | null;
  projectHint: string | null;
  description: string | null;
  confidence: number;
  notes: string | null;
}

const VALID_CATEGORIES = new Set(['MATERIAL', 'LABOR', 'SUBCON', 'OTHER']);

/** ai-engine に画像を渡して読み取る。落ちても呼び出し側を巻き込まない。 */
async function extractReceipt(
  imageBase64: string,
  mediaType: string,
  orgId: string,
  plan: string,
): Promise<ReceiptExtraction | null> {
  const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://localhost:8000';
  try {
    const res = await fetch(`${aiEngineUrl}/vision/receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: imageBase64, media_type: mediaType, org_id: orgId, plan }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as ReceiptExtraction;
  } catch {
    return null;
  }
}

/**
 * 読み取った工事名らしき語から Project を1件に絞る。
 *
 * ⚠️ 絞り込めないときは **null を返して人に選ばせる**。
 *    候補が複数あるのに1つ選ぶと、別の現場の原価になって粗利が静かに狂う。
 *    工事番号 → 完全一致 → 部分一致（1件のときだけ）の順。
 */
export async function matchProject(
  orgId: string,
  hint: string | null,
): Promise<{ id: string; name: string; code: string } | null> {
  if (!hint || hint.trim().length < 2) return null;
  const needle = hint.trim();

  const byCode = await prisma.project.findFirst({
    where: { orgId, code: needle },
    select: { id: true, name: true, code: true },
  });
  if (byCode) return byCode;

  const byName = await prisma.project.findFirst({
    where: { orgId, name: needle },
    select: { id: true, name: true, code: true },
  });
  if (byName) return byName;

  const partial = await prisma.project.findMany({
    where: { orgId, name: { contains: needle, mode: 'insensitive' } },
    select: { id: true, name: true, code: true },
    take: 2,
  });
  return partial.length === 1 ? partial[0] : null;
}

/** 取引先も同じ流儀で1件に絞る（絞れなければ null）。 */
export async function matchVendor(
  orgId: string,
  hint: string | null,
): Promise<{ id: string; name: string } | null> {
  if (!hint || hint.trim().length < 2) return null;
  const needle = hint.trim();

  const exact = await prisma.vendor.findFirst({
    where: { orgId, name: needle },
    select: { id: true, name: true },
  });
  if (exact) return exact;

  const partial = await prisma.vendor.findMany({
    where: { orgId, name: { contains: needle, mode: 'insensitive' } },
    select: { id: true, name: true },
    take: 2,
  });
  return partial.length === 1 ? partial[0] : null;
}

function yen(n: number): string {
  return `¥${n.toLocaleString('ja-JP')}`;
}

/**
 * 読み取り結果を、受信箱に出す一行の日本語にする。
 * 画像が見えない画面（受信一覧）でも何が届いたか分かるようにするためのもの。
 */
export function summarizeExtraction(
  x: ReceiptExtraction,
  project: { name: string } | null,
  linked: boolean,
): string {
  const parts: string[] = ['📷 領収書'];
  if (x.vendorHint) parts.push(x.vendorHint);
  if (x.amountIncludingTax !== null) parts.push(yen(x.amountIncludingTax));
  if (x.incurredOn) parts.push(x.incurredOn);

  let line = parts.join(' / ');
  if (linked && project) {
    line += `\n→ 「${project.name}」の原価として登録しました（未確認）。経理 > 原価 で確認してください。`;
  } else if (x.amountIncludingTax === null) {
    line += '\n→ 金額を読み取れませんでした。経理 > 原価 から手入力してください。';
  } else {
    line += '\n→ どの工事か特定できませんでした。経理 > 原価 で工事を選んで登録してください。';
  }
  if (x.notes) line += `\n（${x.notes}）`;
  return line;
}

export interface CaptureResult {
  /** 受信箱に表示する本文 */
  summary: string;
  /** DRAFT の CostEntry を作れたか */
  costEntryId: string | null;
}

/**
 * LINE の画像メッセージから原価の下書きを作る。
 *
 * 工事が1件に絞れたときだけ CostEntry を DRAFT で作る。絞れないときは作らず、
 * 受信箱の本文で人に知らせる（CostEntry.projectId は必須で、間違った現場に付けると
 * その現場の粗利が静かに狂うため、当てずっぽうで埋めない）。
 */
export async function captureReceiptFromLine(args: {
  orgId: string;
  plan: string;
  accessToken: string;
  messageId: string;
  createdBy?: string | null;
}): Promise<CaptureResult> {
  const content = await fetchLineMessageContent(args.accessToken, args.messageId);
  if (!content.ok) {
    const message =
      content.reason === 'TOO_LARGE'
        ? '📷 画像を受け取りましたが、サイズが大きすぎて読み取れませんでした。'
        : content.reason === 'UNSUPPORTED_TYPE'
          ? '📷 画像を受け取りましたが、対応していない形式でした。写真で撮り直してください。'
          : '📷 画像を受け取りましたが、取得できませんでした。';
    return { summary: message, costEntryId: null };
  }

  const extraction = await extractReceipt(content.base64, content.mediaType, args.orgId, args.plan);
  // ⚠️ ここで content.base64 の参照を手放す。以降どこにも渡さない
  if (!extraction) {
    return { summary: '📷 領収書を受け取りましたが、読み取りに失敗しました。', costEntryId: null };
  }

  const project = await matchProject(args.orgId, extraction.projectHint);
  const canCreate =
    project !== null &&
    extraction.amountIncludingTax !== null &&
    extraction.amountIncludingTax > 0;

  if (!canCreate) {
    return { summary: summarizeExtraction(extraction, project, false), costEntryId: null };
  }

  const vendor = await matchVendor(args.orgId, extraction.vendorHint);

  // 消費税額が読めていればそれを使う。読めていなければ税込から割り戻す
  const split = splitTaxInclusive(extraction.amountIncludingTax as number);
  const taxAmount = extraction.taxAmount ?? split.taxAmount;
  const amount = (extraction.amountIncludingTax as number) - taxAmount;

  const incurredOn =
    extraction.incurredOn !== null ? new Date(`${extraction.incurredOn}T00:00:00.000Z`) : new Date();

  const entry = await prisma.costEntry.create({
    data: {
      orgId: args.orgId,
      projectId: (project as { id: string }).id,
      vendorId: vendor?.id ?? null,
      incurredOn: Number.isNaN(incurredOn.getTime()) ? new Date() : incurredOn,
      category: VALID_CATEGORIES.has(extraction.category ?? '') ? (extraction.category as string) : 'OTHER',
      amount,
      taxAmount,
      description: extraction.description ?? null,
      source: 'LINE',
      // ⚠️ 必ず DRAFT。AI が読んだ数字をそのまま台帳の確定値にしない
      status: 'DRAFT',
      createdBy: args.createdBy ?? null,
    },
    select: { id: true },
  });

  return { summary: summarizeExtraction(extraction, project, true), costEntryId: entry.id };
}
