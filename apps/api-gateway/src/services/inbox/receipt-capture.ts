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
import { parseDateOnly } from '../../routes/accounting/shared';
import { fetchLineMessageContent } from './line-client';
import { aiEngineHeaders } from '../ai-engine-auth';

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

/**
 * 読み取り結果をこの値未満の確からしさでは記帳しない。
 * 手書きや判読困難な領収書は人に返す（プロンプトが confidence を下げるよう指示している）。
 */
const MIN_CONFIDENCE = 0.5;

/**
 * LIKE のメタ文字を潰す。値は画像から読んだ文字列＝ボットを友だち追加した誰でも
 * 影響できるので、`%` が入ると「何にでも当たる」検索になる。
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

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
      headers: aiEngineHeaders(),
      body: JSON.stringify({ image_base64: imageBase64, media_type: mediaType, org_id: orgId, plan }),
      // ⚠️ ai-engine 側は最大3回リトライ（指数バックオフ 1〜8秒）するので、
      //    60秒だと 429/529 を1回踏んだだけで gateway が先に諦める。
      //    その場合 ai-engine は最後まで走って課金され、結果は誰も受け取らない
      //    （利用者はもう一度写真を送るのでもう一周課金される）。片方が他方を包含する関係にする。
      signal: AbortSignal.timeout(90_000),
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

  // ⚠️ Project.name には一意制約が無い（unique なのは code だけ）。
  //    findFirst だと「山田邸 1期(請求済)」と「山田邸 2期(施工中)」が両方ある組織で
  //    どちらが返るか非決定的になり、完成済みの現場に原価が付く。しかも再現しない。
  const byName = await prisma.project.findMany({
    where: { orgId, name: needle },
    select: { id: true, name: true, code: true },
    take: 2,
  });
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return null;

  const partial = await prisma.project.findMany({
    where: { orgId, name: { contains: escapeLike(needle), mode: 'insensitive' } },
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
    where: { orgId, name: { contains: escapeLike(needle), mode: 'insensitive' } },
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
  } else if (x.incurredOn === null) {
    // ⚠️ 受信日で仮置きしない。月末に先月分をまとめて送るのは建設業では普通で、
    //    黙って今日の日付を入れると全部が今月に計上され、期ズレが静かに起きる
    line += '\n→ 日付を読み取れませんでした。経理 > 原価 から日付を入れて登録してください。';
  } else if (project === null) {
    line += '\n→ どの工事か特定できませんでした。経理 > 原価 で工事を選んで登録してください。';
  } else {
    line += '\n→ 読み取りの確からしさが低いため、自動では登録しませんでした。経理 > 原価 から確認してください。';
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

  /* 明細を作ってよいか。
     ⚠️ どれか1つでも欠けたら作らない。「読めなかった項目を今日の日付や 0 円で埋める」と、
        承認画面ではもっともらしく見えてそのまま確定される。プロンプト側も
        「読めない項目は必ず null」と指示しているので、受け取る側も同じ規律で扱う。 */
  const total = extraction.amountIncludingTax;
  const incurredOnIso = parseDateOnly(extraction.incurredOn ?? '');
  const canCreate =
    project !== null &&
    total !== null &&
    total > 0 &&
    incurredOnIso !== null &&
    extraction.confidence >= MIN_CONFIDENCE;

  if (!canCreate) {
    return { summary: summarizeExtraction(extraction, project, false), costEntryId: null };
  }

  const vendor = await matchVendor(args.orgId, extraction.vendorHint);
  const category = VALID_CATEGORIES.has(extraction.category ?? '')
    ? (extraction.category as string)
    : 'OTHER';

  /* 消費税額。読めていればその値を使い、読めていなければ税込から割り戻す。
     ⚠️ 労務費（自社雇用の賃金）は不課税なので割り戻さない。一律10%で割ると、
        労務費の比率が高い建設業では原価が実額より小さく出て粗利が良く見える。
     ⚠️ 読み取った税額が本体価格以上になるのは「合計」と「消費税」の取り違え。
        そのまま使うと本体価格 0 円の明細ができるので、割り戻しに退避する。 */
  const split = splitTaxInclusive(total);
  const readTax = extraction.taxAmount;
  const taxAmount =
    category === 'LABOR' && readTax === null
      ? 0
      : readTax !== null && readTax >= 0 && readTax < total
        ? readTax
        : split.taxAmount;
  const amount = total - taxAmount;

  /* 同じ写真を2回送るのは日常的に起きる（「送れたか不安でもう一度」）。
     webhookEventId の unique 制約は LINE の再送しか弾けないので、内容で見る。 */
  const duplicate = await prisma.costEntry.findFirst({
    where: { orgId: args.orgId, projectId: project.id, incurredOn: incurredOnIso, amount, category },
    select: { id: true },
  });
  if (duplicate) {
    return {
      summary: `${summarizeExtraction(extraction, project, false)}\n→ 同じ内容の明細が既にあるため、追加しませんでした。`,
      costEntryId: null,
    };
  }

  const entry = await prisma.costEntry.create({
    data: {
      orgId: args.orgId,
      projectId: (project as { id: string }).id,
      vendorId: vendor?.id ?? null,
      incurredOn: incurredOnIso,
      category,
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
