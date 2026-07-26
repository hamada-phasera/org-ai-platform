const PptxGenJS = require('pptxgenjs');

// ── 配色: 製品自身のUI（インディゴ × スレート）に合わせる ──
const C = {
  deep: '312E81',   // 深いインディゴ（濃色スライド背景）
  accent: '4F46E5', // インディゴ（アクセント）
  soft: 'EEF2FF',   // 薄インディゴ（カード地）
  ink: '0F172A',    // 本文
  muted: '64748B',  // 補足
  line: 'CBD5E1',   // 罫
  warn: 'B45309',   // 課題・限界（琥珀）
  ok: '0D9488',     // 効果（ティール）
  white: 'FFFFFF',
};
const F = 'Meiryo';

const pres = new PptxGenJS();
pres.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5
pres.author = 'FLOW';
pres.title = 'FLOW — みんなのAIオフィス';

const W = 13.33, M = 0.7;
const BODY_TOP = 1.75;   // 本文開始
const BODY_BOT = 6.45;   // 本文終端（ページ番号 6.85 の上）

function darkSlide() {
  const s = pres.addSlide();
  s.background = { color: C.deep };
  return s;
}
function lightSlide(title, kicker) {
  const s = pres.addSlide();
  s.background = { color: C.white };
  if (kicker) {
    s.addText(kicker, {
      x: M, y: 0.42, w: 7, h: 0.3, fontFace: F, fontSize: 12, bold: true,
      color: C.accent, charSpacing: 2, margin: 0,
    });
  }
  s.addText(title, {
    x: M, y: 0.72, w: W - M * 2, h: 0.75, fontFace: F, fontSize: 34, bold: true,
    color: C.ink, margin: 0,
  });
  return s;
}
function pageNum(s, n) {
  s.addText(String(n), {
    x: W - 1.0, y: 6.9, w: 0.4, h: 0.3, fontFace: F, fontSize: 11,
    color: C.muted, align: 'right', margin: 0,
  });
}
function card(s, x, y, w, h, fill) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.06,
    fill: { color: fill || C.soft }, line: { width: 0 },
    shadow: { type: 'outer', angle: 90, blur: 8, offset: 1, opacity: 0.10, color: '000000' },
  });
}
function numCircle(s, x, y, n, color, d) {
  const sz = d || 0.55;
  s.addShape(pres.ShapeType.ellipse, {
    x, y, w: sz, h: sz, fill: { color: color || C.accent }, line: { width: 0 },
  });
  s.addText(String(n), {
    x, y, w: sz, h: sz, fontFace: F, fontSize: 18, bold: true,
    color: C.white, align: 'center', valign: 'middle', margin: 0,
  });
}
function box(s, x, y, w, h, label, sub, fill, txtColor) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.06,
    fill: { color: fill }, line: { color: C.line, width: 1 },
  });
  s.addText(label, {
    x, y: sub ? y + 0.14 : y, w, h: sub ? h * 0.48 : h, fontFace: F, fontSize: 14, bold: true,
    color: txtColor || C.ink, align: 'center', valign: 'middle', margin: 0,
  });
  if (sub) {
    s.addText(sub, {
      x, y: y + h * 0.5, w, h: h * 0.44, fontFace: F, fontSize: 11,
      color: txtColor || C.muted, align: 'center', valign: 'middle', margin: 0,
    });
  }
}
function vArrow(s, x, y, h) {
  s.addShape(pres.ShapeType.downArrow, {
    x, y, w: 0.28, h: h || 0.34, fill: { color: C.line }, line: { width: 0 },
  });
}
function hArrow(s, x, y, w) {
  s.addShape(pres.ShapeType.rightArrow, {
    x, y, w: w || 0.42, h: 0.28, fill: { color: C.line }, line: { width: 0 },
  });
}
// 細い接続線。塗りと同色の輪郭を付けないと LibreOffice 等で中空の二重線に見える。
function connector(s, x, y, w, h) {
  s.addShape(pres.ShapeType.rect, {
    x, y, w, h, fill: { color: C.line }, line: { color: C.line, width: 0.75 },
  });
}
// 3カラム / 5カラムの共通幅（右端を本文幅 W-M*2 にきっちり合わせる）
const CONTENT_W = W - M * 2;
const COL3_GAP = 0.235, COL3_W = (CONTENT_W - COL3_GAP * 2) / 3;
const COL5_GAP = 0.16, COL5_W = (CONTENT_W - COL5_GAP * 4) / 5;
const HALF_GAP = 0.25, HALF_W = (CONTENT_W - HALF_GAP) / 2;

/* ───────────── 1. タイトル ───────────── */
{
  const s = darkSlide();
  s.addText('FLOW — みんなのAIオフィス', {
    x: M, y: 2.55, w: W - M * 2, h: 1.0, fontFace: F, fontSize: 44, bold: true,
    color: C.white, margin: 0,
  });
  s.addText('中小企業向け 組織型AIエージェント基盤の設計と実装', {
    x: M, y: 3.62, w: W - M * 2, h: 0.55, fontFace: F, fontSize: 20,
    color: 'C7D2FE', margin: 0,
  });
  connector(s, M, 4.45, 1.6, 0.035);
  s.addText('2026年7月31日', {
    x: M, y: 4.75, w: 6, h: 0.4, fontFace: F, fontSize: 15, color: 'A5B4FC', margin: 0,
  });
  s.addNotes('FLOW、みんなのAIオフィスについて発表します。中小企業向けの、組織型AIエージェント基盤です。個人で約4か月、約2万2千行を実装しました。');
}

/* ───────────── 2. 背景 ───────────── */
{
  const s = lightSlide('AIを入れたいが、運用できない', 'BACKGROUND｜背景');
  const items = [
    ['導入意欲は高い', '「AIを使いたい」というニーズは中小企業にも強くある'],
    ['専任担当がいない', '誰がどう使うかが定まらず、導入しても定着しない'],
    ['費用が読めない', '従量課金のため、使うほどコストが見通せなくなる'],
  ];
  const h = 1.42, gap = 0.22;
  items.forEach(([t, d], i) => {
    const y = BODY_TOP + i * (h + gap);
    card(s, M, y, W - M * 2, h);
    numCircle(s, M + 0.4, y + (h - 0.55) / 2, i + 1);
    s.addText(t, { x: M + 1.2, y: y + 0.26, w: 5, h: 0.45, fontFace: F, fontSize: 19, bold: true, color: C.ink, margin: 0 });
    s.addText(d, { x: M + 1.2, y: y + 0.76, w: 10.3, h: 0.45, fontFace: F, fontSize: 14, color: C.muted, margin: 0 });
  });
  pageNum(s, 2);
  s.addNotes('中小企業でもAIを使いたいという要望は強い一方、専任の担当者がいません。個別のAIツールを導入しても、誰がどう使うかが定まらず、定着しないという状況があります。さらに、従量課金のため、使うほど費用が読めなくなるという問題もあります。');
}

/* ───────────── 3. 目的 ───────────── */
{
  const s = lightSlide('「ツールの集合」ではなく「組織」として動かす', 'OBJECTIVE｜目的');
  box(s, 5.27, 1.95, 2.8, 1.0, '社長（ユーザー）', '指示を出すだけ', C.deep, C.white);
  vArrow(s, 6.53, 3.08, 0.42);
  const depts = [['営業部AI', '提案・商談'], ['SNSマーケ部AI', '投稿下書き'], ['経理部AI', '経費・集計'], ['分析部AI', 'KPI可視化']];
  const dw = 2.72, dstep = 3.07, dx0 = M;
  // 横線は両端の縦線ちょうどで止める（はみ出さない）
  const dFirst = dx0 + dw / 2, dLast = dx0 + 3 * dstep + dw / 2;
  connector(s, dFirst, 3.62, dLast - dFirst, 0.03);
  depts.forEach(([n, d], i) => {
    const x = dx0 + i * dstep;
    connector(s, x + dw / 2 - 0.015, 3.62, 0.03, 0.28);
    box(s, x, 3.9, dw, 1.15, n, d, C.soft);
  });
  card(s, M, 5.35, W - M * 2, 1.1, C.deep);
  s.addText('分担 → 実行 → 報告　／　組織図をそのままシステム構造に写像', {
    x: M + 0.3, y: 5.55, w: W - M * 2 - 0.6, h: 0.7, fontFace: F, fontSize: 17, bold: true,
    color: C.white, align: 'center', valign: 'middle', margin: 0,
  });
  pageNum(s, 3);
  s.addNotes('そこで本システムは、社長が指示を出すと、営業・SNSマーケ・経理などの部署ごとのAIが分担して実行し、報告するという構造を目指しました。ツールの集合ではなく、組織として振る舞わせることが狙いです。');
}

/* ───────────── 4. 課題 ───────────── */
{
  const s = lightSlide('実現を阻む3つの課題', 'PROBLEM｜課題');
  const items = [
    ['コスト', '高性能LLMを全員に使わせると、\n利用量に比例して費用が膨張する', '中小企業向けの価格が成立しない'],
    ['可用性', '自動化基盤に依存すると、\nそれが止まれば業務も止まる', '外部サービスの停止＝業務停止'],
    ['信頼性', '無確認の外部発信、\n個人情報のLLM送信', '仕組みで抑える必要がある'],
  ];
  const cw = COL3_W, cg = COL3_GAP;
  items.forEach(([t, d, note], i) => {
    const x = M + i * (cw + cg);
    card(s, x, BODY_TOP, cw, BODY_BOT - BODY_TOP, C.soft);
    numCircle(s, x + 0.38, BODY_TOP + 0.42, i + 1, C.warn, 0.62);
    s.addText(t, { x: x + 0.38, y: BODY_TOP + 1.28, w: cw - 0.76, h: 0.5, fontFace: F, fontSize: 22, bold: true, color: C.ink, margin: 0 });
    s.addText(d, { x: x + 0.38, y: BODY_TOP + 2.0, w: cw - 0.7, h: 1.4, fontFace: F, fontSize: 14, color: C.ink, margin: 0, lineSpacing: 24 });
    connector(s, x + 0.38, BODY_TOP + 3.5, cw - 0.9, 0.02);
    s.addText(note, { x: x + 0.38, y: BODY_TOP + 3.72, w: cw - 0.7, h: 0.75, fontFace: F, fontSize: 12.5, italic: true, color: C.warn, margin: 0 });
  });
  pageNum(s, 4);
  s.addNotes('実現には3つの課題がありました。1つ目はコストです。高性能なLLMを全ユーザーに使わせると、利用量に比例して費用が膨らみ、中小企業向けの価格設定が成り立ちません。2つ目は可用性です。自動化基盤としてワークフローツールを使う場合、それが停止すると業務まで止まってしまいます。3つ目は信頼性です。AIが確認なく外部に発信したり、個人情報をそのまま外部のLLMに送ってしまうリスクを、どう仕組みとして抑えるかという問題です。');
}

/* ───────────── 5. 関連研究 ───────────── */
{
  const s = lightSlide('既存手段では埋まらない領域', 'RELATED WORK｜既存手法・関連研究');
  const cols = [
    ['汎用チャットAI', ['組織の役割分担がない', '毎回、人が文脈を与える必要']],
    ['単機能AI SaaS', ['個別には優秀', 'しかし互いに連携しない']],
    ['RPA', ['決められた手順は正確', 'しかし判断はできない']],
  ];
  const cw = COL3_W, cg = COL3_GAP, ch = 3.0;
  cols.forEach(([h, lines], i) => {
    const x = M + i * (cw + cg);
    card(s, x, BODY_TOP, cw, ch);
    s.addText(h, { x: x + 0.38, y: BODY_TOP + 0.35, w: cw - 0.76, h: 0.5, fontFace: F, fontSize: 18, bold: true, color: C.ink, margin: 0 });
    connector(s, x + 0.38, BODY_TOP + 1.0, cw - 0.9, 0.02);
    s.addText(lines.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j !== lines.length - 1 } })), {
      x: x + 0.38, y: BODY_TOP + 1.28, w: cw - 0.7, h: 1.5, fontFace: F, fontSize: 14, color: C.muted, margin: 0, paraSpaceAfter: 10,
    });
  });
  card(s, M, BODY_TOP + ch + 0.35, W - M * 2, BODY_BOT - (BODY_TOP + ch + 0.35), C.deep);
  s.addText('組織として分担しながら、判断を伴う実行まで行う基盤は存在しない', {
    x: M + 0.4, y: BODY_TOP + ch + 0.35, w: W - M * 2 - 0.8, h: BODY_BOT - (BODY_TOP + ch + 0.35),
    fontFace: F, fontSize: 19, bold: true, color: C.white, align: 'center', valign: 'middle', margin: 0,
  });
  pageNum(s, 5);
  s.addNotes('既存の手段としては、汎用のチャットAI、単機能のAI SaaS、そしてRPAが挙げられます。しかし汎用チャットには組織としての役割分担がなく、毎回人間が文脈を与える必要があります。単機能SaaSは個別には優秀ですが、互いに連携しません。RPAは決められた手順は正確に実行できますが、判断はできません。組織として分担しながら、判断を伴う実行まで行う基盤は見当たりませんでした。');
}

/* ───────────── 6. 提案・全体像 ───────────── */
{
  const s = lightSlide('3層構成 ＋ 3つの設計方針', 'PROPOSAL｜提案手法');
  const layers = [
    ['画面 (React + TypeScript)', 'ユーザーが指示を出す'],
    ['APIゲートウェイ (Fastify)', '認証・権限・監査ログ'],
    ['AI処理エンジン (FastAPI)', 'Intent分類・LLM呼び出し'],
    ['PostgreSQL', '唯一の真実の源'],
  ];
  const lh = 0.92, lgap = 0.26;
  layers.forEach(([n, d], i) => {
    const y = BODY_TOP + i * (lh + lgap);
    box(s, M, y, 5.85, lh, n, d, i === 3 ? C.deep : C.soft, i === 3 ? C.white : null);
    if (i < 3) vArrow(s, M + 5.85 / 2 - 0.14, y + lh + 0.02, 0.22);
  });
  box(s, 7.2, BODY_TOP + 1.4, 2.4, 0.92, 'n8n', '自動化の加速層', C.white);
  connector(s, M + 5.85, BODY_TOP + 1.85, 7.2 - (M + 5.85), 0.03);
  s.addText('補助的な位置づけ', { x: 7.2, y: BODY_TOP + 2.42, w: 2.4, h: 0.3, fontFace: F, fontSize: 10.5, color: C.muted, align: 'center', margin: 0 });
  const pillars = [['① コスト設計', C.accent, 'LLMの出し分け'], ['② 縮退設計', C.ok, '依存しない実行'], ['③ ガバナンス', C.warn, '安全性をコードに']];
  pillars.forEach(([t, col, d], i) => {
    const y = BODY_TOP + i * 1.6;
    card(s, 10.0, y, 2.63, 1.35, C.soft);
    s.addShape(pres.ShapeType.ellipse, { x: 10.25, y: y + 0.26, w: 0.34, h: 0.34, fill: { color: col }, line: { width: 0 } });
    s.addText(t, { x: 10.68, y: y + 0.2, w: 1.85, h: 0.45, fontFace: F, fontSize: 14, bold: true, color: C.ink, valign: 'middle', margin: 0 });
    s.addText(d, { x: 10.25, y: y + 0.75, w: 2.2, h: 0.4, fontFace: F, fontSize: 11.5, color: C.muted, margin: 0 });
  });
  pageNum(s, 6);
  s.addNotes('提案するシステムは、画面、APIゲートウェイ、AI処理エンジンの3層構成です。データベースにPostgreSQL、自動化にワークフロー基盤を組み合わせています。この上に、コスト設計、縮退設計、ガバナンス内蔵という3つの設計方針を組み込みました。以降、この3点を順に説明します。');
}

/* ───────────── 7. 提案① 松竹梅 ───────────── */
{
  const s = lightSlide('プラン別にLLMを出し分ける', 'PROPOSAL ①｜コスト設計');
  box(s, 5.07, BODY_TOP, 3.2, 1.0, '判定は1つの関数に集約', 'resolve_provider_model()', C.deep, C.white);
  const outs = [
    ['梅・竹 プラン', 'Gemini（無料枠）', C.ok],
    ['松・管理者', 'Claude（高性能）', C.accent],
    ['エージェント構築', 'Opus 固定', C.warn],
  ];
  const cw = COL3_W, cg = COL3_GAP, cy = BODY_TOP + 1.72;
  // 分岐の接続線（縦→横→縦）。横線は両端の縦線ちょうどで止める。
  const firstCx = M + cw / 2, lastCx = M + 2 * (cw + cg) + cw / 2;
  connector(s, 6.65, BODY_TOP + 1.0, 0.03, 0.34);
  connector(s, firstCx, BODY_TOP + 1.34, lastCx - firstCx, 0.03);
  outs.forEach(([t, d, col], i) => {
    const x = M + i * (cw + cg);
    connector(s, x + cw / 2 - 0.015, BODY_TOP + 1.34, 0.03, 0.38);
    card(s, x, cy, cw, 1.3, C.soft);
    s.addShape(pres.ShapeType.ellipse, { x: x + 0.35, y: cy + 0.45, w: 0.4, h: 0.4, fill: { color: col }, line: { width: 0 } });
    s.addText(t, { x: x + 0.92, y: cy + 0.3, w: cw - 1.2, h: 0.4, fontFace: F, fontSize: 15, bold: true, color: C.ink, margin: 0 });
    s.addText(d, { x: x + 0.92, y: cy + 0.72, w: cw - 1.2, h: 0.36, fontFace: F, fontSize: 13, color: C.muted, margin: 0 });
  });
  const by = cy + 1.55;
  card(s, M, by, W - M * 2, BODY_BOT - by, C.soft);
  const pts = [
    '呼び出し側（チャット / 部署機能 / n8n）は変更ゼロ',
    'キー未設定なら安全側（Claude）へ自動フォールバック',
    '実測：下位プランの応答 843 ミリ秒',
  ];
  s.addText(pts.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i !== pts.length - 1 } })), {
    x: M + 0.45, y: by + 0.25, w: W - M * 2 - 0.9, h: BODY_BOT - by - 0.5, fontFace: F, fontSize: 15, color: C.ink, margin: 0, paraSpaceAfter: 9,
  });
  pageNum(s, 7);
  s.addNotes('1つ目はコスト設計です。契約プランに応じて、使用するLLMを出し分けます。下位プランは無料枠のあるGemini、上位プランと管理者は高性能なClaudeを使います。設計上の要点は、この判定をたった1つの関数に集約したことです。その結果、チャットも、各部署の生成機能も、外部のワークフロー基盤からの呼び出しも、呼び出し側を一切変更することなく、同じ方針が適用されます。またキーが未設定の場合は安全側であるClaudeに自動で切り替わるため、設定漏れで機能が止まることはありません。実測では、下位プランの応答時間は843ミリ秒でした。');
}

/* ───────────── 8. 提案② 縮退設計 ───────────── */
{
  const s = lightSlide('自動化基盤に「依存しない」', 'PROPOSAL ②｜縮退設計');
  // 分岐は「縦の合流線」で結ぶ。矢印を箱の中心へ直接引くと上下の分岐に届かず宙に浮くため。
  const fy = BODY_TOP + 0.25;
  const upY = fy + 0.5, dnY = fy + 1.85, midY = fy + 1.175; // 各段の中心
  const jL = 3.95, jR = 8.45;                                // 左右の合流線の x
  box(s, M, midY - 0.5, 2.6, 1.0, 'タスク発生', null, C.soft);
  box(s, 4.45, upY - 0.5, 3.3, 1.0, 'n8n 経由', '通常はこちら', C.soft);
  box(s, 4.45, dnY - 0.5, 3.3, 1.0, 'AIエンジン直接', 'n8n 停止時', C.ok, C.white);
  box(s, 8.95, midY - 0.5, 2.6, 1.0, '完了', 'DBに記録', C.deep, C.white);
  // 左：タスク発生 → 合流線 → 上下の分岐へ
  connector(s, M + 2.6, midY - 0.015, jL - (M + 2.6), 0.03);
  connector(s, jL - 0.015, upY, 0.03, dnY - upY);
  hArrow(s, jL, upY - 0.14, 0.5);
  hArrow(s, jL, dnY - 0.14, 0.5);
  // 右：上下の分岐 → 合流線 → 完了へ
  connector(s, 7.75, upY - 0.015, jR - 7.75, 0.03);
  connector(s, 7.75, dnY - 0.015, jR - 7.75, 0.03);
  connector(s, jR - 0.015, upY, 0.03, dnY - upY);
  hArrow(s, jR, midY - 0.14, 0.5);
  const by = BODY_TOP + 3.35;
  card(s, M, by, W - M * 2, BODY_BOT - by, C.soft);
  const pts = [
    'DB ＝ 唯一の真実の源／n8n ＝ 速度のための補助層',
    '開発中に無料枠超過でDB停止を経験 → 起動時の接続にも再試行を追加',
    '「障害は起きる前提」で組む',
  ];
  s.addText(pts.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i !== pts.length - 1 } })), {
    x: M + 0.45, y: by + 0.22, w: W - M * 2 - 0.9, h: BODY_BOT - by - 0.44, fontFace: F, fontSize: 15, color: C.ink, margin: 0, paraSpaceAfter: 9,
  });
  pageNum(s, 8);
  s.addNotes('2つ目は縮退設計です。データベースを唯一の真実の源とし、ワークフロー基盤は処理を速くするための補助層と位置づけました。ワークフロー基盤が停止していても、AIエンジン側の経路に自動で切り替えて処理を完了させます。つまり自動化基盤に依存しないという性質を、設計によって確保しています。実際、開発中にデータベースの無料枠を使い切ってサービスが停止する事象が起きましたが、この経験を踏まえ、起動時の接続処理にも再試行を入れました。障害は起きる前提で組む、という方針です。');
}

/* ───────────── 9. 提案③ ガバナンス ───────────── */
{
  const s = lightSlide('安全性を「運用ルール」でなく「コード」に', 'PROPOSAL ③｜ガバナンス内蔵');
  const flow = [['入力', 'ユーザー指示'], ['PII検知', '個人情報を遮断'], ['LLM', '生成'], ['監査ログ', '全入出力を記録']];
  // 4箱＋3矢印が 13.33in に収まるよう幅を決め、左右対称に中央寄せする
  const bw = 2.5, bgap = 0.42;
  const flowX0 = (W - (bw * 4 + bgap * 3)) / 2;
  flow.forEach(([n, d], i) => {
    const x = flowX0 + i * (bw + bgap);
    box(s, x, BODY_TOP, bw, 1.0, n, d, i === 1 ? C.warn : C.soft, i === 1 ? C.white : null);
    if (i < 3) hArrow(s, x + bw + 0.03, BODY_TOP + 0.36, 0.36);
  });
  s.addText('記録項目：プロバイダ／モデル／トークン数／応答時間／リスクスコア', {
    x: M, y: BODY_TOP + 1.1, w: W - M * 2, h: 0.35, fontFace: F, fontSize: 12.5, color: C.muted, align: 'center', margin: 0,
  });
  const gy = BODY_TOP + 1.75;
  card(s, M, gy, W - M * 2, BODY_BOT - gy, C.soft);
  s.addText('SNS投稿は「承認ゲート」必須 — AIは自動投稿しない', {
    x: M + 0.45, y: gy + 0.25, w: 9, h: 0.45, fontFace: F, fontSize: 19, bold: true, color: C.ink, margin: 0,
  });
  const g = [['AI', '下書きを生成', C.white], ['承認待ち', 'ここで停止', C.warn], ['人間が承認', '初めて投稿可', C.ok]];
  const gw = 3.35, ggap = 0.49, gx0 = M + 0.45;
  g.forEach(([n, d, col], i) => {
    const x = gx0 + i * (gw + ggap);
    box(s, x, gy + 1.0, gw, 1.3, n, d, col, col === C.white ? null : C.white);
    if (i < 2) hArrow(s, x + gw + 0.06, gy + 1.51, 0.36);
  });
  s.addText('承認されるまで、AI は投稿処理そのものを実行できない', {
    x: gx0, y: gy + 2.45, w: W - M * 2 - 0.9, h: 0.4, fontFace: F, fontSize: 13,
    color: C.muted, margin: 0,
  });
  pageNum(s, 9);
  s.addNotes('3つ目はガバナンスです。まず個人情報の検知を通してからLLMに送信します。そしてすべての入出力を監査ログに記録します。記録するのは、使用したプロバイダ、モデル、トークン数、応答時間、そしてリスクスコアです。さらにSNS投稿については、AIが生成できるのは下書きまでとし、人間が承認するまで投稿されない設計にしました。安全性を運用ルールに委ねず、コード側の制約として持たせている点が特徴です。');
}

/* ───────────── 10. 実験・評価 ───────────── */
{
  const s = lightSlide('実装規模と検証結果', 'EXPERIMENT & EVALUATION｜実験・評価');
  const stats = [['18', 'DBテーブル'], ['22', 'APIルート'], ['6', '部署AI'], ['15', '画面'], ['100', '自動テスト全成功']];
  const sw = COL5_W, sg = COL5_GAP;
  stats.forEach(([v, l], i) => {
    const x = M + i * (sw + sg);
    card(s, x, BODY_TOP, sw, 1.75, i === 4 ? C.deep : C.soft);
    s.addText(v, { x, y: BODY_TOP + 0.22, w: sw, h: 0.85, fontFace: F, fontSize: 40, bold: true, color: i === 4 ? C.white : C.accent, align: 'center', margin: 0 });
    s.addText(l, { x, y: BODY_TOP + 1.12, w: sw, h: 0.4, fontFace: F, fontSize: 11.5, color: i === 4 ? 'C7D2FE' : C.muted, align: 'center', margin: 0 });
  });
  const by = BODY_TOP + 2.15;
  card(s, M, by, HALF_W, BODY_BOT - by, C.soft);
  s.addText('開発規模', { x: M + 0.4, y: by + 0.25, w: 5, h: 0.4, fontFace: F, fontSize: 17, bold: true, color: C.ink, margin: 0 });
  connector(s, M + 0.4, by + 0.78, HALF_W - 0.8, 0.02);
  const l1 = ['約4か月 / 113コミット', '約22,400行（TypeScript・Python・Go）', '18テーブル / 7マイグレーション'];
  s.addText(l1.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i !== l1.length - 1 } })), {
    x: M + 0.4, y: by + 1.0, w: HALF_W - 0.8, h: BODY_BOT - by - 1.2, fontFace: F, fontSize: 14, color: C.ink, margin: 0, paraSpaceAfter: 9,
  });
  card(s, M + HALF_W + HALF_GAP, by, HALF_W, BODY_BOT - by, C.soft);
  s.addText('RAG：組織知の蓄積', { x: M + HALF_W + HALF_GAP + 0.4, y: by + 0.25, w: 5, h: 0.4, fontFace: F, fontSize: 17, bold: true, color: C.ink, margin: 0 });
  connector(s, M + HALF_W + HALF_GAP + 0.4, by + 0.78, HALF_W - 0.8, 0.02);
  const l2 = ['1024次元ベクトルで文章を索引', '別セッションの内容を想起（実証済み）', '埋め込みも同じGemini → 追加契約ゼロ'];
  s.addText(l2.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i !== l2.length - 1 } })), {
    x: M + HALF_W + HALF_GAP + 0.4, y: by + 1.0, w: HALF_W - 0.8, h: BODY_BOT - by - 1.2, fontFace: F, fontSize: 14, color: C.ink, margin: 0, paraSpaceAfter: 9,
  });
  pageNum(s, 10);
  s.addNotes('実装と検証の結果です。約4か月、113コミットで、データベース18テーブル、API22ルート、部署AI6種類、画面15枚を実装しました。自動テストは100件すべて成功しています。また社内知識の蓄積のため、ベクトル検索による情報検索を組み込みました。1024次元のベクトルで文章を索引し、あるセッションで伝えた社内ルールを、別のセッションから正しく思い出せることを確認しています。埋め込みの生成にも同じGeminiを使うため、追加の契約は不要です。');
}

/* ───────────── 11. 考察 ───────────── */
{
  const s = lightSlide('得られた知見と、残る限界', 'DISCUSSION｜考察');
  const ch = BODY_BOT - BODY_TOP;
  card(s, M, BODY_TOP, HALF_W, ch, C.soft);
  s.addShape(pres.ShapeType.ellipse, { x: M + 0.4, y: BODY_TOP + 0.35, w: 0.42, h: 0.42, fill: { color: C.ok }, line: { width: 0 } });
  s.addText('効果', { x: M + 0.98, y: BODY_TOP + 0.3, w: 4, h: 0.5, fontFace: F, fontSize: 21, bold: true, color: C.ink, valign: 'middle', margin: 0 });
  connector(s, M + 0.4, BODY_TOP + 1.0, HALF_W - 0.8, 0.02);
  // 箇条書き内で \n を使うと別項目として弾点が付くため、改行を入れず自然折り返しに任せる
  const eff = ['コストは「単価」でなく「出し分けの構造」で解ける', '可用性は「依存しない設計」で確保できる', '安全性はコードの制約として持てる'];
  s.addText(eff.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i !== eff.length - 1 } })), {
    x: M + 0.4, y: BODY_TOP + 1.2, w: HALF_W - 0.8, h: ch - 1.45, fontFace: F, fontSize: 15, color: C.ink, margin: 0, paraSpaceAfter: 20,
  });
  card(s, M + HALF_W + HALF_GAP, BODY_TOP, HALF_W, ch, C.soft);
  s.addShape(pres.ShapeType.ellipse, { x: M + HALF_W + HALF_GAP + 0.4, y: BODY_TOP + 0.35, w: 0.42, h: 0.42, fill: { color: C.warn }, line: { width: 0 } });
  s.addText('限界', { x: M + HALF_W + HALF_GAP + 0.98, y: BODY_TOP + 0.3, w: 4, h: 0.5, fontFace: F, fontSize: 21, bold: true, color: C.ink, valign: 'middle', margin: 0 });
  connector(s, M + HALF_W + HALF_GAP + 0.4, BODY_TOP + 1.0, HALF_W - 0.8, 0.02);
  const lim = ['無料枠には上限あり — 実際に到達しサービス停止を経験', '評価は実装と自動テストまで', '実利用者による有効性検証は未実施'];
  s.addText(lim.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i !== lim.length - 1 } })), {
    x: M + HALF_W + HALF_GAP + 0.4, y: BODY_TOP + 1.2, w: HALF_W - 0.8, h: ch - 1.45, fontFace: F, fontSize: 15, color: C.ink, margin: 0, paraSpaceAfter: 20,
  });
  pageNum(s, 11);
  s.addNotes('考察です。コストの問題は、単価を下げるのではなく、出し分けの構造によって解けることが確認できました。可用性についても、依存しないという設計方針によって確保できています。一方で限界もあります。無料枠には上限があり、実際に上限へ到達してサービスが停止する事象を経験しました。また本発表での評価は、実装と自動テストまでです。実際の利用者による有効性の検証は、これからの課題です。');
}

/* ───────────── 12. まとめ ───────────── */
{
  const s = darkSlide();
  s.addText('まとめ', { x: M, y: 0.85, w: 6, h: 0.75, fontFace: F, fontSize: 36, bold: true, color: C.white, margin: 0 });
  connector(s, M, 1.72, 1.4, 0.035);
  const items = [
    ['実装', '中小企業向け 組織型AIエージェント基盤'],
    ['解決', 'コスト／可用性／信頼性を、設計で解く'],
    ['今後', '実運用による有効性の検証'],
  ];
  items.forEach(([t, d], i) => {
    const y = 2.25 + i * 1.35;
    s.addShape(pres.ShapeType.roundRect, {
      x: M, y, w: W - M * 2, h: 1.1, rectRadius: 0.06,
      fill: { color: '3B37A0' }, line: { width: 0 },
    });
    s.addText(t, { x: M + 0.5, y: y + 0.3, w: 1.6, h: 0.5, fontFace: F, fontSize: 17, bold: true, color: 'A5B4FC', valign: 'middle', margin: 0 });
    s.addText(d, { x: M + 2.3, y: y + 0.3, w: 9.2, h: 0.5, fontFace: F, fontSize: 18, bold: true, color: C.white, valign: 'middle', margin: 0 });
  });
  s.addText('ご清聴ありがとうございました', {
    x: M, y: 6.45, w: W - M * 2, h: 0.45, fontFace: F, fontSize: 15, color: 'A5B4FC', align: 'center', margin: 0,
  });
  s.addNotes('まとめます。中小企業向けの組織型AIエージェント基盤を実装しました。コスト、可用性、信頼性という3つの課題に対し、それぞれ設計上の解を示しました。今後は実際の運用による検証を進めます。以上です。');
}

pres.writeFile({ fileName: 'FLOW-presentation-2026-07-31.pptx' }).then((f) => console.log('生成:', f));
