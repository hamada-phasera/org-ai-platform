/**
 * FLOW 価格設計デッキ（PPTX）の生成。
 *   node docs/pricing/build-deck.mjs
 *
 * 見た目は tiktok-trend-research/design/phasera/DECK-STYLE.md の契約に従う。
 * あちらの src/theme.ts はフッターが週次リサーチ固定なので流用せず、
 * トークン（色・フォント・寸法）とアセットだけを借りて、この資料用の部品をここに置く。
 *
 * 守る決め事（DECK-STYLE §0）:
 *   絵文字を使わない / 感嘆符を固定文言に使わない / 英語はモノスペース大文字のラベルだけ /
 *   セリフ斜体の青いアクセントは表紙に1か所だけ / 青の単色系＋金の一点（金は表紙のみ）/
 *   アイコンを使わない（点・細線・矢印・中黒・全角ダッシュで足りる）/
 *   日本語の句読点は全角、数値は半角 / 制作者名・ロゴマークは既定で出さない。
 *
 * 数値はすべて調査で裏が取れたもの。出典はスライド17にまとめてある。
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, '../../../tiktok-trend-research');
const require = createRequire(join(KIT, 'package.json'));
const pptxgen = require('pptxgenjs');

// ── トークン（DECK-STYLE §1） ──────────────────────────────
const INK = '0B1E3F', INK_2 = '1E3358', INK_SOFT = '4D6488';
const BRAND = '3C66D9', BLUE_400 = '5A91DD', BLUE_300 = '6FA8FF';
const BLUE_200 = '9CC4FF', BLUE_100 = 'C7D8F2';
const BG_2 = 'E7EDF6', PAPER = 'FFFFFF', GOLD = 'C99B5C';
const OK = '1F8A5B', WARN = 'B57A12', ERR = 'B0344B';
const LINE = 'E2E4E8', WHITE = 'FFFFFF';

const FONT_JP = 'Noto Sans JP';
const FONT_DISPLAY = 'Manrope';
const FONT_MONO = 'JetBrains Mono';
const FONT_SERIF = 'Instrument Serif';

const W = 10, H = 5.625, M = 0.5, CW = 9.0;
const HAIRLINE = 0.75;
const SIZE = { eyebrow: 9, title: 22, h2: 13, body: 10, caption: 8, footer: 7.5, kpi: 26 };

const asset = (n) => join(KIT, 'design/phasera/assets', n);
const jp = (t) => /[ぁ-んァ-ン一-龯ー、。：「」（）]/.test(String(t));
const fontFor = (t, role = 'display') => (jp(t) ? FONT_JP : role === 'mono' ? FONT_MONO : FONT_DISPLAY);

// ── 部品 ──────────────────────────────────────────────
function bgLight(s) { s.background = { path: asset('page-light.png') }; }
function bgAurora(s) { s.background = { path: asset('cover-aurora.png') }; }

function rule(s, x, y, w, color = LINE, width = HAIRLINE) {
  s.addShape('line', { x, y, w, h: 0, line: { color, width } });
}

function card(s, x, y, w, h, o = {}) {
  s.addShape('roundRect', {
    x, y, w, h, rectRadius: 0.06,
    fill: { color: o.fill ?? PAPER },
    line: { color: o.line ?? LINE, width: HAIRLINE },
  });
}

/** eyebrow（モノスペース大文字）＋ 日本語見出し ＋ 細線 */
function header(s, eyebrowLabel, title) {
  s.addText(eyebrowLabel, {
    x: M, y: 0.34, w: CW, h: 0.2,
    fontFace: FONT_MONO, fontSize: SIZE.eyebrow, color: BRAND,
    charSpacing: 2, valign: 'middle', margin: 0,
  });
  s.addText(title, {
    x: M, y: 0.58, w: CW, h: 0.48,
    fontFace: FONT_JP, fontSize: SIZE.title, bold: true, color: INK,
    valign: 'middle', margin: 0,
  });
  rule(s, M, 1.12, CW);
}

function footer(s, page, total) {
  s.addText('FLOW PRICING · 2026-09-11', {
    x: M, y: 5.3, w: 4.4, h: 0.22,
    fontFace: FONT_MONO, fontSize: SIZE.footer, color: INK_SOFT,
    charSpacing: 2, valign: 'middle', margin: 0,
  });
  s.addText([
    { text: '原価は実測・相場は公式一次情報 · ', options: { fontFace: FONT_JP, fontSize: SIZE.footer, color: INK_SOFT } },
    { text: `p.${page}/${total}`, options: { fontFace: FONT_MONO, fontSize: SIZE.footer, color: INK_SOFT } },
  ], { x: W - M - 4.4, y: 5.3, w: 4.4, h: 0.22, align: 'right', valign: 'middle', margin: 0 });
}

/** 数値タイル */
function kpi(s, x, y, w, h, label, value, unit, valueColor = INK) {
  card(s, x, y, w, h);
  s.addText(label, {
    x: x + 0.16, y: y + 0.12, w: w - 0.32, h: 0.22,
    fontFace: FONT_JP, fontSize: SIZE.caption, color: INK_SOFT, valign: 'middle', margin: 0,
  });
  const runs = [{ text: value, options: { fontFace: fontFor(value), fontSize: SIZE.kpi, bold: true, color: valueColor } }];
  if (unit) runs.push({ text: ` ${unit}`, options: { fontFace: FONT_MONO, fontSize: 11, color: BRAND } });
  s.addText(runs, {
    x: x + 0.16, y: y + 0.34, w: w - 0.32, h: h - 0.5,
    valign: 'middle', margin: 0,
  });
}

/** 点つきの箇条書き（アイコンを使わない） */
function dotList(s, items, o) {
  const gap = o.gap ?? 0.04;
  const fs = o.fontSize ?? SIZE.body;
  const lineH = o.lineH ?? 0.3;
  let y = o.y;
  for (const it of items) {
    const text = typeof it === 'string' ? it : it.text;
    const color = typeof it === 'string' ? (o.color ?? INK_2) : (it.color ?? o.color ?? INK_2);
    s.addShape('ellipse', { x: o.x, y: y + lineH / 2 - 0.035, w: 0.07, h: 0.07, fill: { color: o.dot ?? BRAND }, line: { color: o.dot ?? BRAND, width: 0 } });
    s.addText(text, {
      x: o.x + 0.18, y, w: o.w - 0.18, h: lineH,
      fontFace: FONT_JP, fontSize: fs, color, valign: 'top', margin: 0, lineSpacingMultiple: 1.25,
    });
    y += lineH + gap;
  }
  return y;
}

/** 表。header 行は BG_2 */
function table(s, rows, o) {
  s.addTable(rows, {
    x: o.x, y: o.y, w: o.w,
    colW: o.colW,
    border: { type: 'solid', color: LINE, pt: 0.5 },
    fontFace: FONT_JP, fontSize: o.fontSize ?? 9, color: INK_2,
    valign: 'middle', margin: o.margin ?? 0.06,
    autoPage: false,
    rowH: o.rowH,
  });
}
const th = (t) => ({ text: t, options: { fill: { color: BG_2 }, bold: true, color: INK, fontSize: 8.5 } });
const td = (t, opt = {}) => ({ text: String(t), options: { fontFace: jp(t) ? FONT_JP : FONT_MONO, ...opt } });

function note(s, text, y) {
  s.addShape('roundRect', { x: M, y, w: CW, h: 0.42, rectRadius: 0.05, fill: { color: BG_2 }, line: { color: LINE, width: HAIRLINE } });
  s.addText(text, {
    x: M + 0.14, y, w: CW - 0.28, h: 0.42,
    fontFace: FONT_JP, fontSize: 8.5, color: INK_2, valign: 'middle', margin: 0, lineSpacingMultiple: 1.2,
  });
}

// ── デッキ ────────────────────────────────────────────
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_16x9';
pptx.author = '';
pptx.company = '';
pptx.title = 'FLOW 価格設計';

const TOTAL = 17;
let page = 0;
const newSlide = (eyebrowLabel, title) => {
  const s = pptx.addSlide();
  bgLight(s);
  page += 1;
  if (eyebrowLabel) header(s, eyebrowLabel, title);
  footer(s, page, TOTAL);
  return s;
};

// 1. 表紙
{
  const s = pptx.addSlide();
  bgAurora(s);
  page = 1;
  s.addShape('ellipse', { x: M, y: 1.62, w: 0.09, h: 0.09, fill: { color: GOLD }, line: { color: GOLD, width: 0 } });
  s.addText('PRICING DESIGN', {
    x: M + 0.2, y: 1.55, w: 5, h: 0.24,
    fontFace: FONT_MONO, fontSize: SIZE.eyebrow, color: BLUE_200, charSpacing: 2, valign: 'middle', margin: 0,
  });
  s.addText('FLOW の価格をいくらにするか', {
    x: M, y: 1.95, w: CW, h: 0.7,
    fontFace: FONT_JP, fontSize: 34, bold: true, color: WHITE, valign: 'middle', margin: 0,
  });
  s.addText([
    { text: '原価は実測、相場は公式の一次情報。', options: { fontFace: FONT_JP, fontSize: 13, color: BLUE_100 } },
    { text: '推測で埋めない。', options: { fontFace: FONT_SERIF, fontSize: 15, italic: true, color: BLUE_200 } },
  ], { x: M, y: 2.72, w: CW, h: 0.36, valign: 'middle', margin: 0 });
  rule(s, M, 3.25, 3.2, '2D354F');
  s.addText('2026-09-11 · 中小建設業ほか 従業員5〜50人向け', {
    x: M, y: 3.4, w: CW, h: 0.26,
    fontFace: FONT_JP, fontSize: 10, color: BLUE_100, valign: 'middle', margin: 0,
  });
  footer(s, 1, TOTAL);
}

// 2. 結論
{
  const s = newSlide('CONCLUSION', '結論 — 月9,800円から、初期費用0円、AI込み');
  const rows = [
    [th(''), th('月額（税抜）'), th('年額 一括（20%引）'), th('月あたり換算'), th('実行量の目安'), th('粗利率')],
    [td('梅'), td('9,800円'), td('94,080円'), td('7,840円'), td('月300往復'), td('70%')],
    [td('竹'), td('19,800円'), td('190,080円'), td('15,840円'), td('月800往復'), td('62%')],
    [td('松'), td('34,800円'), td('334,080円'), td('27,840円'), td('月2,000往復'), td('55%')],
  ];
  table(s, rows, { x: M, y: 1.32, w: CW, colW: [0.7, 1.55, 1.9, 1.5, 1.75, 1.6], rowH: 0.32 });

  dotList(s, [
    { text: '全プラン ユーザー数無制限。人数で課金しない。' },
    { text: '初期費用 0円。無料トライアル 30日。' },
    { text: 'AIは別建てにせず込み。LINE領収書の読み取りも上位プランの追加課金にしない。' },
    { text: '本文生成は全プラン同じ品質（Claude Sonnet）。差は実行量と機能で付ける。' },
  ], { x: M, y: 3.0, w: CW, lineH: 0.28 });

  note(s, '松の 34,800円は、中小建設SaaSの実績値（BRANU の1社あたり月25,535円、SPIDERPLUS の1社あたり月14,833円）から見た到達可能な上限。5万円超は中小建設業では別の市場になる。', 4.45);
}

// 3. 調べ方
{
  const s = newSlide('METHOD', '調べ方 — 自己申告を採らない');
  dotList(s, [
    '原価は、このプロダクトのコードから実測した。プロンプトの文字数、1往復あたりのLLM呼び出し回数、どのプランがどのモデルを使うかを、実際のソースで確認している。',
    '単価は各社の公式価格ページから取得した。Anthropic・Google・Render・Supabase・Vercel。',
    '相場は公式の料金ページと、上場企業のIR開示（決算説明資料）から取った。ベンダーの宣伝記事は採用していない。',
    '確認できなかったものは「不明」と書いた。それらしい数値を作っていない。',
  ], { x: M, y: 1.4, w: CW, lineH: 0.42, gap: 0.1 });

  card(s, M, 3.55, CW, 1.1);
  s.addText('不明のまま残したもの', {
    x: M + 0.18, y: 3.66, w: CW - 0.36, h: 0.22,
    fontFace: FONT_JP, fontSize: SIZE.caption, color: INK_SOFT, valign: 'middle', margin: 0,
  });
  s.addText('中小建設業の1社あたりIT支出の実額 · 建設業の売上高対IT投資比率 · インボイス／電帳法が導入に与えた影響の定量調査 · 日本の上場SaaSの最新粗利率中央値 · Gemini無料枠の具体的なレート上限（Googleが公開を停止）', {
    x: M + 0.18, y: 3.9, w: CW - 0.36, h: 0.62,
    fontFace: FONT_JP, fontSize: 9, color: INK_2, valign: 'top', margin: 0, lineSpacingMultiple: 1.3,
  });
}

// 4. 原価①
{
  const s = newSlide('COST · 1', '原価① — 1往復あたりの実測');
  const rows = [
    [th('モデル'), th('入力 $/100万tok'), th('出力 $/100万tok'), th('1往復の原価')],
    [td('Claude Opus 5'), td('5.00'), td('25.00'), td('14.41円')],
    [td('Claude Sonnet 5'), td('2.00'), td('10.00'), td('5.76円')],
    [td('Claude Haiku 4.5'), td('1.00'), td('5.00'), td('2.88円')],
  ];
  table(s, rows, { x: M, y: 1.32, w: 5.3, colW: [1.7, 1.3, 1.3, 1.0], rowH: 0.3 });

  kpi(s, 6.0, 1.32, 3.5, 0.82, '1往復の入力トークン（実測）', '8,300', 'tok');
  kpi(s, 6.0, 2.24, 3.5, 0.82, '出力トークン（典型）', '1,200', 'tok');

  dotList(s, [
    'プロンプトの実寸から算出。部署の system prompt 最大1,884文字＋共通のセキュリティ核1,205文字＋直近履歴＋ユーザー発話。',
    'Claude 4.7以降は新しいトークナイザで、同じ文章でも約30%多くトークンを消費する。上の円換算はその30%増を含む。',
    'RAG（資料の引用）が効くと入力は17,900トークンまで増える。原価は約1.7倍になる。',
  ], { x: M, y: 3.05, w: CW, lineH: 0.34, gap: 0.06 });

  note(s, '為替は 1USD = 155円で計算。実勢（2026-09-11）は154.3円だが、円安側に振れたときに値付けを誤らないよう保守的に取っている。', 4.5);
}

// 5. 原価②
{
  const s = newSlide('COST · 2', '原価② — 顧客数に関係なくかかる固定費');
  const rows = [
    [th('項目'), th('月額'), th('なぜ下げられないか')],
    [td('Vercel Pro'), td('$20'), td('Hobby は商用利用不可。コードを書いた人が報酬を受け取っているだけで商用扱いになる')],
    [td('Supabase Pro'), td('$25'), td('Free は1週間アクセスが無いとプロジェクトが停止する')],
    [td('Render workspace'), td('$25'), td('Hobby でも可。その場合はシート1・帯域5GB')],
    [td('Render compute'), td('$7'), td('Free は15分でスリープし、月750時間の上限がある')],
  ];
  table(s, rows, { x: M, y: 1.32, w: CW, colW: [1.8, 0.9, 6.3], rowH: 0.32 });

  kpi(s, M, 3.3, 2.9, 0.9, '固定費の下限（月）', '11,900', '円');
  kpi(s, 3.55, 3.3, 2.9, 0.9, '1社のとき 1社あたり', '11,900', '円', ERR);
  kpi(s, 6.6, 3.3, 2.9, 0.9, '10社のとき 1社あたり', '1,190', '円', OK);

  note(s, '固定費は顧客数に関係なくかかるので、1社目は必ず赤字になる。2社目以降で薄まる。上の粗利率はすべて10社時点の按分で計算している。', 4.5);
}

// 6. 原価③
{
  const s = newSlide('COST · 3', '原価③ — プラン別の原価と粗利率');
  const rows = [
    [th(''), th('実行量'), th('変動費'), th('固定費の按分（10社）'), th('原価 合計'), th('価格'), th('粗利率')],
    [td('梅'), td('月300往復'), td('約1,995円'), td('1,190円'), td('約2,940円'), td('9,800円'), td('70%')],
    [td('竹'), td('月800往復'), td('約6,300円'), td('1,190円'), td('約7,490円'), td('19,800円'), td('62%')],
    [td('松'), td('月2,000往復'), td('約14,500円'), td('1,190円'), td('約15,690円'), td('34,800円'), td('55%')],
  ];
  table(s, rows, { x: M, y: 1.32, w: CW, colW: [0.6, 1.35, 1.3, 1.85, 1.35, 1.25, 1.3], rowH: 0.32 });

  dotList(s, [
    { text: 'SaaSベンチマーク（342社・2025年通年）ではソフトウェア粗利率の中央値は80%、AIを組み込んだ製品は50〜60%に圧縮される。' },
    { text: '梅70% · 竹62% · 松55% は、AI原価を抱えた製品としては健全な水準に収まっている。' },
    { text: 'ただしこれは「エージェント化提案のOpus固定」を直した前提。直さないと梅の原価は約14,650円に跳ね、粗利率は26%まで落ちる。', color: ERR },
  ], { x: M, y: 3.05, w: CW, lineH: 0.36, gap: 0.08 });

  note(s, '実行量は上限であって保証ではない。超えた場合はいきなり止めず、警告 → モデルの降格 → 計上のみ、の順で効かせる。顧客の業務を止めないため。', 4.5);
}

// 7. 原価で見つかった問題
{
  const s = newSlide('COST · FINDINGS', '価格をつける前に直すこと');
  const items = [
    {
      t: '1. エージェント化提案が、全プランで Claude Opus を呼んでいる',
      d: '会話の3ターン目以降ほぼ毎回発火する。1回あたり12.09円で、これは本文生成（Haiku 2.88円）の4倍。梅プランでは原価の93%を占める。一次判定を安いモデルに落とせば約1/10になる。',
    },
    {
      t: '2. Gemini の無料枠は、有償プランの土台にできない',
      d: '公式に「入力内容が Google の製品改善に使われる」と明記されている。領収書の取引先名・金額、LINEの顧客とのやり取りを扱う以上、この経路には流せない。加えてレート上限が非公開でSLAも無い。',
    },
    {
      t: '3. 画面に表示しているモデル名が、実際に動くものと違う',
      d: '梅は「Claude Haiku 4.5」と表示しているが Gemini flash-lite が動く。竹は「Claude Sonnet 4.6」と表示して Gemini flash が動く。3プラン中2つで、顧客が受け取っていないモデル名を出している。',
    },
  ];
  let y = 1.32;
  for (const it of items) {
    card(s, M, y, CW, 1.12);
    s.addText(it.t, {
      x: M + 0.2, y: y + 0.12, w: CW - 0.4, h: 0.26,
      fontFace: FONT_JP, fontSize: 11, bold: true, color: INK, valign: 'middle', margin: 0,
    });
    s.addText(it.d, {
      x: M + 0.2, y: y + 0.42, w: CW - 0.4, h: 0.6,
      fontFace: FONT_JP, fontSize: 9, color: INK_2, valign: 'top', margin: 0, lineSpacingMultiple: 1.3,
    });
    y += 1.24;
  }
}

// 8. 相場①
{
  const s = newSlide('MARKET · 1', '相場① — 業務システム1本にいくら払っているか');
  const rows = [
    [th('用途'), th('従業員5〜50人の企業が払っている月額')],
    [td('クラウド会計（freee・マネーフォワード）'), td('2,980円 〜 8,980円')],
    [td('業務アプリ基盤 kintone（10名・スタンダード）'), td('18,000円')],
    [td('勤怠管理（50名・全機能）'), td('25,000円')],
    [td('経費精算（50名規模）'), td('15,000円 〜 50,000円')],
    [td('RPA 1本（Robo-Pat・アシロボ）'), td('40,000円 〜 120,000円')],
    [td('ChatGPT Business（20名・年払）'), td('約61,000円')],
  ];
  table(s, rows, { x: M, y: 1.32, w: CW, colW: [5.4, 3.6], rowH: 0.3 });

  note(s, 'FLOW の比較対象は ChatGPT Business ではなく RPA。「AIとの会話の席」ではなく「部署の実務を代行する仕組み」だから。稟議の場でも、RPA1本ぶんの値段で部署がいくつも動く、という比較の方が通る。', 3.65);

  dotList(s, [
    '業務システム1本の実勢レンジは月1万〜5万円。人の代替と見なされる RPA / AI席だけが月4万〜12万円まで伸びる。',
    '国内SaaSの8割以上が3プラン以内。松竹梅という設計自体は相場に合っている。',
  ], { x: M, y: 4.3, w: CW, lineH: 0.32, gap: 0.06 });
}

// 9. 相場②
{
  const s = newSlide('MARKET · 2', '相場② — 建設業向けは9,800〜15,000円に収束している');
  const rows = [
    [th('サービス'), th('月額（税抜）'), th('条件'), th('初期費用')],
    [td('サクミル'), td('9,800円'), td('20アカウント込み、21件目以降 1,000円/件'), td('0円')],
    [td('ツクノビAIクラウド LIGHT'), td('9,800円'), td('5〜50名。LINEで写真・音声→日報／請求／原価／見積'), td('記載なし')],
    [td('BRANU CAREECON Plus mini'), td('12,000円'), td('3,145社が契約中'), td('—')],
    [td('現場ポケット'), td('13,500円'), td('アカウント・現場・容量すべて無制限（年契約）'), td('要相談')],
    [td('ダンドリワーク'), td('15,000円〜'), td('1人1ID。協力会社にも個別ID'), td('20万円〜')],
  ];
  table(s, rows, { x: M, y: 1.32, w: CW, colW: [2.5, 1.15, 4.05, 1.3], rowH: 0.34 });

  note(s, '独立した4社以上がこの帯に収束している。月1万円は、この市場ではすでに受け入れられている入口価格であって、高くない。', 3.5);

  dotList(s, [
    { text: 'ツクノビAIクラウドは、同じ「LINEで領収書→原価計上」を9,800円のオールインワン・契約縛りなしで出しており、FLOW のターゲットに正面から重なる。', color: WARN },
    { text: '建設業許可業者は483,823社。うち99.5%が中小で、1〜10人が74.0%を占める。', color: INK_2 },
  ], { x: M, y: 4.15, w: CW, lineH: 0.36, gap: 0.06 });
}

// 10. 相場③ 価格弾力性
{
  const s = newSlide('MARKET · 3', '相場③ — 1万円台前半に価格の断層がある');
  s.addText('BRANU（東証グロース・中小建設専業）の実測値', {
    x: M, y: 1.3, w: CW, h: 0.26,
    fontFace: FONT_JP, fontSize: 11, bold: true, color: INK, valign: 'middle', margin: 0,
  });

  kpi(s, M, 1.65, 2.9, 0.95, '入口プラン mini の月額', '12,000', '円');
  kpi(s, 3.55, 1.65, 2.9, 0.95, 'mini の契約社数', '3,145', '社');
  kpi(s, 6.6, 1.65, 2.9, 0.95, '1社あたり月次売上', '25,535', '円');

  card(s, M, 2.85, CW, 1.0, { fill: 'FBF1F3', line: 'E9C9D0' });
  s.addText('10,000円 → 12,000円 の値上げで、月次解約率が 0.25% → 0.36%（1.4倍）に上昇', {
    x: M + 0.2, y: 2.97, w: CW - 0.4, h: 0.28,
    fontFace: FONT_JP, fontSize: 12, bold: true, color: ERR, valign: 'middle', margin: 0,
  });
  s.addText('同社が決算説明資料で「2025年10月期の単価改定の影響」と明記している。2,000円の値上げが直ちに解約に変わる帯だということ。', {
    x: M + 0.2, y: 3.3, w: CW - 0.4, h: 0.45,
    fontFace: FONT_JP, fontSize: 9, color: INK_2, valign: 'top', margin: 0, lineSpacingMultiple: 1.3,
  });

  dotList(s, [
    '入口を9,800円に置いたのは、この断層を踏まないため。12,000円でも売れているが、断層の手前に置く方が安全。',
    '参考: SPIDERPLUS は1社あたり月14,833円（1IDでは4,997円）、企業単位の月次解約率0.9%。',
  ], { x: M, y: 4.0, w: CW, lineH: 0.34, gap: 0.06 });
}

// 11. 相場④ 高単価ほど解約
{
  const s = newSlide('MARKET · 4', '相場④ — 高く売るほど解約が跳ねる');
  const rows = [
    [th('プラン'), th('月額'), th('月次解約率'), th('年換算の離脱'), th('出典')],
    [td('BRANU mini'), td('12,000円'), td('0.36%'), td('約4%'), td('決算説明資料')],
    [td('BRANU 上位（Middle / Standard）'), td('30,000〜100,000円'), td('2.44%'), td('約25%'), td('同上')],
    [td('SPIDERPLUS（企業単位）'), td('約14,833円'), td('0.9%'), td('約10%'), td('決算説明資料')],
  ];
  table(s, rows, { x: M, y: 1.32, w: CW, colW: [2.8, 1.85, 1.25, 1.4, 1.7], rowH: 0.34 });

  card(s, M, 2.85, CW, 0.95, { fill: 'FBF1F3', line: 'E9C9D0' });
  s.addText('月3万円超のプランは、月次2.44% — 年に4社に1社が離れている', {
    x: M + 0.2, y: 2.96, w: CW - 0.4, h: 0.28,
    fontFace: FONT_JP, fontSize: 12, bold: true, color: ERR, valign: 'middle', margin: 0,
  });
  s.addText('「高単価で少数に売る」戦略が、この市場では機能していないという実測。松を34,800円に抑えたのはこのため。', {
    x: M + 0.2, y: 3.28, w: CW - 0.4, h: 0.42,
    fontFace: FONT_JP, fontSize: 9, color: INK_2, valign: 'top', margin: 0, lineSpacingMultiple: 1.3,
  });

  dotList(s, [
    '解約の理由として各社・各調査が挙げているのは、値上げそのもの、効果が見えないこと、現場に定着しないこと、そして顧客企業自体の消滅。',
    '令和7年度に17,998社が建設業許可を失効（前年度比+51.9%）。2024年の建設業倒産は1,890件で過去10年最多。中小建設業には不可避の解約母数が構造的に存在する。',
  ], { x: M, y: 3.95, w: CW, lineH: 0.38, gap: 0.06 });
}

// 12. 単価構造
{
  const s = newSlide('MARKET · 5', '現場アプリと会計・台帳は、単価構造が逆');
  const rows = [
    [th(''), th('現場アプリ（施工管理）'), th('会計・工事台帳・原価管理')],
    [td('月額レンジ'), td('9,800 〜 33,000円'), td('8,500 〜 40,500円')],
    [td('1ユーザー単価'), td('1,200 〜 5,000円/月'), td('8,500 〜 27,500円/月')],
    [td('想定人数'), td('20〜100人（協力会社を含む）'), td('1〜5人（経理担当）')],
    [td('初期費用'), td('0 〜 20万円'), td('0 〜 12万円。74〜130万円の買い切りも現役')],
    [td('契約形態'), td('月額中心'), td('年間契約が既定')],
  ];
  table(s, rows, { x: M, y: 1.32, w: CW, colW: [1.7, 3.65, 3.65], rowH: 0.34 });

  card(s, M, 3.5, CW, 1.0);
  s.addText('FLOW は両方を持っている', {
    x: M + 0.2, y: 3.62, w: CW - 0.4, h: 0.26,
    fontFace: FONT_JP, fontSize: 11, bold: true, color: INK, valign: 'middle', margin: 0,
  });
  s.addText('現場がLINEで領収書を送る「現場側」と、工事台帳・原価・インボイスの「経理側」。1人あたりで見ると経理側の単価は現場側の5〜10倍で、どちらの論理を取るかで結論が真逆になる。案Cは現場側の単価で入口を作り、機能の厚みで上位を取る形にしている。', {
    x: M + 0.2, y: 3.9, w: CW - 0.4, h: 0.5,
    fontFace: FONT_JP, fontSize: 9, color: INK_2, valign: 'top', margin: 0, lineSpacingMultiple: 1.3,
  });
}

// 13. 価格の型
{
  const s = newSlide('PRICING MODEL', '価格の型 — 国内431サービスの実地調査から');
  const rows = [
    [th('論点'), th('実勢'), th('FLOW の採用')],
    [td('プラン数'), td('8割以上が3プラン以内'), td('3プラン（梅・竹・松）')],
    [td('年額割引'), td('設けているのは2割。設ける場合は15〜25%'), td('20%引き（2か月無料相当）')],
    [td('初期費用'), td('クラウドSaaSは0円が標準'), td('0円')],
    [td('無料トライアル'), td('国内業務SaaSの最頻値は30日'), td('30日')],
    [td('課金単位'), td('freee・MF はハイブリッド、Make・n8n はユーザー無制限'), td('定額・ユーザー数無制限')],
  ];
  table(s, rows, { x: M, y: 1.32, w: CW, colW: [1.6, 4.6, 2.8], rowH: 0.34 });

  dotList(s, [
    { text: 'ユーザー課金を採らない理由: 42.6%の中小企業がデジタル関連の予算枠を持っておらず、人数×単価で毎月額が動く価格は承認が通らない。' },
    { text: 'さらに、会社主導で導入した企業の方が効果実感が10ポイント以上高いのに、ユーザー課金は「アカウントを増やさない」動機を生む。効果が出る使い方を価格が妨げてしまう。' },
    { text: 'Automation 領域で価格を公開しているのは16.7%だけ。価格を出すこと自体が差別化になる。', color: BRAND },
  ], { x: M, y: 3.45, w: CW, lineH: 0.38, gap: 0.06 });
}

// 14. 価格より効くこと
{
  const s = newSlide('BARRIERS', '価格は、1位の障壁ではない');
  s.addText('生成AI導入の課題（商工中金 · 有効回答3,892社）', {
    x: M, y: 1.3, w: CW, h: 0.26,
    fontFace: FONT_JP, fontSize: 11, bold: true, color: INK, valign: 'middle', margin: 0,
  });
  const bars = [
    ['具体的な活用場面が不明', 35.6, ERR],
    ['導入を推進する人材がいない', 32.0, BRAND],
    ['従業員の知識不足・心理的抵抗', 29.2, BLUE_400],
    ['社内ルール整備が追いつかない', 25.1, BLUE_400],
    ['導入予算や時間を確保できない', 19.4, INK_SOFT],
  ];
  let y = 1.66;
  for (const [label, pct, color] of bars) {
    s.addText(label, {
      x: M, y, w: 3.1, h: 0.26,
      fontFace: FONT_JP, fontSize: 9.5, color: INK_2, valign: 'middle', margin: 0,
    });
    s.addShape('rect', { x: 3.7, y: y + 0.06, w: (pct / 40) * 4.6, h: 0.14, fill: { color }, line: { color, width: 0 } });
    s.addText(`${pct}%`, {
      x: 8.5, y, w: 1.0, h: 0.26,
      fontFace: FONT_MONO, fontSize: 9.5, color: INK, valign: 'middle', margin: 0,
    });
    y += 0.34;
  }

  card(s, M, 3.45, CW, 1.15);
  s.addText('価格を1,000円下げるより効くこと', {
    x: M + 0.2, y: 3.56, w: CW - 0.4, h: 0.26,
    fontFace: FONT_JP, fontSize: 11, bold: true, color: INK, valign: 'middle', margin: 0,
  });
  dotList(s, [
    '建設業の成果物サンプルを出す。中小機構の調査で「不足している情報」の1位は成功事例・活用事例（83.3%）。',
    '価格を公開する。Automation 領域の公開率は16.7%しかない。',
    '補助金の導線を作る。希望する支援策の1位は補助金・助成金（59.3%）。',
  ], { x: M + 0.2, y: 3.85, w: CW - 0.4, lineH: 0.22, gap: 0.02, fontSize: 8.5 });
}

// 15. 補助金
{
  const s = newSlide('SUBSIDY', 'デジタル化・AI導入補助金2026');
  dotList(s, [
    'IT導入補助金が2026年から改称され、生成AI・AIエージェントが明確に補助対象になった。',
    'クラウド利用料は最大2年分が補助対象。導入コンサルティング・導入設定・研修・保守サポートも対象に含まれる。',
    '通常枠の補助率は1/2以内。低賃金雇用従業員が30%以上の事業者は2/3以内。補助額は5万円から450万円。',
  ], { x: M, y: 1.4, w: CW, lineH: 0.38, gap: 0.08 });

  kpi(s, M, 2.75, 2.9, 0.95, '梅の月額', '9,800', '円');
  kpi(s, 3.55, 2.75, 2.9, 0.95, '補助率1/2なら実質', '4,900', '円', OK);
  kpi(s, 6.6, 2.75, 2.9, 0.95, '補助率2/3なら実質', '3,267', '円', OK);

  note(s, '価格ページに載せるなら「デジタル化・AI導入補助金2026の補助対象です（採択を保証するものではありません）」と併記する。断定すると誤解を生む。', 3.95);

  s.addText('東京商工会議所の調査では、希望する支援策の1位が補助金・助成金で59.3%。建設業を対象にしたJICEの調査でも、補助金の活用希望が55.0%（活用済は23.3%）。', {
    x: M, y: 4.5, w: CW, h: 0.5,
    fontFace: FONT_JP, fontSize: 9, color: INK_SOFT, valign: 'top', margin: 0, lineSpacingMultiple: 1.3,
  });
}

// 16. 決定と次の一手
{
  const s = newSlide('DECISION', '決めたこと、次にやること');
  card(s, M, 1.32, 4.35, 1.55);
  s.addText('決めたこと', {
    x: M + 0.2, y: 1.44, w: 3.95, h: 0.24,
    fontFace: FONT_JP, fontSize: 11, bold: true, color: INK, valign: 'middle', margin: 0,
  });
  dotList(s, [
    '案C — 9,800 / 19,800 / 34,800円',
    '初期費用 0円',
    'AIは別建てにせず込み',
    '年額は20%引き、トライアル30日',
  ], { x: M + 0.2, y: 1.74, w: 3.95, lineH: 0.24, gap: 0.02, fontSize: 9 });

  card(s, 5.15, 1.32, 4.35, 1.55, { fill: 'FBF1F3', line: 'E9C9D0' });
  s.addText('価格を載せる前に直すこと', {
    x: 5.35, y: 1.44, w: 3.95, h: 0.24,
    fontFace: FONT_JP, fontSize: 11, bold: true, color: ERR, valign: 'middle', margin: 0,
  });
  dotList(s, [
    'エージェント化提案のOpus固定を外す',
    'Gemini無料枠から離脱する',
    '表示モデル名を実態に合わせる',
  ], { x: 5.35, y: 1.78, w: 3.95, lineH: 0.26, gap: 0.04, fontSize: 9, dot: ERR });

  s.addText('そのあとの実装', {
    x: M, y: 3.05, w: CW, h: 0.26,
    fontFace: FONT_JP, fontSize: 11, bold: true, color: INK, valign: 'middle', margin: 0,
  });
  dotList(s, [
    'プラン定義を1か所にまとめる。実行量・メンバー数・ストレージ容量・モデルを同じ表に乗せ、散らばらせない。',
    'Stripe を組み込む。Checkout と Billing Portal と Webhook の3本だけ。キーが無い環境でもアプリが壊れない形にする。',
    '上限に達しても止めない。警告 → モデルの降格 → 計上のみ、の順で効かせる。顧客の業務を止めないため。',
  ], { x: M, y: 3.4, w: CW, lineH: 0.34, gap: 0.06 });
}

// 17. 出典
{
  const s = newSlide('SOURCES', '出典');
  const left = [
    '単価 — Anthropic 公式価格ページ',
    '単価 — Google Gemini API 公式価格ページ',
    'インフラ — Render / Supabase / Vercel 公式',
    '相場 — サクミル / 現場ポケット / Kizuku 公式',
    '相場 — ダンドリワーク / 蔵衛門 / どっと原価 公式',
    '相場 — 勘定奉行 / PCA / アイピア 公式',
    '相場 — freee / マネーフォワード / kintone 公式',
    'AI上乗せ — ツクノビAIクラウド / バレーナ 公式',
  ];
  const right = [
    'IR — BRANU 2026年10月期2Q 決算説明資料',
    'IR — SPIDERPLUS FY2024.Q4 決算説明資料',
    '調査 — 商工中金「中小企業の生成AIの利用にかかる調査」n=3,892',
    '調査 — 東京商工会議所「デジタルシフト・DX実態調査」n=1,218',
    '調査 — 中小機構「中小企業のAI等の利活用に係る実態調査」n=1,647',
    '統計 — 国土交通省 建設業許可業者数（令和8年3月末）',
    '統計 — 国土交通省 令和6年度 建設業構造実態調査',
    'ベンチマーク — 2026 SaaS & AI Performance Benchmarks（342社）',
    '制度 — 中小機構 デジタル化・AI導入補助金2026 通常枠',
  ];
  dotList(s, left, { x: M, y: 1.35, w: 4.3, lineH: 0.26, gap: 0.03, fontSize: 8.5, color: INK_2 });
  dotList(s, right, { x: 5.15, y: 1.35, w: 4.35, lineH: 0.26, gap: 0.03, fontSize: 8.5, color: INK_2 });

  note(s, '原価の実測（プロンプトの文字数、1往復あたりの呼び出し回数、プラン別のモデル）は org-ai-platform のソースコードから取得。詳細は docs/pricing/ に置いた計算スクリプトを参照。', 4.55);
}

const OUT = join(HERE, 'FLOW_価格設計_2026-09-11.pptx');
mkdirSync(HERE, { recursive: true });
await pptx.writeFile({ fileName: OUT });
console.log(`生成: ${OUT}`);
console.log(`スライド数: ${TOTAL}`);
