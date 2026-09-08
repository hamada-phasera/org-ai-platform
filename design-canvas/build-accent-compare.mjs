#!/usr/bin/env node
// AccentCompare.dc.html を生成する。
//
// 3案を手書きで並べると、色以外のところ（余白・文字サイズ・角丸）が必ずズレて
// 「どっちが良いか」ではなく「どっちが丁寧に描かれたか」の比較になってしまう。
// 同じテンプレートに配色だけ差し込んで、色以外が完全に同一であることを保証する。
//
//   node build-accent-compare.mjs

import { writeFile } from 'node:fs/promises';

const OPTIONS = [
  {
    key: 'A',
    name: 'インク',
    recommended: true,
    action: '#101521',
    hover: '#232A3A',
    accent: '#3D4EFF',
    soft: '#EEF0FF',
    softBorder: '#DDE1FF',
    onDark: '#A5B4FC',
    tint: 'rgba(16,21,33,0.07)',
    collide: 'なし',
    collideTone: 'ok',
    verdict: '主役は墨。青はフォーカスとリンクだけ。部署5色と役割が分かれるので、データの色が最も強く見える。',
    cost: '華やかさは最も低い。ブランド色としての記憶に残りにくい。',
  },
  {
    key: 'B',
    name: 'インディゴ',
    recommended: false,
    action: '#4F46E5',
    hover: '#4338CA',
    accent: '#4F46E5',
    soft: '#EEF2FF',
    softBorder: '#DDE2FE',
    onDark: '#C7D2FE',
    tint: 'rgba(79,70,229,0.10)',
    collide: '営業部と完全一致',
    collideTone: 'bad',
    verdict: '現行 v1 の色をそのまま主役に。移行コストが最も低く、既存画面と混在しても違和感が出ない。',
    cost: '主アクションと営業部が同じ #4F46E5。ボタンなのか営業のデータなのか、色では見分けられなくなる。',
  },
  {
    key: 'C',
    name: 'コバルト',
    recommended: false,
    action: '#1E4FFF',
    hover: '#1740D6',
    accent: '#1E4FFF',
    soft: '#E9EFFF',
    softBorder: '#D3E0FF',
    onDark: '#BFD3FF',
    tint: 'rgba(30,79,255,0.10)',
    collide: '経理部と近い',
    collideTone: 'warn',
    verdict: '彩度の高い青を主役に。3案で最も「先進的」に振れる。法人向けの信頼感とも両立しやすい色域。',
    cost: '面積を取ると画面全体が青く染まる。経理部の水色とも近く、使用面積の規律が要る。',
  },
];

const DEPTS = [
  ['営業部', '#4F46E5'],
  ['マーケ部', '#9333EA'],
  ['経理部', '#0284C7'],
  ['データ分析', '#0D9488'],
  ['総合', '#475569'],
];

const TONE = {
  ok: { bg: '#ECFDF5', border: '#A7F3D0', fg: '#047857' },
  warn: { bg: '#FFFBEB', border: '#FDE68A', fg: '#B45309' },
  bad: { bg: '#FEF2F2', border: '#FECACA', fg: '#B91C1C' },
};

/* ── 各行のセル。o は配色。ここ以外に色は書かない ── */
const CELLS = {
  buttons: (o) => `
      <div style="display:flex;align-items:center;gap:8px;">
        <button style="height:32px;padding:0 14px;border-radius:7px;border:none;background:${o.action};color:#fff;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;">実行する</button>
        <button style="height:32px;padding:0 14px;border-radius:7px;border:1px solid #D8DCE3;background:#fff;color:#101521;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;">下書き</button>
        <button style="height:32px;padding:0 12px;border-radius:7px;border:none;background:transparent;color:#59616F;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;">あとで</button>
      </div>`,

  sidebar: (o) => `
      <div style="border:1px solid #E7E9ED;border-radius:9px;background:#fff;padding:6px;display:flex;flex-direction:column;gap:2px;">
        <div style="display:flex;align-items:center;gap:9px;height:30px;padding:0 10px;border-radius:7px;font-size:12px;font-weight:600;color:#59616F;"><span style="width:13px;height:13px;border-radius:3px;background:#E7E9ED;"></span>ホーム</div>
        <div style="display:flex;align-items:center;gap:9px;height:30px;padding:0 10px;border-radius:7px;font-size:12px;font-weight:700;color:#fff;background:${o.action};"><span style="width:13px;height:13px;border-radius:3px;background:rgba(255,255,255,0.35);"></span>チャット<span style="margin-left:auto;font-size:9.5px;font-weight:800;background:rgba(255,255,255,0.2);border-radius:5px;padding:1px 6px;">3</span></div>
        <div style="display:flex;align-items:center;gap:9px;height:30px;padding:0 10px;border-radius:7px;font-size:12px;font-weight:600;color:#59616F;"><span style="width:13px;height:13px;border-radius:3px;background:#E7E9ED;"></span>成果物</div>
      </div>`,

  tabs: (o) => `
      <div style="display:inline-flex;align-items:center;gap:2px;padding:4px;border-radius:12px;position:relative;background:rgba(255,255,255,0.72);backdrop-filter:blur(14px) saturate(1.5);-webkit-backdrop-filter:blur(14px) saturate(1.5);border:1px solid rgba(255,255,255,0.9);box-shadow:0 1px 2px rgba(16,21,33,0.05),0 8px 24px rgba(16,21,33,0.06);">
        <span style="position:absolute;top:4px;left:82px;width:132px;height:32px;border-radius:9px;background:${o.action};"></span>
        <span style="position:relative;z-index:1;height:32px;padding:0 14px;display:inline-flex;align-items:center;font-size:12.5px;font-weight:600;color:#59616F;white-space:nowrap;">AIログ</span>
        <span style="position:relative;z-index:1;height:32px;padding:0 14px;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:#fff;white-space:nowrap;">リスクイベント<span style="display:inline-flex;align-items:center;height:17px;padding:0 5px;border-radius:5px;background:rgba(255,255,255,0.2);font-size:9.5px;font-weight:800;">1</span></span>
      </div>`,

  dept: (o) => {
    const t = TONE[o.collideTone];
    return `
      <div>
        <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
          <span style="display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:7px;border:1.5px solid ${o.action};background:#fff;font-size:11px;font-weight:800;color:${o.action};"><span style="width:9px;height:9px;border-radius:2px;background:${o.action};"></span>主アクション</span>
          ${DEPTS.map(([label, color]) => `<span style="display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:7px;border:1px solid #E7E9ED;background:#fff;font-size:11px;font-weight:700;color:#59616F;"><span style="width:9px;height:9px;border-radius:2px;background:${color};"></span>${label}</span>`).join('\n          ')}
        </div>
        <div style="display:inline-flex;align-items:center;gap:6px;margin-top:9px;height:22px;padding:0 9px;border-radius:6px;background:${t.bg};border:1px solid ${t.border};font-size:10.5px;font-weight:800;color:${t.fg};">衝突: ${o.collide}</div>
      </div>`;
  },

  input: (o) => `
      <div style="display:flex;flex-direction:column;gap:9px;">
        <div style="height:34px;border:1px solid #101521;border-radius:7px;background:#fff;display:flex;align-items:center;padding:0 11px;font-size:12.5px;color:#101521;outline:2px solid ${o.accent};outline-offset:2px;">週次の営業レポート</div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;background:${o.soft};border:1px solid ${o.softBorder};font-size:10.5px;font-weight:700;color:${o.hover};">RUNNING</span>
          <span style="font-size:10.5px;color:#6A7280;">薄い面と薄い罫もこの色から作る</span>
        </div>
      </div>`,

  meter: (o) => `
      <div style="border:1px solid #E7E9ED;border-radius:9px;background:#FBFBFC;padding:10px 12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:10.5px;font-weight:700;color:#59616F;">今月の AI 呼び出し<span class="mono" style="color:#101521;">62 / 100</span></div>
        <div style="height:5px;border-radius:3px;background:#E7E9ED;margin-top:8px;overflow:hidden;"><div style="width:62%;height:100%;background:${o.action};"></div></div>
      </div>`,

  link: (o) => `
      <div>
        <div style="font-size:12.5px;line-height:1.8;color:#101521;">詳しくは <a href="#" style="color:${o.accent};font-weight:700;">すべての指標を見る</a> から確認できます。</div>
        <div style="display:inline-flex;align-items:center;gap:10px;background:#101521;border-radius:10px;padding:9px 13px;margin-top:10px;">
          <span style="font-size:11.5px;font-weight:600;color:#fff;">提案書を作成しました</span>
          <span style="font-size:11.5px;font-weight:800;color:${o.onDark};">開く</span>
        </div>
      </div>`,
};

const ROWS = [
  ['主ボタン', '押せるものが1画面に何個も並ぶ。ここが最も面積を取る。', 'buttons'],
  ['サイドバーの選択中', '常時見えている。強すぎると本文より目立つ。', 'sidebar'],
  ['リキッド・タブ', 'インジケータが伸び縮みしながら移動する部分。', 'tabs'],
  ['部署カラーとの隣接', 'ここが実質の決定打。主アクションと部署の色が同じだと、ボタンなのかデータなのか色で見分けられない。', 'dept'],
  ['入力とフォーカス', 'フォーカスリングと、薄い面・薄い罫。', 'input'],
  ['メーター', '進捗・使用量。細い面積での見え方。', 'meter'],
  ['リンクと暗い面', '白地のリンクと、暗いトースト上のリンク。同じ役割で面が違う。', 'link'],
];

function head(o) {
  const badge = o.recommended
    ? `<span style="display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:5px;background:#101521;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.04em;">推奨</span>`
    : '';
  return `
      <div style="display:flex;align-items:center;gap:9px;">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:${o.action};color:#fff;font-size:12px;font-weight:800;">${o.key}</span>
        <span style="font-size:15px;font-weight:800;">${o.name}</span>
        ${badge}
      </div>
      <div style="display:flex;gap:6px;margin-top:10px;">
        <span style="flex:1;height:22px;border-radius:5px;background:${o.action};"></span>
        <span style="flex:1;height:22px;border-radius:5px;background:${o.accent};"></span>
        <span style="flex:1;height:22px;border-radius:5px;background:${o.soft};border:1px solid ${o.softBorder};"></span>
      </div>
      <div class="mono" style="display:flex;gap:6px;font-size:9.5px;color:#6A7280;margin-top:5px;">
        <span style="flex:1;">${o.action}</span><span style="flex:1;">${o.accent}</span><span style="flex:1;">${o.soft}</span>
      </div>`;
}

const GRID = 'display:grid;grid-template-columns:170px repeat(3, minmax(0,1fr));gap:22px;';

const rowsHtml = ROWS.map(
  ([label, note, cell]) => `
    <div style="${GRID}align-items:start;padding:20px 0;border-top:1px solid #F0F1F4;">
      <div style="padding-top:2px;">
        <div style="font-size:12px;font-weight:800;">${label}</div>
        <div style="font-size:10.5px;color:#6A7280;line-height:1.6;margin-top:5px;">${note}</div>
      </div>
      ${OPTIONS.map((o) => CELLS[cell](o)).join('')}
    </div>`,
).join('');

const verdictHtml = `
    <div style="${GRID}align-items:stretch;padding:22px 0 0;border-top:1px solid #E7E9ED;">
      <div style="padding-top:2px;"><div style="font-size:12px;font-weight:800;">まとめ</div></div>
      ${OPTIONS.map(
        (o) => `
      <div style="border:1px solid ${o.recommended ? '#101521' : '#E7E9ED'};border-radius:11px;background:#fff;padding:15px 16px;">
        <div style="font-size:12.5px;font-weight:800;">${o.key}. ${o.name}</div>
        <div style="font-size:11.5px;color:#59616F;line-height:1.75;margin-top:8px;">${o.verdict}</div>
        <div style="font-size:11.5px;color:#59616F;line-height:1.75;margin-top:9px;padding-top:9px;border-top:1px solid #F0F1F4;"><b style="color:#101521;">難点：</b>${o.cost}</div>
      </div>`,
      ).join('')}
    </div>`;

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Noto+Sans+JP:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
  <style>
    body { margin: 0; font-family: 'Manrope','Noto Sans JP',system-ui,sans-serif; -webkit-font-smoothing: antialiased; }
    a { color: #3D4EFF; text-decoration: none; }
    a:hover { color: #2A38D6; }
    .mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
  </style>
</helmet>

<div style="width:1440px;min-height:1560px;background:#FBFBFC;color:#101521;padding:40px 40px 48px;box-sizing:border-box;position:relative;overflow:hidden;">

  <div style="position:absolute;inset:0;pointer-events:none;">
    <div style="position:absolute;top:200px;left:200px;width:640px;height:520px;border-radius:50%;background:radial-gradient(circle at 50% 50%, rgba(61,78,255,0.07), rgba(61,78,255,0) 68%);"></div>
  </div>

  <div style="position:relative;z-index:1;">
    <div style="padding-bottom:18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#6A7280;">FLOW Design System v2</div>
      <div style="font-size:26px;font-weight:800;letter-spacing:-0.02em;margin-top:7px;">アクセント3案 — 同じ部品で比べる</div>
      <div style="font-size:12.5px;color:#59616F;margin-top:6px;max-width:900px;line-height:1.75;">3列は<b>色以外まったく同じ</b>マークアップから生成している（<span class="mono">build-accent-compare.mjs</span>）。余白や文字サイズの差で判断がぶれないようにするため。実装側でも切り替えは <span class="mono">index.css</span> の <span class="mono">--action</span> 2行だけで済むようにしてある。</div>
    </div>

    <div style="${GRID}align-items:end;padding-bottom:18px;">
      <div></div>
      ${OPTIONS.map((o) => `<div>${head(o)}</div>`).join('')}
    </div>
${rowsHtml}
${verdictHtml}
  </div>
</div>
</x-dc>
</body>
</html>
`;

await writeFile('AccentCompare.dc.html', html, 'utf8');
console.log(`AccentCompare.dc.html を生成: ${OPTIONS.length}案 × ${ROWS.length}行`);
