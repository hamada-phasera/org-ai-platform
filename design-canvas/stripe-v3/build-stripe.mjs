#!/usr/bin/env node
/**
 * FLOW UI — Stripe風モダンSaaS方向のアートボード生成。
 * 共通シェル（サイドバー・トップバー・部署トグル）とトークンをここで一元管理し、
 * 12枚の .dc.html を out/ に書き出す。リキッドガラス直系のボードは生成しない。
 * ダークモードは廃止（テーマトグルなし）。部署トグルはトップバーに常設。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

/* ── トークン ─────────────────────────────────────── */
const CSS = `
  :root{
    --ink:#0a2540; --ink2:#425466; --ink3:#687385; --ink4:#8898aa;
    --bg:#f6f9fc; --surface:#ffffff; --line:#e6ebf1; --line2:#d5dbe1;
    --brand:#635bff; --brand-h:#5851df; --brand-soft:#f4f4ff; --brand-line:#dedbff;
    --ok:#1a9c6b; --ok-soft:#e6f6ef; --warn:#b25e09; --warn-soft:#fdf3e7;
    --bad:#df1b41; --bad-soft:#fdeef1; --info:#0570de; --info-soft:#e9f2fd;
    --sales:#4f46e5; --mkt:#9333ea; --acct:#0284c7; --anl:#0d9488; --gen:#475569;
    --sh-sm:0 1px 2px rgba(16,36,64,.07),0 1px 5px rgba(16,36,64,.04);
    --sh-md:0 6px 12px -2px rgba(50,50,93,.12),0 3px 7px -3px rgba(0,0,0,.12);
    --sh-lg:0 15px 35px rgba(60,66,87,.11),0 5px 15px rgba(0,0,0,.07);
    --grad:linear-gradient(90deg,#11efe3,#635bff 46%,#e932a5);
  }
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:'Figtree','Hiragino Sans','Noto Sans JP',-apple-system,sans-serif;
    -webkit-font-smoothing:antialiased;font-size:14px;line-height:1.55;}
  a{color:var(--brand);text-decoration:none} a:hover{color:var(--brand-h)}
  .num{font-variant-numeric:tabular-nums}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--sh-sm)}
  .btn{display:inline-flex;align-items:center;gap:7px;border-radius:8px;font-weight:600;font-size:13.5px;
    padding:8px 16px;border:1px solid transparent;cursor:pointer}
  .btn-p{background:var(--brand);color:#fff;box-shadow:0 1px 2px rgba(10,37,64,.24),inset 0 1px 0 rgba(255,255,255,.16)}
  .btn-s{background:#fff;color:var(--ink);border-color:var(--line2);box-shadow:var(--sh-sm)}
  .btn-g{background:transparent;color:var(--ink2)}
  .chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;font-size:11.5px;font-weight:600;padding:3px 10px}
  .seg{display:inline-flex;background:#eef2f7;border-radius:9px;padding:3px;gap:2px}
  .seg button{border:none;background:transparent;border-radius:7px;padding:5px 13px;font-size:12.5px;
    font-weight:600;color:var(--ink3);cursor:pointer;font-family:inherit;white-space:nowrap}
  .seg .on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(16,36,64,.14)}
  .th{font-size:10.5px;font-weight:700;letter-spacing:.08em;color:var(--ink3);text-transform:uppercase}
  .lbl{font-size:11px;font-weight:700;letter-spacing:.07em;color:var(--ink3);text-transform:uppercase}
  .avatar{display:flex;align-items:center;justify-content:center;border-radius:999px;overflow:hidden;flex:none}
`;

/* ── アイコン（stroke SVG・16px基準） ───────────────── */
const ic = (d, s = 15) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none">${d}</svg>`;
const I = {
  home: ic('<path d="M3 10.5 12 3l9 7.5"></path><path d="M5 9.5V21h14V9.5"></path>'),
  dash: ic('<path d="M4 20V10"></path><path d="M10 20V4"></path><path d="M16 20v-6"></path><path d="M22 20H2"></path>'),
  chat: ic('<path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"></path>'),
  bot: ic('<rect x="5" y="8" width="14" height="11" rx="3"></rect><path d="M12 4v4M9 13h.01M15 13h.01"></path>'),
  doc: ic('<path d="M6 3h8l4 4v14H6z"></path><path d="M14 3v4h4"></path>'),
  task: ic('<path d="M4 6h2M4 12h2M4 18h2M10 6h10M10 12h10M10 18h10"></path>'),
  shield: ic('<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"></path>'),
  gear: ic('<circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"></path>'),
  search: ic('<circle cx="11" cy="11" r="7"></circle><path d="m21 21-4-4"></path>', 14),
  plus: ic('<path d="M12 5v14M5 12h14"></path>', 14),
  send: ic('<path d="M22 2 11 13"></path><path d="M22 2 15 22l-4-9-9-4z"></path>', 14),
  check: ic('<path d="M20 6 9 17l-5-5"></path>', 13),
  clock: ic('<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>', 13),
  arrow: ic('<path d="M5 12h14M13 6l6 6-6 6"></path>', 13),
  spark: ic('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"></path>', 14),
  file: ic('<path d="M6 3h8l4 4v14H6z"></path><path d="M14 3v4h4"></path>', 13),
  alert: ic('<path d="M12 3 2 20h20z"></path><path d="M12 10v4M12 17h.01"></path>', 14),
};

const deptDot = (c) => `<span style="width:8px;height:8px;border-radius:3px;background:${c};flex:none"></span>`;
const deptChip = (label, color) =>
  `<span class="chip" style="background:${color}14;color:${color}">${label}</span>`;

/* ── 部署トグル（トップバー常設。ユーザー要望） ────── */
const deptToggle = (active = 'すべて') => {
  const items = ['すべて', '営業部', 'マーケ部', '経理部', 'データ分析', '総合'];
  return `<div class="seg" role="tablist" aria-label="部署で絞り込み">${items
    .map((t) => `<button role="tab" class="${t === active ? 'on' : ''}">${t}</button>`)
    .join('')}</div>`;
};

/* ── サイドバー（テーマトグルなし） ─────────────────── */
const NAV = [
  ['home', 'ホーム', 'top'],
  ['dash', 'ダッシュボード', 'dash'],
  ['chat', 'チャット', 'chat', '3'],
  ['bot', 'エージェント', 'agents'],
  ['doc', '成果物', 'deliv', '新着'],
  ['task', 'タスク', 'tasks'],
];
const WORK = [
  ['営業パイプライン', 'var(--sales)'],
  ['データ分析', 'var(--anl)'],
  ['SNS投稿', 'var(--mkt)'],
];
const ADMIN = [
  ['shield', 'ガバナンス', 'gov', '1'],
  ['gear', '設定', 'settings'],
];

function sidebar(active) {
  const item = ([icon, label, key, badge]) => {
    const on = key === active;
    return `<div style="display:flex;align-items:center;gap:10px;height:34px;padding:0 10px;border-radius:8px;
      ${on ? 'background:var(--brand-soft);color:var(--brand);font-weight:700' : 'color:var(--ink2);font-weight:500'}">
      ${I[icon]}<span style="flex:1">${label}</span>
      ${badge ? `<span class="chip" style="background:${on ? '#fff' : 'var(--bg)'};color:var(--ink3);padding:1px 8px">${badge}</span>` : ''}
    </div>`;
  };
  return `<aside style="width:248px;flex:none;background:var(--surface);border-right:1px solid var(--line);
      display:flex;flex-direction:column;padding:14px 12px 12px">
    <div style="display:flex;align-items:center;gap:9px;padding:2px 8px 14px">
      <span style="width:26px;height:26px;border-radius:7px;background:var(--brand);display:flex;align-items:center;justify-content:center;box-shadow:var(--sh-sm)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M4 6h16M4 12h11M4 18h7"></path></svg>
      </span>
      <span style="font-size:15.5px;font-weight:800;letter-spacing:-.02em">FLOW</span>
    </div>
    <div style="display:flex;align-items:center;gap:9px;border:1px solid var(--line);border-radius:9px;padding:8px 10px;background:#fff;box-shadow:var(--sh-sm)">
      <span class="avatar" style="width:22px;height:22px;background:var(--ink);color:#fff;font-size:10px;font-weight:800">株</span>
      <span style="min-width:0;flex:1">
        <span style="display:block;font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">株式会社フェイズラ</span>
        <span style="display:block;font-size:10.5px;color:var(--ink3)">STARTER プラン</span>
      </span>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--ink4)" stroke-width="2.4" stroke-linecap="round"><path d="m7 9 5-5 5 5M7 15l5 5 5-5"></path></svg>
    </div>
    <nav style="display:flex;flex-direction:column;gap:2px;margin-top:14px">
      ${NAV.map(item).join('')}
      <div class="lbl" style="margin:14px 10px 5px">業務ページ</div>
      ${WORK.map(
        ([label, c]) => `<div style="display:flex;align-items:center;gap:10px;height:32px;padding:0 10px;border-radius:8px;color:var(--ink2)">
          ${deptDot(c)}<span>${label}</span></div>`,
      ).join('')}
      <div class="lbl" style="margin:14px 10px 5px">管理</div>
      ${ADMIN.map(item).join('')}
    </nav>
    <div style="margin-top:auto">
      <div style="border:1px solid var(--line);border-radius:10px;padding:11px 12px;background:#fff">
        <div style="display:flex;justify-content:space-between;font-size:11.5px;font-weight:700">
          <span style="color:var(--ink2)">今月の AI 呼び出し</span><span class="num">62 / 100</span>
        </div>
        <div style="height:5px;border-radius:99px;background:var(--bg);margin-top:7px;overflow:hidden">
          <div style="width:62%;height:100%;border-radius:99px;background:var(--brand)"></div>
        </div>
        <div style="font-size:10.5px;color:var(--ink3);margin-top:6px">9月1日にリセット</div>
      </div>
      <div style="display:flex;align-items:center;gap:9px;padding:10px 8px 0">
        <span class="avatar" style="width:26px;height:26px;background:var(--bg);border:1px solid var(--line);font-size:11px;font-weight:800;color:var(--ink2)">濱</span>
        <span style="flex:1;min-width:0">
          <span style="display:block;font-size:12px;font-weight:700">濱田 大和</span>
          <span style="display:block;font-size:10.5px;color:var(--ink3)">OWNER</span>
        </span>
      </div>
    </div>
  </aside>`;
}

/* ── トップバー（部署トグル常設・テーマトグルなし） ── */
function topbar({ toggle = 'すべて', cta = '' } = {}) {
  return `<header style="height:56px;flex:none;background:var(--surface);border-bottom:1px solid var(--line);
      display:flex;align-items:center;gap:14px;padding:0 20px">
    <div style="display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--line);
        border-radius:8px;padding:6px 11px;width:280px;color:var(--ink4)">
      ${I.search}<span style="font-size:12.5px">会話・成果物・エージェントを検索</span>
      <span style="margin-left:auto;font-size:10.5px;font-weight:700;border:1px solid var(--line);border-radius:5px;padding:0 5px;background:#fff">⌘K</span>
    </div>
    ${deptToggle(toggle)}
    <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
      <span class="chip" style="background:var(--ok-soft);color:var(--ok)">
        <span style="width:6px;height:6px;border-radius:99px;background:var(--ok)"></span>n8n 稼働中</span>
      ${cta}
    </div>
  </header>`;
}

/* ── デスクトップ枠 ─────────────────────────────────── */
const page = (active, content, opt = {}) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=Noto+Sans+JP:wght@400;500;700;800&display=swap">
  <style>${CSS}</style>
</helmet>
<div style="width:1440px;height:900px;display:flex;background:var(--bg);overflow:hidden">
  ${sidebar(active)}
  <div style="flex:1;min-width:0;display:flex;flex-direction:column">
    ${opt.noTopbar ? '' : topbar(opt)}
    ${content}
  </div>
</div>
</x-dc>
</body>
</html>`;

/* ══ 各ボード ═══════════════════════════════════════ */
const boards = {};

/* ── KPIカード部品 ── */
const kpi = (label, big, unit, sub, subColor = 'var(--ink3)') => `
  <div class="card" style="padding:16px 18px;flex:1;min-width:0">
    <div style="font-size:12px;font-weight:600;color:var(--ink3)">${label}</div>
    <div style="display:flex;align-items:baseline;gap:4px;margin-top:6px">
      <span class="num" style="font-size:28px;font-weight:800;letter-spacing:-.02em">${big}</span>
      <span style="font-size:13px;font-weight:600;color:var(--ink3)">${unit}</span>
    </div>
    <div style="font-size:11.5px;margin-top:4px;color:${subColor};font-weight:600">${sub}</div>
  </div>`;

const barChart = (h = 120) => {
  const days = [['火', 52], ['水', 71], ['木', 38], ['金', 86], ['土', 64], ['日', 76], ['月', 94]];
  return `<div style="display:flex;align-items:flex-end;gap:14px;height:${h}px">
    ${days
      .map(
        ([d, v], i) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px">
        <span class="num" style="font-size:10.5px;color:var(--ink3);font-weight:600">${v}</span>
        <div style="width:100%;max-width:34px;height:${Math.round((v / 94) * (h - 40))}px;border-radius:6px 6px 3px 3px;
          background:${i === 6 ? 'var(--brand)' : '#c9c5ff'}"></div>
        <span style="font-size:10.5px;color:var(--ink3)">${d}</span></div>`,
      )
      .join('')}
  </div>`;
};

const deptBars = () => {
  const rows = [['営業部', 'var(--sales)', '3h 40m', 100], ['マーケ部', 'var(--mkt)', '2h 05m', 57], ['データ分析', 'var(--anl)', '1h 30m', 41], ['経理部', 'var(--acct)', '1h 05m', 30]];
  return rows
    .map(
      ([n, c, t, w]) => `<div style="display:flex;align-items:center;gap:10px;font-size:12px">
      <span style="width:74px;color:var(--ink2);flex:none">${n}</span>
      <div style="flex:1;height:8px;border-radius:99px;background:var(--bg);overflow:hidden">
        <div style="width:${w}%;height:100%;border-radius:99px;background:${c}"></div></div>
      <span class="num" style="width:52px;text-align:right;font-weight:700">${t}</span></div>`,
    )
    .join('');
};

/* ── TOP（最小） ── */
const entry = (icon, iconBg, iconColor, title, desc, foot) => `
  <div class="card" style="padding:20px 22px;display:flex;flex-direction:column;gap:10px;box-shadow:var(--sh-md);cursor:pointer">
    <div style="display:flex;align-items:center;gap:12px">
      <span style="width:38px;height:38px;border-radius:10px;background:${iconBg};color:${iconColor};display:flex;align-items:center;justify-content:center">${icon}</span>
      <span style="font-size:16.5px;font-weight:800;letter-spacing:-.01em">${title}</span>
      <span style="margin-left:auto;color:var(--ink4)">${I.arrow}</span>
    </div>
    <div style="font-size:13px;color:var(--ink2)">${desc}</div>
    <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink3)">${foot}</div>
  </div>`;

boards['Top'] = page(
  'top',
  `<main style="flex:1;overflow:hidden;display:flex;flex-direction:column;align-items:center;padding:64px 40px 0">
    <div style="width:760px">
      <div style="height:3px;border-radius:99px;background:var(--grad);width:64px;margin-bottom:26px"></div>
      <h1 style="margin:0;font-size:30px;font-weight:800;letter-spacing:-.02em">おはようございます、濱田さん。</h1>
      <p style="margin:8px 0 0;color:var(--ink2);font-size:14.5px">今日やることを一行で伝えてください。担当の部署AIに振り分けます。</p>
      <div class="card" style="margin-top:24px;display:flex;align-items:center;gap:12px;padding:10px 10px 10px 18px;box-shadow:var(--sh-md)">
        <span style="color:var(--ink4)">${I.spark}</span>
        <span style="flex:1;color:var(--ink4);font-size:14.5px">今日は何をしますか？</span>
        <button class="btn btn-p">送信 <span style="font-size:11px;opacity:.75">⏎</span></button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:26px">
        ${entry(I.doc, 'var(--brand-soft)', 'var(--brand)', '提案書をつくる', '商談の履歴と手元の資料から、営業部AIが下書きを起こします。', `<img src="char-sales.png" alt="" style="width:20px;height:20px;border-radius:99px;object-fit:cover">セールスくん が担当`)}
        ${entry(I.dash, 'var(--info-soft)', 'var(--info)', '数字を見る', '削減できた時間と、部署ごとの内訳。押すとこの場で開きます。', `<img src="char-analytics.png" alt="" style="width:20px;height:20px;border-radius:99px;object-fit:cover">アナリーゼ が担当`)}
        ${entry(I.check, 'var(--warn-soft)', 'var(--warn)', '承認する <span class="chip" style="background:var(--warn-soft);color:var(--warn);margin-left:2px">1件</span>', 'あなたの確認を待っているもの。承認するまで外部には出ません。', `${I.clock} Instagram 投稿 3本の下書き`)}
        ${entry(I.bot, 'var(--ok-soft)', 'var(--ok)', 'エージェントを動かす', '保存済みの手順を、ひと押しで実行します。', `${I.task} 5件を保存済み`)}
      </div>
      <p style="text-align:center;color:var(--ink3);font-size:12px;margin-top:26px">
        もっと細かく見るときは、左のメニューから。ここには「いま決めること」だけを置いています。</p>
    </div>
  </main>`,
  { toggle: 'すべて' },
);

/* ── TOP（数字を見る展開） ── */
boards['TopExpanded'] = page(
  'top',
  `<main style="flex:1;overflow:hidden;display:flex;flex-direction:column;align-items:center;padding:34px 40px 0">
    <div style="width:900px">
      <div style="display:flex;align-items:center;gap:12px">
        <h1 style="margin:0;font-size:21px;font-weight:800;letter-spacing:-.02em">おはようございます、濱田さん。</h1>
        <div class="card" style="flex:1;display:flex;align-items:center;gap:10px;padding:7px 8px 7px 14px;margin-left:8px">
          <span style="flex:1;color:var(--ink4);font-size:13px">今日は何をしますか？</span>
          <button class="btn btn-p" style="padding:5px 12px;font-size:12px">送信 ⏎</button>
        </div>
      </div>
      <div class="card" style="margin-top:18px;padding:22px 24px;box-shadow:var(--sh-lg)">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="width:30px;height:30px;border-radius:8px;background:var(--info-soft);color:var(--info);display:flex;align-items:center;justify-content:center">${I.dash}</span>
          <span style="font-size:17px;font-weight:800">数字を見る</span>
          <span style="font-size:12px;color:var(--ink3)">8月24日（月）時点</span>
          <a style="margin-left:auto;font-size:13px;font-weight:700">すべての指標を見る →</a>
        </div>
        <div style="display:flex;gap:14px;margin-top:16px">
          ${kpi('今日', '94', '分', '前日比 +18分', 'var(--ok)')}
          ${kpi('直近7日', '8:20', '時間', 'タスク 23件から算出')}
          ${kpi('累計', '41', '時間', '6月10日から')}
          ${kpi('1日の目標', '78', '%', '94 / 120分')}
        </div>
        <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:14px;margin-top:14px">
          <div class="card" style="padding:16px 18px;box-shadow:none">
            <div style="font-size:12.5px;font-weight:700;margin-bottom:12px">日ごとの削減時間 <span style="color:var(--ink3);font-weight:600">分</span></div>
            ${barChart(140)}
          </div>
          <div class="card" style="padding:16px 18px;box-shadow:none;display:flex;flex-direction:column;gap:11px">
            <div style="font-size:12.5px;font-weight:700">部署別の貢献</div>
            ${deptBars()}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:12px;margin-top:16px">
        ${['提案書をつくる', '承認する <span class="chip" style="background:var(--warn-soft);color:var(--warn)">1件</span>', 'エージェントを動かす']
          .map(
            (t) => `<div class="card" style="flex:1;padding:12px 16px;display:flex;align-items:center;gap:8px;font-weight:700;font-size:13.5px;color:var(--ink2)">${t}<span style="margin-left:auto;color:var(--ink4)">${I.arrow}</span></div>`,
          )
          .join('')}
      </div>
    </div>
  </main>`,
  { toggle: 'すべて' },
);

/* ── ダッシュボード（詳細） ── */
const statusChip = (kind, text) => {
  const map = { run: ['var(--info-soft)', 'var(--info)'], wait: ['var(--warn-soft)', 'var(--warn)'], done: ['var(--ok-soft)', 'var(--ok)'] };
  const [bg, c] = map[kind];
  return `<span class="chip" style="background:${bg};color:${c}">${text}</span>`;
};

boards['Main'] = page(
  'dash',
  `<main style="flex:1;overflow:hidden;padding:22px 24px;display:flex;flex-direction:column;gap:14px">
    <div style="display:flex;align-items:center">
      <div>
        <h1 style="margin:0;font-size:20px;font-weight:800;letter-spacing:-.02em">おはようございます、濱田さん。</h1>
        <p style="margin:3px 0 0;font-size:12.5px;color:var(--ink2)">2026年8月24日（月） · 進行中のタスクが <b>1件</b>、承認待ちが <b>1件</b> あります。</p>
      </div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
        <div class="seg"><button class="on">今日</button><button>今週</button><button>今月</button></div>
        <button class="btn btn-p">${I.plus} 新しい指示</button>
      </div>
    </div>
    <div style="display:flex;gap:14px">
      ${kpi('今日の削減時間', '94', '分', '前日比 +18分', 'var(--ok)')}
      ${kpi('直近7日の削減時間', '8:20', '時間', 'タスク 23件から算出')}
      ${kpi('累計の削減時間', '41', '時間', '2026年6月10日から')}
      ${kpi('1日の目標（業務の25%）', '78', '%', '94 / 120分')}
    </div>
    <div style="display:grid;grid-template-columns:1.5fr 1fr;gap:14px">
      <div class="card" style="padding:16px 18px">
        <div style="font-size:12.5px;font-weight:700;margin-bottom:10px">日ごとの削減時間 <span style="color:var(--ink3);font-weight:600">分</span></div>
        ${barChart(118)}
      </div>
      <div class="card" style="padding:16px 18px;display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12.5px;font-weight:700">部署別の貢献</div>
        ${deptBars()}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1.5fr 1fr;gap:14px;flex:1;min-height:0">
      <div class="card" style="padding:0;overflow:hidden">
        <div style="display:flex;align-items:center;padding:13px 18px;border-bottom:1px solid var(--line)">
          <span style="font-size:12.5px;font-weight:700">進行中・直近のタスク</span>
          <a style="margin-left:auto;font-size:12px;font-weight:700">すべて見る →</a>
        </div>
        <div style="display:grid;grid-template-columns:1fr 84px 84px 104px 62px;padding:8px 18px;border-bottom:1px solid var(--line);background:var(--bg)" class="th">
          <span>タスク</span><span>部署</span><span>状態</span><span>実行経路</span><span style="text-align:right">経過</span>
        </div>
        ${[
          ['株式会社ミナト向け 提案書ドラフト', deptChip('営業部', '#4f46e5'), statusChip('run', 'RUNNING'), 'n8n webhook', '00:42'],
          ['9月のInstagram投稿 3本', deptChip('マーケ部', '#9333ea'), statusChip('wait', '承認待ち'), 'n8n webhook', '12分前'],
          ['7月の受注を部署別に集計', deptChip('データ分析', '#0d9488'), statusChip('done', 'DONE'), 'AI Engine', '1時間前'],
          ['8月前半の経費を仕訳区分ごとに集計', deptChip('経理部', '#0284c7'), statusChip('done', 'DONE'), 'AI Engine', '3時間前'],
        ]
          .map(
            (r) => `<div style="display:grid;grid-template-columns:1fr 84px 84px 104px 62px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--line);font-size:12.5px">
            <span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:10px">${r[0]}</span>
            <span>${r[1]}</span><span>${r[2]}</span>
            <span style="color:var(--ink3);font-size:11.5px">${r[3]}</span>
            <span class="num" style="text-align:right;color:var(--ink3)">${r[4]}</span></div>`,
          )
          .join('')}
      </div>
      <div style="display:flex;flex-direction:column;gap:14px;min-height:0">
        <div class="card" style="padding:15px 18px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="width:26px;height:26px;border-radius:8px;background:var(--warn-soft);color:var(--warn);display:flex;align-items:center;justify-content:center">${I.clock}</span>
            <span style="font-size:12.5px;font-weight:700">SNS投稿は自動で公開しません</span>
          </div>
          <p style="margin:9px 0 12px;font-size:12px;color:var(--ink2)">Instagram 3本の下書きが揃いました。内容を確認して承認すると、投稿予約まで進みます。</p>
          <div style="display:flex;gap:8px">
            <button class="btn btn-p" style="padding:6px 13px;font-size:12.5px">内容を確認</button>
            <button class="btn btn-s" style="padding:6px 13px;font-size:12.5px">あとで</button>
          </div>
        </div>
        <div class="card" style="padding:13px 18px;flex:1">
          <div style="display:flex;align-items:center;margin-bottom:8px">
            <span style="font-size:12.5px;font-weight:700">エージェント</span>
            <a style="margin-left:auto;font-size:12px;font-weight:700">管理</a>
          </div>
          ${[
            ['char-sales.png', 'セールスくん', '営業部 · 今週 12件', statusChip('done', '稼働中')],
            ['char-marketing.png', 'バズちゃん', 'マーケ部 · 今週 8件', statusChip('wait', '混雑')],
            ['char-accounting.png', 'カルクさん', '経理部 · 今週 5件', statusChip('done', '稼働中')],
            ['char-analytics.png', 'アナリーゼ', 'データ分析 · 今週 3件', `<span class="chip" style="background:var(--bg);color:var(--ink3)">停止中</span>`],
          ]
            .map(
              ([img, n, s, chip]) => `<div style="display:flex;align-items:center;gap:9px;padding:6px 0;font-size:12px">
              <img src="${img}" alt="" style="width:24px;height:24px;border-radius:99px;object-fit:cover">
              <span style="flex:1;min-width:0"><b>${n}</b> <span style="color:var(--ink3)">${s}</span></span>${chip}</div>`,
            )
            .join('')}
        </div>
      </div>
    </div>
  </main>`,
  { toggle: 'すべて', cta: '' },
);

/* ── チャット ── */
boards['Chat'] = page(
  'chat',
  `<div style="flex:1;display:flex;min-height:0">
    <div style="width:250px;flex:none;border-right:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;padding:12px">
      <button class="btn btn-p" style="justify-content:center">${I.plus} 新しい会話</button>
      <div style="display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;margin-top:10px;color:var(--ink4);font-size:12px">${I.search} 会話を検索</div>
      <div class="lbl" style="margin:14px 4px 6px">今日</div>
      ${[
        ['ミナト向け提案書', '提案書のドラフトを作成しました…', true],
        ['7月の受注集計', '営業部が全体の62%を占め…', false],
        ['9月のSNS投稿案', '3本の下書きが揃いました', false],
      ]
        .map(
          ([t, s, on]) => `<div style="padding:8px 10px;border-radius:8px;${on ? 'background:var(--brand-soft)' : ''}">
          <div style="font-size:12.5px;font-weight:700;${on ? 'color:var(--brand)' : ''}">${t}</div>
          <div style="font-size:11px;color:var(--ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s}</div></div>`,
        )
        .join('')}
      <div class="lbl" style="margin:14px 4px 6px">先週</div>
      ${['8月前半の経費仕訳', '就業規則の改定メモ']
        .map((t) => `<div style="padding:7px 10px;border-radius:8px;font-size:12.5px;font-weight:600;color:var(--ink2)">${t}</div>`)
        .join('')}
    </div>
    <div style="flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bg)">
      <div style="display:flex;align-items:center;gap:12px;background:var(--surface);border-bottom:1px solid var(--line);padding:10px 20px">
        <img src="char-sales.png" alt="" style="width:28px;height:28px;border-radius:99px;object-fit:cover">
        <div><div style="font-size:13.5px;font-weight:800">ミナト向け提案書</div>
        <div style="font-size:11px;color:var(--ink3)">セールスくん · 営業部 · Sonnet 4.6</div></div>
        <span class="chip" style="margin-left:auto;background:var(--ok-soft);color:var(--ok)">実行中 1件</span>
      </div>
      <div style="flex:1;overflow:hidden;padding:20px 26px;display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;gap:11px">
          <span class="avatar" style="width:28px;height:28px;background:var(--surface);border:1px solid var(--line);font-size:11px;font-weight:800;color:var(--ink2)">濱</span>
          <div style="max-width:620px">
            <div style="font-size:11.5px;font-weight:700;color:var(--ink3);margin-bottom:4px">濱田 大和</div>
            <div class="card" style="padding:11px 14px;font-size:13px">株式会社ミナト向けの提案書をつくりたい。先方は物流で、繁忙期の配車調整に困っている。
              <div style="display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:7px;padding:4px 9px;margin-top:8px;font-size:11.5px;color:var(--ink2)">${I.file} ミナト_ヒアリングメモ.pdf <span style="color:var(--ink4)">248 KB</span></div>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:11px">
          <img src="char-sales.png" alt="" style="width:28px;height:28px;border-radius:99px;object-fit:cover">
          <div style="max-width:680px;min-width:0">
            <div style="font-size:11.5px;font-weight:700;color:var(--ink3);margin-bottom:4px">セールスくん</div>
            <div class="card" style="padding:13px 16px;border-left:3px solid var(--brand)">
              <div class="lbl" style="color:var(--brand);margin-bottom:6px">これから行うこと</div>
              <div style="font-size:12.5px;color:var(--ink2)">アップロードされたヒアリングメモと、<b>ミナトの商談履歴3件</b>を参照して、物流業向けの提案書ドラフトを作成します。<b>金額は書きません</b>（単価表が未導入のため）。</div>
              <div style="display:flex;gap:8px;margin-top:11px">
                <button class="btn btn-p" style="padding:6px 13px;font-size:12.5px">この内容で実行</button>
                <button class="btn btn-s" style="padding:6px 13px;font-size:12.5px">参照先を変える</button>
              </div>
            </div>
            <div class="card" style="padding:13px 16px;margin-top:10px">
              <div style="font-size:13px">提案書のドラフトができました。先方の課題は「繁忙期（11〜12月）に配車担当1名へ問い合わせが集中し、1日あたり<b>約2.5時間</b>が電話対応に消えている」点<a style="font-size:10.5px;font-weight:800"> f1</a> です。これに対し、問い合わせの一次受けをAIエージェントに寄せる構成を提案しています。過去の類似案件では、同規模の商談が <b>3件</b> 受注に至っています<a style="font-size:10.5px;font-weight:800"> f2</a>。</div>
              <div style="border-top:1px dashed var(--line);margin-top:11px;padding-top:9px">
                <div class="lbl" style="margin-bottom:5px">この回答の根拠</div>
                <div style="display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--ink2)">
                  <span><b>f1</b> ミナト_ヒアリングメモ.pdf · 3ページ目 <a>開く</a></span>
                  <span><b>f2</b> 商談テーブル · stage=WON · 物流業 3件 <a>開く</a></span>
                </div>
              </div>
            </div>
            <div class="card" style="padding:11px 16px;margin-top:10px;display:flex;align-items:center;gap:12px;background:var(--brand-soft);border-color:var(--brand-line)">
              <span style="font-size:12px;color:var(--ink2)"><b>この流れをエージェントにしますか？</b> 「商談を参照して物流業向けの提案書を書く」を保存すると、次回から1クリックで実行できます。</span>
              <button class="btn btn-p" style="padding:5px 12px;font-size:12px;flex:none">作成する</button>
              <button class="btn btn-g" style="padding:5px 8px;font-size:12px;flex:none">あとで</button>
            </div>
          </div>
        </div>
      </div>
      <div style="padding:0 26px 16px">
        <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--ink3);margin-bottom:8px">
          成果物にする：
          ${['ドキュメント', 'スプレッドシート', 'スライド'].map((t) => `<button class="btn btn-s" style="padding:4px 10px;font-size:11.5px">${t}</button>`).join('')}
          <button class="btn btn-s" style="padding:4px 10px;font-size:11.5px;color:var(--ink4)">Slack · 要接続</button>
        </div>
        <div class="card" style="display:flex;align-items:center;gap:11px;padding:9px 10px 9px 16px;box-shadow:var(--sh-md)">
          <span style="flex:1;color:var(--ink4);font-size:13.5px">セールスくんに指示する…</span>
          <span style="font-size:11px;color:var(--ink4)">ファイル添付 / エージェント指定</span>
          <button class="btn btn-p" style="padding:7px 14px">${I.send} 送信</button>
        </div>
      </div>
    </div>
    <div style="width:250px;flex:none;border-left:1px solid var(--line);background:var(--surface);padding:14px;display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:center"><span style="font-size:12.5px;font-weight:800">実行の様子</span>
        <span class="chip" style="margin-left:auto;background:var(--info-soft);color:var(--info)">1件 実行中</span></div>
      <div class="card" style="padding:12px 14px;box-shadow:none">
        <div style="display:flex;align-items:center;font-size:12.5px;font-weight:700">提案書ドラフト<span class="num" style="margin-left:auto;font-size:11px;color:var(--ink3)">00:42</span></div>
        <div style="display:flex;flex-direction:column;gap:9px;margin-top:11px;font-size:11.5px">
          ${[
            ['done', '添付ファイルを読み込み', '2ファイル · 18チャンク索引'],
            ['done', '商談履歴を照合', 'Deal 3件 · stage=WON'],
            ['run', '本文を生成中…', 'n8n webhook · agent-cm7'],
          ]
            .map(
              ([st, t, s]) => `<div style="display:flex;gap:8px">
              <span style="width:16px;height:16px;border-radius:99px;flex:none;display:flex;align-items:center;justify-content:center;
                ${st === 'done' ? 'background:var(--ok-soft);color:var(--ok)' : 'background:var(--info-soft);color:var(--info)'}">${st === 'done' ? I.check : I.clock}</span>
              <span><b style="display:block;color:var(--ink)">${t}</b><span style="color:var(--ink3)">${s}</span></span></div>`,
            )
            .join('')}
        </div>
      </div>
    </div>
  </div>`,
  { toggle: '営業部' },
);

/* ── エージェント（一覧＋作成モーダル） ── */
boards['Agents'] = page(
  'agents',
  `<main style="flex:1;overflow:hidden;padding:22px 24px;position:relative">
    <div style="display:flex;align-items:center;gap:12px">
      <h1 style="margin:0;font-size:20px;font-weight:800">エージェント <span class="chip" style="background:var(--bg);color:var(--ink3)">5件</span></h1>
      <div style="margin-left:auto;display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:8px;padding:6px 11px;background:#fff;color:var(--ink4);font-size:12.5px;width:220px">${I.search} 名前・指示で絞り込み</div>
      <button class="btn btn-p">${I.plus} エージェントを作る</button>
    </div>
    <div class="card" style="margin-top:16px;overflow:hidden">
      <div style="display:grid;grid-template-columns:1.6fr 96px 1fr 110px 76px 70px;padding:9px 18px;border-bottom:1px solid var(--line);background:var(--bg)" class="th">
        <span>エージェント</span><span>部署</span><span>手順（steps）</span><span>n8n 連携</span><span>最終実行</span><span></span>
      </div>
      ${[
        ['物流業向け 提案書ドラフト', '商談履歴と資料を参照し、金額なしの提案書を作る', deptChip('営業部', '#4f46e5'), 'fetch_deals → create_google_doc', statusChip('done', 'ACTIVE'), '10:42'],
        ['月次の受注サマリ', '受注済み商談を部署別に集計して所見を書く', deptChip('データ分析', '#0d9488'), 'create_google_sheet', statusChip('done', 'ACTIVE'), '8/22'],
        ['週次 SNS 下書き', 'Instagram / X の投稿案を3本つくる（自動投稿はしない）', deptChip('マーケ部', '#9333ea'), 'notify_slack', `<span class="chip" style="background:var(--warn-soft);color:var(--warn)">要接続</span>`, '—'],
        ['8月前半の経費を仕訳区分ごとに集計', '貼り付けた明細を勘定科目ごとに整理する', deptChip('経理部', '#0284c7'), '手順なし（LLMのみ）', `<span class="chip" style="background:var(--bg);color:var(--ink3)">AI Engine</span>`, '8/21'],
        ['問い合わせメールの下書き', '受信内容から返信文を起こす（送信はしない）', deptChip('総合', '#475569'), 'draft_email', statusChip('done', 'ACTIVE'), '8/20'],
      ]
        .map(
          (r) => `<div style="display:grid;grid-template-columns:1.6fr 96px 1fr 110px 76px 70px;align-items:center;padding:11px 18px;border-bottom:1px solid var(--line);font-size:12.5px">
          <span style="min-width:0;padding-right:12px"><b style="display:block">${r[0]}</b><span style="color:var(--ink3);font-size:11.5px">${r[1]}</span></span>
          <span>${r[2]}</span>
          <span style="font-family:ui-monospace,monospace;font-size:11px;color:var(--ink2)">${r[3]}</span>
          <span>${r[4]}</span><span class="num" style="color:var(--ink3)">${r[5]}</span>
          <button class="btn btn-s" style="padding:4px 12px;font-size:11.5px;justify-self:end">実行</button></div>`,
        )
        .join('')}
    </div>
    <div style="position:absolute;inset:0;background:rgba(10,37,64,.4);display:flex;align-items:center;justify-content:center">
      <div class="card" style="width:560px;box-shadow:var(--sh-lg);border-radius:16px;overflow:hidden">
        <div style="height:3px;background:var(--grad)"></div>
        <div style="padding:20px 24px 22px">
          <div style="font-size:17px;font-weight:800">エージェントを作る</div>
          <div style="font-size:12px;color:var(--ink3);margin-top:2px">保存すると、同じ手順を1クリックで繰り返せます</div>
          <div style="display:grid;grid-template-columns:1fr 180px;gap:12px;margin-top:16px">
            <div><div class="lbl" style="margin-bottom:5px">名前</div>
              <div style="border:1px solid var(--line2);border-radius:8px;padding:8px 12px;font-size:13px;background:#fff">物流業向け 提案書ドラフト</div></div>
            <div><div class="lbl" style="margin-bottom:5px">担当部署</div>
              <div style="border:1px solid var(--line2);border-radius:8px;padding:8px 12px;font-size:13px;background:#fff;display:flex;align-items:center;gap:7px">${deptDot('var(--sales)')}営業部</div></div>
          </div>
          <div style="margin-top:12px"><div class="lbl" style="margin-bottom:5px">指示文</div>
            <div style="border:1px solid var(--line2);border-radius:8px;padding:10px 12px;font-size:12.5px;background:#fff;color:var(--ink2);line-height:1.6">物流業のお客様向けに提案書のドラフトを書いてください。過去の受注商談を参照し、繁忙期の人手不足に対する打ち手を中心に。金額は書かないこと（単価表が未導入のため）。</div></div>
          <div style="margin-top:12px">
            <div style="display:flex;align-items:center"><span class="lbl">実行する手順</span><span style="margin-left:auto;font-size:12px;font-weight:700;color:var(--brand)">+ 手順を追加</span></div>
            ${[
              ['1', 'fetch_deals', '商談を読む（副作用なし）'],
              ['2', 'create_google_doc', 'ドキュメントを作る'],
            ]
              .map(
                ([n, code, desc]) => `<div style="display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin-top:7px;font-size:12.5px">
                <span class="num" style="width:20px;height:20px;border-radius:6px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:var(--ink3)">${n}</span>
                <code style="font-family:ui-monospace,monospace;font-size:11.5px;background:var(--bg);border-radius:5px;padding:1px 7px">${code}</code>
                <span style="color:var(--ink2)">${desc}</span>
                <span class="chip" style="margin-left:auto;background:var(--ok-soft);color:var(--ok)">接続済み</span></div>`,
              )
              .join('')}
            <p style="font-size:11px;color:var(--ink3);margin:9px 0 0">手順に外部連携を含めると n8n の専用ワークフローが作られます。未接続の連携を含む手順は保存できますが、実行時に「要接続」で止まります。</p>
          </div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:14px;border-top:1px solid var(--line);padding-top:14px">
            <span style="width:34px;height:20px;border-radius:99px;background:var(--brand);position:relative;flex:none"><span style="position:absolute;right:2px;top:2px;width:16px;height:16px;border-radius:99px;background:#fff;box-shadow:var(--sh-sm)"></span></span>
            <span style="font-size:12.5px"><b>有効にする</b> <span style="color:var(--ink3)">毎週月曜 9:00 に自動実行</span></span>
            <span style="margin-left:auto;display:flex;gap:8px">
              <button class="btn btn-s">キャンセル</button>
              <button class="btn btn-p">保存する</button></span>
          </div>
          <p style="font-size:10.5px;color:var(--ink4);margin:10px 0 0">この定義はデータベースに保存されます。n8n が落ちていても実行できます。</p>
        </div>
      </div>
    </div>
  </main>`,
  { toggle: 'すべて' },
);

/* ── 成果物 ── */
const delivCard = (dept, deptColor, badge, title, desc, meta) => `
  <div class="card" style="padding:14px 16px;display:flex;flex-direction:column;gap:7px">
    <div style="display:flex;align-items:center;gap:7px">${deptChip(dept, deptColor)}${badge}</div>
    <div style="font-size:13.5px;font-weight:800">${title}</div>
    <div style="font-size:12px;color:var(--ink2)">${desc}</div>
    <div style="display:flex;align-items:center;gap:7px;font-size:11px;color:var(--ink3)">${meta}</div>
  </div>`;
const hi = `<span class="chip" style="background:var(--bad-soft);color:var(--bad)">高</span>`;
const mid = `<span class="chip" style="background:var(--warn-soft);color:var(--warn)">中</span>`;

boards['Deliverables'] = page(
  'deliv',
  `<main style="flex:1;overflow:hidden;padding:22px 24px">
    <div style="display:flex;align-items:center;gap:12px">
      <h1 style="margin:0;font-size:20px;font-weight:800">成果物 <span class="chip" style="background:var(--bg);color:var(--ink3)">38件</span></h1>
      <span style="font-size:12px;color:var(--ink3)">重要度の高い順にまとめて共有</span>
      <button class="btn btn-s" style="margin-left:auto">${I.spark} AIで重要度を再評価</button>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:14px">
      <div class="seg"><button class="on">すべて 38</button><button>提案書 11</button><button>レポート 9</button><button>SNS投稿 8</button><button>メール下書き 10</button></div>
      <span style="font-size:11.5px;color:var(--ink4)">カードをドラッグしてフォルダに入れられます</span>
    </div>
    <div style="margin-top:18px">
      <div style="display:flex;align-items:center;gap:9px"><span style="font-size:13px;font-weight:800">重要度 高</span>
        <span class="chip" style="background:var(--bad-soft);color:var(--bad)">3件</span>
        <span style="font-size:11px;color:var(--ink4)">AI が事業インパクトで判定 · バッジをクリックで手動変更</span></div>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px;margin-top:10px">
        ${delivCard('営業部', '#4f46e5', hi, '株式会社ミナト様 ご提案', '繁忙期の配車問い合わせをAIで一次受けする構成。金額は要お見積り。', `${I.file} Google ドキュメント · 今日 10:44`)}
        ${delivCard('データ分析', '#0d9488', hi, '7月 受注サマリ（部署別）', '営業部が全体の62%。前月比 +18%。マーケ部経由の商談が初めて2桁に。', `${I.file} スプレッドシート · 8/22`)}
        ${delivCard('経理部', '#0284c7', hi, '8月前半 経費の仕訳区分', '交際費が前月比 +12%。要確認の明細を4件マークしています。', `${I.file} スプレッドシート · 8/21`)}
      </div>
    </div>
    <div style="margin-top:18px">
      <div style="display:flex;align-items:center;gap:9px"><span style="font-size:13px;font-weight:800">重要度 中</span>
        <span class="chip" style="background:var(--warn-soft);color:var(--warn)">4件</span></div>
      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;margin-top:10px">
        ${delivCard('マーケ部', '#9333ea', `<span class="chip" style="background:var(--warn-soft);color:var(--warn)">承認待ち</span>`, '9月 Instagram 投稿 3本', '自動投稿はしません。承認後に予約されます。', '今日 09:12')}
        ${delivCard('総合', '#475569', mid, '問い合わせ返信 下書き', '送信はされません。確認してからコピーしてください。', '8/23')}
        ${delivCard('営業部', '#4f46e5', mid, '商談メモ 次アクション整理', '先週の5商談から、担当と期日つきで11件を抽出。', '8/22')}
        ${delivCard('データ分析', '#0d9488', mid, '部署別のAI利用コスト', 'Gemini 移行で今月の実費は $2.14 に収まる見込み。', '8/20')}
      </div>
    </div>
    <div style="margin-top:18px">
      <div style="display:flex;align-items:center;gap:9px"><span style="font-size:13px;font-weight:800">重要度 低</span>
        <span class="chip" style="background:var(--bg);color:var(--ink3)">31件</span>
        <a style="font-size:12px;font-weight:700;margin-left:auto">展開する</a></div>
      <div class="card" style="margin-top:10px;padding:6px 18px">
        ${[
          ['総合', '#475569', '社内向け 暑中見舞いの案内文', '8/19'],
          ['マーケ部', '#9333ea', '8月度 SNS 投稿の振り返りメモ', '8/18'],
          ['経理部', '#0284c7', '交通費精算のルール確認メモ', '8/15'],
        ]
          .map(
            ([d, c, t, dt]) => `<div style="display:flex;align-items:center;gap:11px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12.5px">
            ${deptChip(d, c)}<span style="flex:1;font-weight:600">${t}</span><span class="num" style="color:var(--ink3);font-size:11.5px">${dt}</span></div>`,
          )
          .join('')}
        <div style="padding:8px 0;font-size:11px;color:var(--ink4)">よく使う3件だけ出しています。残り28件は畳んでいます。</div>
      </div>
    </div>
  </main>`,
  { toggle: 'すべて' },
);

/* ── ガバナンス ── */
boards['Governance'] = page(
  'gov',
  `<main style="flex:1;overflow:hidden;padding:22px 24px">
    <div style="display:flex;align-items:center;gap:14px">
      <h1 style="margin:0;font-size:20px;font-weight:800">ガバナンス</h1>
      <div class="seg"><button class="on">AI ログ</button><button>リスクイベント <span class="chip" style="background:var(--bad-soft);color:var(--bad);padding:0 7px;margin-left:3px">1</span></button></div>
      <button class="btn btn-s" style="margin-left:auto">CSV 書き出し</button>
    </div>
    <div style="display:flex;gap:13px;margin-top:15px">
      ${kpi('今月の AI 呼び出し', '62', '/ 100', ' ')}
      ${kpi('PII 検出', '7', '件', '送信前に自動マスク済み', 'var(--ok)')}
      ${kpi('未対応リスク', '1', '件', '確認が必要です', 'var(--bad)')}
      ${kpi('応答時間（中央値）', '1,840', 'ms', '直近100件')}
      ${kpi('推定コスト（今月）', '$2.14', '', 'Gemini 分は $0 で計上')}
    </div>
    <div style="display:flex;align-items:center;gap:9px;margin-top:14px;font-size:12px;color:var(--ink2)">
      ${['部署: すべて', 'プロバイダ: すべて', 'リスク: 0.5 以上', '期間: 8/17 – 8/24']
        .map((t) => `<span class="chip" style="background:#fff;border:1px solid var(--line2);color:var(--ink2);padding:5px 12px">${t} ▾</span>`)
        .join('')}
      <a style="font-size:12px;font-weight:700">条件をクリア</a>
      <span class="num" style="margin-left:auto;color:var(--ink3);font-size:11.5px">1–7 / 62 件</span>
    </div>
    <div class="card" style="margin-top:10px;overflow:hidden">
      <div style="display:grid;grid-template-columns:118px 90px 118px 1fr 76px 60px 56px;padding:8px 18px;border-bottom:1px solid var(--line);background:var(--bg)" class="th">
        <span>日時</span><span>部署</span><span>モデル</span><span>入力（先頭）</span><span style="text-align:right">トークン</span><span style="text-align:right">応答</span><span style="text-align:right">リスク</span>
      </div>
      ${[
        ['08-24 10:42:19', deptChip('営業部', '#4f46e5'), 'sonnet-4.6', '株式会社ミナト 田中様の携帯 090-****-**** に折り返し…', '1,284', '2.1s', ['0.82', 'var(--bad)']],
        ['08-24 10:41:58', deptChip('営業部', '#4f46e5'), 'sonnet-4.6', '株式会社ミナト向けの提案書をつくりたい。先方は物流で…', '982', '1.8s', ['0.04', 'var(--ink3)']],
        ['08-24 09:58:02', deptChip('データ分析', '#0d9488'), 'gemini-flash', '7月の受注を部署別に集計して、前月比も出して', '2,410', '0.9s', ['0.02', 'var(--ink3)']],
        ['08-23 17:20:44', deptChip('経理部', '#0284c7'), 'gemini-flash-lite', '社員名簿（氏名・住所つき）を貼るので、交通費を…', '6,120', '1.2s', ['0.91', 'var(--bad)']],
        ['08-23 15:04:11', deptChip('マーケ部', '#9333ea'), 'gemini-flash', '9月のInstagram投稿を3本、秋の繁忙期を意識して', '1,706', '1.1s', ['0.06', 'var(--ink3)']],
        ['08-23 11:32:07', deptChip('総合', '#475569'), 'opus-4.7', 'エージェント定義の推論（/plan/agent）', '3,988', '4.6s', ['0.01', 'var(--ink3)']],
      ]
        .map(
          (r) => `<div style="display:grid;grid-template-columns:118px 90px 118px 1fr 76px 60px 56px;align-items:center;padding:9px 18px;border-bottom:1px solid var(--line);font-size:12px">
          <span class="num" style="color:var(--ink2)">${r[0]}</span><span>${r[1]}</span>
          <span style="font-family:ui-monospace,monospace;font-size:11px">${r[2]}</span>
          <span style="color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:12px">${r[3]}</span>
          <span class="num" style="text-align:right">${r[4]}</span><span class="num" style="text-align:right;color:var(--ink3)">${r[5]}</span>
          <span class="num" style="text-align:right;font-weight:800;color:${r[6][1]}">${r[6][0]}</span></div>`,
        )
        .join('')}
    </div>
    <div class="card" style="margin-top:13px;padding:14px 18px;border-left:3px solid var(--bad);display:flex;gap:12px;align-items:flex-start">
      <span style="width:28px;height:28px;border-radius:8px;background:var(--bad-soft);color:var(--bad);display:flex;align-items:center;justify-content:center;flex:none">${I.alert}</span>
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:8px"><b style="font-size:13px">個人情報の送信を検出</b><span class="num" style="font-size:11px;color:var(--ink3)">08-23 17:20</span></div>
        <p style="margin:4px 0 0;font-size:12px;color:var(--ink2)">経理部のチャットに氏名・住所を含む名簿が貼られました。<b>LLM への送信前にマスク済み</b>ですが、原文は監査ログに残っています。</p>
      </div>
      <button class="btn btn-p" style="padding:6px 13px;font-size:12px;flex:none">確認して対応済みにする</button>
      <button class="btn btn-s" style="padding:6px 13px;font-size:12px;flex:none">原文を見る</button>
    </div>
  </main>`,
  { toggle: 'すべて' },
);

/* ── スタイルタイル（Stripe風の基盤定義） ── */
const swatch = (name, varName, hex) => `
  <div style="display:flex;flex-direction:column;gap:6px">
    <div style="height:56px;border-radius:10px;background:${hex};border:1px solid var(--line)"></div>
    <div style="font-size:11.5px;font-weight:700">${name}</div>
    <div style="font-family:ui-monospace,monospace;font-size:10.5px;color:var(--ink3)">${varName} · ${hex}</div>
  </div>`;

boards['StyleTile'] = `<!doctype html>
<html>
<head><meta charset="utf-8"><script src="./support.js"></script></head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=Noto+Sans+JP:wght@400;500;700;800&display=swap">
  <style>${CSS}</style>
</helmet>
<div style="width:1440px;background:var(--bg);padding:44px 52px;box-sizing:border-box">
  <div style="height:3px;border-radius:99px;background:var(--grad);width:72px"></div>
  <h1 style="font-size:26px;font-weight:800;margin:16px 0 4px">FLOW Design System v3 — Stripe風モダンSaaS</h1>
  <p style="color:var(--ink2);margin:0 0 30px;font-size:14px">白基調＋鮮やかなブルーバイオレット。ソフトシャドウと丸み。<b>半透明ガラスは使わない</b>。ダークモードは廃止（ライトのみ）。</p>

  <div class="lbl" style="margin-bottom:10px">カラー</div>
  <div style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:14px">
    ${swatch('Ink / 見出し', '--ink', '#0a2540')}
    ${swatch('本文サブ', '--ink2', '#425466')}
    ${swatch('キャンバス', '--bg', '#f6f9fc')}
    ${swatch('ブランド', '--brand', '#635bff')}
    ${swatch('ブランド淡', '--brand-soft', '#f4f4ff')}
    ${swatch('罫線', '--line', '#e6ebf1')}
  </div>
  <div style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:14px;margin-top:12px">
    ${swatch('成功', '--ok', '#1a9c6b')}
    ${swatch('注意', '--warn', '#b25e09')}
    ${swatch('危険', '--bad', '#df1b41')}
    ${swatch('情報', '--info', '#0570de')}
    ${swatch('営業（データ色）', '--sales', '#4f46e5')}
    ${swatch('分析（データ色）', '--anl', '#0d9488')}
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:26px;margin-top:30px">
    <div>
      <div class="lbl" style="margin-bottom:10px">タイポグラフィ — Figtree + Noto Sans JP</div>
      <div class="card" style="padding:20px 22px">
        <div style="font-size:28px;font-weight:800;letter-spacing:-.02em">見出し 28 / 800</div>
        <div style="font-size:20px;font-weight:800;margin-top:6px">セクション 20 / 800</div>
        <div style="font-size:14px;margin-top:8px;color:var(--ink2)">本文 14 / 400 — 業務の文章はこの濃度。読み下しやすさを最優先。</div>
        <div class="lbl" style="margin-top:10px">ラベル 11 / 700 / 字間 .07EM</div>
        <div class="num" style="font-family:ui-monospace,monospace;font-size:13px;margin-top:8px">数字は等幅 1,284 / $2.14 / 00:42</div>
      </div>
      <div class="lbl" style="margin:18px 0 10px">ボタンとセグメント</div>
      <div class="card" style="padding:20px 22px;display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;gap:10px;align-items:center">
          <button class="btn btn-p">主アクション</button>
          <button class="btn btn-s">副アクション</button>
          <button class="btn btn-g">ゴースト</button>
          <button class="btn btn-p" style="background:var(--bad)">破壊的</button>
        </div>
        <div style="display:flex;gap:12px;align-items:center">
          ${deptToggle('営業部')}
        </div>
        <p style="font-size:11.5px;color:var(--ink3);margin:0">部署トグルはトップバーに常設。選択中は白い面＋影で持ち上げる（Stripe のセグメント方式）。</p>
      </div>
    </div>
    <div>
      <div class="lbl" style="margin-bottom:10px">面と影 — 3段だけ</div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="card" style="padding:14px 18px"><b style="font-size:13px">カード</b> <span style="font-size:12px;color:var(--ink3)">— 白 + 罫線 + sh-sm。表・数字はここに載せる</span></div>
        <div class="card" style="padding:14px 18px;box-shadow:var(--sh-md)"><b style="font-size:13px">浮いた面</b> <span style="font-size:12px;color:var(--ink3)">— 入口カード・入力バー。sh-md</span></div>
        <div class="card" style="padding:14px 18px;box-shadow:var(--sh-lg);border-radius:16px"><b style="font-size:13px">モーダル</b> <span style="font-size:12px;color:var(--ink3)">— sh-lg + 角丸16 + 上端にブランドグラデ3px</span></div>
      </div>
      <div class="lbl" style="margin:18px 0 10px">バッジ・チップ</div>
      <div class="card" style="padding:16px 18px;display:flex;gap:8px;flex-wrap:wrap">
        ${statusChip('done', 'DONE')}${statusChip('run', 'RUNNING')}${statusChip('wait', '承認待ち')}
        <span class="chip" style="background:var(--bad-soft);color:var(--bad)">リスク 0.82</span>
        ${deptChip('営業部', '#4f46e5')}${deptChip('マーケ部', '#9333ea')}${deptChip('経理部', '#0284c7')}
      </div>
      <div class="lbl" style="margin:18px 0 10px">禁則</div>
      <div class="card" style="padding:16px 18px;font-size:12.5px;color:var(--ink2);line-height:2">
        ・半透明ガラス／backdrop-filter は使わない（v2 で全廃）<br>
        ・グラデーションは「ブランドの3pxストリップ」だけ。面には塗らない<br>
        ・ダークモードなし。テーマトグルは置かない<br>
        ・青の塗り面積は小さく。主役は白とインク、青は導く色
      </div>
    </div>
  </div>
</div>
</x-dc>
</body>
</html>`;

/* ── 状態の設計（Stripe風に再スタイル） ── */
const stateCard = (title, inner) => `
  <div class="card" style="padding:18px 20px">
    <div class="lbl" style="margin-bottom:12px">${title}</div>${inner}
  </div>`;

boards['States'] = `<!doctype html>
<html>
<head><meta charset="utf-8"><script src="./support.js"></script></head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=Noto+Sans+JP:wght@400;500;700;800&display=swap">
  <style>${CSS}</style>
</helmet>
<div style="width:1440px;background:var(--bg);padding:40px 48px;box-sizing:border-box">
  <h1 style="font-size:22px;font-weight:800;margin:0">状態の設計 — 空・読み込み・失敗・未接続</h1>
  <p style="color:var(--ink2);font-size:13px;margin:6px 0 24px">成功時だけ整った画面は、法人利用では信用を落とす。<b>何が起きているか</b>と<b>次に何をすればいいか</b>を、必ず1文で書く。</p>
  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px">
    ${stateCard(
      'ログイン',
      `<div style="max-width:290px;margin:0 auto">
        <div class="card" style="padding:20px;border-radius:14px;box-shadow:var(--sh-md);overflow:hidden;position:relative">
          <div style="position:absolute;top:0;left:0;right:0;height:3px;background:var(--grad)"></div>
          <div style="font-size:15px;font-weight:800;margin-top:4px">おかえりなさい</div>
          <div style="font-size:11.5px;color:var(--ink3)">組織のアカウントでログインしてください。</div>
          <div class="lbl" style="margin:12px 0 4px">メールアドレス</div>
          <div style="border:1px solid var(--line2);border-radius:8px;height:34px;background:#fff"></div>
          <div class="lbl" style="margin:10px 0 4px">パスワード</div>
          <div style="border:1px solid var(--line2);border-radius:8px;height:34px;background:#fff"></div>
          <button class="btn btn-p" style="width:100%;justify-content:center;margin-top:14px">ログイン</button>
        </div>
        <p style="font-size:10.5px;color:var(--ink3);margin:8px 2px 0">デモ用の認証情報を入力欄にあらかじめ設定することはしません。</p>
      </div>`,
    )}
    ${stateCard(
      '空（まだ何もない）',
      `<div style="text-align:center;padding:10px 6px">
        <img src="char-general.png" alt="" style="width:56px;height:56px;border-radius:99px;object-fit:cover">
        <div style="font-size:13.5px;font-weight:800;margin-top:10px">まだ成果物はありません</div>
        <p style="font-size:12px;color:var(--ink2);margin:6px 0 12px">チャットで指示すると、提案書・集計表・投稿案などがここに貯まっていきます。</p>
        <button class="btn btn-p" style="margin:0 auto">最初の指示を出す</button>
        <p style="font-size:10.5px;color:var(--ink4);margin:12px 0 0">空状態でだけキャラを大きく使う。「何もない」を和らげてよい唯一の場所。</p>
      </div>`,
    )}
    ${stateCard(
      '読み込み（骨組みを見せる）',
      `<div style="display:flex;flex-direction:column;gap:9px">
        ${[86, 100, 62, 74].map((w) => `<div style="height:13px;border-radius:6px;background:var(--line);width:${w}%"></div>`).join('')}
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:var(--ink3)">${I.clock} 商談データを読み込んでいます…</div>
        <p style="font-size:10.5px;color:var(--ink4);margin:4px 0 0">領域に aria-busy、進行文に aria-live="polite"。</p>
      </div>`,
    )}
    ${stateCard(
      '失敗（原因と次の一手）',
      `<div style="display:flex;gap:10px">
        <span style="width:28px;height:28px;border-radius:8px;background:var(--bad-soft);color:var(--bad);display:flex;align-items:center;justify-content:center;flex:none">${I.alert}</span>
        <div>
          <b style="font-size:13px">タスクを完了できませんでした</b>
          <p style="font-size:12px;color:var(--ink2);margin:5px 0 8px">Google ドキュメントの作成でエラーが返りました。接続は生きているので、<b>もう一度実行すると成功する可能性があります</b>。生成された本文は下書きとして残しています。</p>
          <code style="display:block;font-family:ui-monospace,monospace;font-size:10.5px;background:var(--bg);border-radius:7px;padding:7px 10px;color:var(--ink2)">task cmz7k2p900041 · step create_google_doc<br>NODE_FAILED · 503 upstream</code>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn btn-p" style="padding:6px 12px;font-size:12px">もう一度実行</button>
            <button class="btn btn-s" style="padding:6px 12px;font-size:12px">下書きを見る</button>
          </div>
        </div>
      </div>`,
    )}
    ${stateCard(
      '未接続（NEEDS_AUTH）',
      `<b style="font-size:13px">Slack がまだ接続されていません</b>
      <p style="font-size:12px;color:var(--ink2);margin:6px 0 10px">この手順は Slack への投稿を含みます。管理者が一度だけ接続すると、以降このエージェントは自動で実行できます。</p>
      <div style="display:flex;flex-direction:column;gap:6px;font-size:12px">
        <div style="display:flex;justify-content:space-between;border:1px solid var(--line);border-radius:8px;padding:7px 12px"><span>Google ドキュメント</span>${statusChip('done', '接続済み')}</div>
        <div style="display:flex;justify-content:space-between;border:1px solid var(--line);border-radius:8px;padding:7px 12px"><span>Slack</span><span class="chip" style="background:var(--warn-soft);color:var(--warn)">未接続</span></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:11px">
        <button class="btn btn-p" style="padding:6px 12px;font-size:12px">接続する</button>
        <button class="btn btn-s" style="padding:6px 12px;font-size:12px">この手順を外して実行</button>
      </div>`,
    )}
    ${stateCard(
      '根拠なし（将来の検証ゲート）',
      `<b style="font-size:13px">データに根拠がない数値</b>
      <p style="font-size:12px;color:var(--ink2);margin:6px 0 10px">出力の一部が、参照したデータのどこにも見つかりませんでした。<b>その箇所だけ伏せて</b>お見せしています。</p>
      <div style="border:1px dashed var(--line2);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--ink2)">導入により、月あたり <span class="chip" style="background:var(--warn-soft);color:var(--warn)">根拠なし</span> のコスト削減が見込まれます。</div>
      <p style="font-size:10.5px;color:var(--ink4);margin:9px 0 0">単価表が未導入のため金額は算出できません。黙って通すことも、黙って捨てることもしない。実行カーネル（P2）までは描画のみ。</p>
      <button class="btn btn-s" style="padding:6px 12px;font-size:12px;margin-top:9px">参照データを追加する</button>`,
    )}
  </div>
  <div style="margin-top:16px">
    ${stateCard(
      '通知（右下・4秒で消える）',
      `<div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="card" style="box-shadow:var(--sh-md);padding:10px 14px;display:flex;align-items:center;gap:9px;font-size:12.5px">
          <span style="color:var(--ok)">${I.check}</span> ミナト様 ご提案.docx を作成しました <a style="font-weight:700">開く</a></div>
        <div class="card" style="box-shadow:var(--sh-md);padding:10px 14px;display:flex;align-items:center;gap:9px;font-size:12.5px">
          <span style="color:var(--bad)">${I.alert}</span> タスクが失敗しました <a style="font-weight:700">詳細</a></div>
        <div class="card" style="box-shadow:var(--sh-md);padding:10px 14px;display:flex;align-items:center;gap:9px;font-size:12.5px">
          <span style="color:var(--warn)">${I.clock}</span> 今月の呼び出しが上限の80%に達しました</div>
      </div>`,
    )}
  </div>
</div>
</x-dc>
</body>
</html>`;

/* ── モバイル3枚 ── */
const mobileShell = (inner, nav = 'ホーム') => `<!doctype html>
<html>
<head><meta charset="utf-8"><script src="./support.js"></script></head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=Noto+Sans+JP:wght@400;500;700;800&display=swap">
  <style>${CSS}</style>
</helmet>
<div style="width:390px;height:844px;background:var(--bg);display:flex;flex-direction:column;overflow:hidden">
  ${inner}
  <nav style="flex:none;background:var(--surface);border-top:1px solid var(--line);display:flex;padding:8px 6px 20px">
    ${[['home', 'ホーム'], ['chat', 'チャット'], ['doc', '成果物'], ['task', 'メニュー']]
      .map(
        ([icon, label]) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:10px;
        ${label === nav ? 'color:var(--brand);font-weight:800' : 'color:var(--ink3);font-weight:600'}">${I[icon]}${label}</div>`,
      )
      .join('')}
  </nav>
</div>
</x-dc>
</body>
</html>`;

boards['MobileHome'] = mobileShell(
  `<div style="flex:1;overflow:hidden;padding:22px 18px 0">
    <div style="display:flex;align-items:center">
      <span style="font-size:15px;font-weight:800">FLOW</span>
      <span class="avatar" style="margin-left:auto;width:28px;height:28px;background:var(--surface);border:1px solid var(--line);font-size:11px;font-weight:800;color:var(--ink2)">濱</span>
    </div>
    <div style="height:3px;border-radius:99px;background:var(--grad);width:48px;margin:22px 0 14px"></div>
    <h1 style="margin:0;font-size:22px;font-weight:800;line-height:1.3">おはようございます、<br>濱田さん。</h1>
    <p style="margin:8px 0 0;font-size:12.5px;color:var(--ink2)">今日やることを一行で伝えてください。担当の部署AIに振り分けます。</p>
    <div class="card" style="margin-top:16px;display:flex;align-items:center;gap:9px;padding:9px 9px 9px 14px;box-shadow:var(--sh-md)">
      <span style="flex:1;color:var(--ink4);font-size:13px">今日は何をしますか？</span>
      <button class="btn btn-p" style="padding:7px 11px">${I.send}</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-top:16px">
      ${[
        ['提案書を<br>つくる', 'char-sales.png', 'セールスくん', ''],
        ['数字を<br>見る', 'char-analytics.png', 'アナリーゼ', ''],
        ['承認する', '', 'Instagram 3本', `<span class="chip" style="background:var(--warn-soft);color:var(--warn)">1件</span>`],
        ['エージェントを<br>動かす', '', '5件を保存済み', ''],
      ]
        .map(
          ([t, img, sub, badge]) => `<div class="card" style="padding:14px;min-height:106px;display:flex;flex-direction:column">
          <div style="display:flex;align-items:flex-start">${badge || ''}<span style="margin-left:auto;color:var(--ink4)">${I.arrow}</span></div>
          <div style="font-size:14.5px;font-weight:800;line-height:1.35;margin-top:auto">${t}</div>
          <div style="display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--ink3);margin-top:5px">
            ${img ? `<img src="${img}" alt="" style="width:16px;height:16px;border-radius:99px;object-fit:cover">` : ''}${sub}</div></div>`,
        )
        .join('')}
    </div>
    <p style="text-align:center;font-size:10.5px;color:var(--ink3);margin-top:16px">細かい設定と監査はパソコンで。ここには「いま決めること」だけを置いています。</p>
  </div>`,
  'ホーム',
);

boards['MobileChat'] = mobileShell(
  `<div style="flex:none;background:var(--surface);border-bottom:1px solid var(--line);padding:12px 14px">
    <div style="display:flex;align-items:center;gap:9px">
      <img src="char-sales.png" alt="" style="width:26px;height:26px;border-radius:99px;object-fit:cover">
      <div><div style="font-size:13px;font-weight:800">ミナト向け提案書</div>
      <div style="font-size:10px;color:var(--ink3)">セールスくん · 営業部</div></div>
    </div>
  </div>
  <div style="flex:1;overflow:hidden;padding:14px;display:flex;flex-direction:column;gap:11px">
    <div class="card" style="padding:10px 13px;font-size:12px;margin-left:34px">株式会社ミナト向けの提案書をつくりたい。先方は物流で、繁忙期の配車調整に困っている。</div>
    <div class="card" style="padding:11px 13px;border-left:3px solid var(--brand);margin-right:24px">
      <div class="lbl" style="color:var(--brand);margin-bottom:4px">これから行うこと</div>
      <div style="font-size:11.5px;color:var(--ink2)">ヒアリングメモと<b>商談履歴3件</b>を参照して提案書ドラフトを作ります。<b>金額は書きません</b>。</div>
      <div style="display:flex;gap:7px;margin-top:9px">
        <button class="btn btn-p" style="padding:5px 11px;font-size:11.5px">実行する</button>
        <button class="btn btn-s" style="padding:5px 11px;font-size:11.5px">変更</button>
      </div>
    </div>
    <div class="card" style="padding:11px 13px;margin-right:24px;font-size:11.5px">提案書のドラフトができました。繁忙期に配車担当1名へ問い合わせが集中し、1日 <b>約2.5時間</b> が電話対応に消えている点 <a style="font-weight:800">f1</a> が課題です。</div>
    <div class="card" style="padding:10px 13px;margin-right:24px;display:flex;align-items:center;gap:9px;box-shadow:var(--sh-md)">
      <span style="width:26px;height:26px;border-radius:7px;background:var(--brand-soft);color:var(--brand);display:flex;align-items:center;justify-content:center">${I.file}</span>
      <span style="flex:1;min-width:0"><b style="display:block;font-size:11.5px">ミナト様 ご提案.docx</b>
      <span style="font-size:10px;color:var(--ink3)">10:44 · Google ドキュメント</span></span>${hi}
    </div>
  </div>
  <div style="flex:none;padding:0 14px 10px">
    <div style="display:flex;gap:6px;margin-bottom:8px">
      ${['ドキュメント', 'スプレッドシート', 'Slack'].map((t) => `<button class="btn btn-s" style="padding:4px 10px;font-size:10.5px">${t}</button>`).join('')}
    </div>
    <div class="card" style="display:flex;align-items:center;gap:9px;padding:8px 8px 8px 13px">
      <span style="flex:1;color:var(--ink4);font-size:12px">指示する…</span>
      <button class="btn btn-p" style="padding:6px 10px">${I.send}</button>
    </div>
  </div>`,
  'チャット',
);

boards['MobileLimited'] = mobileShell(
  `<div style="flex:1;overflow:hidden;padding:18px 16px 0">
    <div style="font-size:16px;font-weight:800">メニュー</div>
    <div class="card" style="margin-top:11px;display:flex;align-items:center;gap:9px;padding:10px 12px">
      <span class="avatar" style="width:24px;height:24px;background:var(--ink);color:#fff;font-size:9.5px;font-weight:800">株</span>
      <span style="flex:1;font-size:12px;font-weight:700">株式会社フェイズラ</span>
      <span class="chip" style="background:var(--bg);color:var(--ink3)">STARTER</span>
    </div>
    <div class="lbl" style="margin:16px 4px 7px">スマホで使える</div>
    <div class="card" style="padding:4px 14px">
      ${[
        ['home', 'ホーム', ''],
        ['chat', 'チャット', '3'],
        ['doc', '成果物（閲覧・共有）', ''],
        ['check', '承認する', '1'],
      ]
        .map(
          ([icon, t, badge]) => `<div style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line);font-size:13px;font-weight:600">
          <span style="color:var(--brand)">${I[icon]}</span>${t}
          ${badge ? `<span class="chip" style="margin-left:auto;background:var(--brand-soft);color:var(--brand)">${badge}</span>` : `<span style="margin-left:auto;color:var(--ink4)">${I.arrow}</span>`}</div>`,
        )
        .join('')}
    </div>
    <div class="lbl" style="margin:16px 4px 7px">パソコン向け</div>
    <div class="card" style="padding:4px 14px;background:var(--bg)">
      ${['エージェントの作成・編集', 'ガバナンス（AIログ・リスク）', '業務ページ（営業・分析・SNS）', 'タスクの一括操作']
        .map(
          (t) => `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--ink3)">
          <span style="color:var(--ink4)">${I.gear}</span>${t}</div>`,
        )
        .join('')}
    </div>
    <p style="font-size:11px;color:var(--ink2);margin:12px 4px 0;line-height:1.7">エージェントの手順編集やAIログの監査は、表が横に長く、スマホでは正確に扱えません。<b>閲覧・承認・チャットはスマホ</b>、<b>設定と監査はパソコン</b>という分担にしています。</p>
  </div>`,
  'メニュー',
);

/* ── 書き出し ── */
for (const [name, html] of Object.entries(boards)) {
  writeFileSync(join(OUT, `${name}.dc.html`), html);
  console.log(`wrote ${name}.dc.html (${html.length}B)`);
}
console.log('done:', Object.keys(boards).length, 'boards');
