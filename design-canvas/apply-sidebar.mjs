#!/usr/bin/env node
// 5つのデスクトップ・アートボードのサイドバーを1つの正本から流し込む。
// 手でコピーすると必ずズレる（歯車アイコンが3種類・シェブロン欠落・バッジ不一致が実際に起きた）。
//
//   node apply-sidebar.mjs
//
// 置換範囲: 各ファイルの最初の <aside …> … </aside>（右レールは2つ目以降なので触らない）。
// あわせて .grp のトークン色と .nav-on:hover を正規化する。

import { readFile, writeFile } from 'node:fs/promises';

const TARGETS = [
  { file: 'Top.dc.html', active: 'home' },
  { file: 'TopExpanded.dc.html', active: 'home' },
  // Main は「ダッシュボード」= TOP の「数字を見る」を押した先の密な画面。
  { file: 'Main.dc.html', active: 'dashboard' },
  { file: 'Chat.dc.html', active: 'chat' },
  { file: 'Agents.dc.html', active: 'agents' },
  { file: 'Deliverables.dc.html', active: 'deliverables' },
  { file: 'Governance.dc.html', active: 'governance' },
];

const ICON = {
  logo: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h11M4 18h7"/></svg>',
  chevron: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6A7280" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l4-4 4 4M16 15l-4 4-4-4"/></svg>',
  home: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l9-7 9 7v10a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M9 22V12h6v10"/></svg>',
  chat: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 01-9 8.4 8.9 8.9 0 01-4-.9L3 21l1.9-4.9A8.4 8.4 0 013.6 11 8.4 8.4 0 0112 3a8.4 8.4 0 019 8.5z"/></svg>',
  agents: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M12 8V4M9 14h.01M15 14h.01"/></svg>',
  doc: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/></svg>',
  tasks: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  dashboard: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V10M10 19V5M16 19v-6M21 19H3"/></svg>',
  shield: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7.5 3v6c0 4.6-3.1 8.2-7.5 9.4C7.6 20.2 4.5 16.6 4.5 12V6z"/></svg>',
  // Lucide settings。5ファイルで3種類に分裂していたので、この1本に統一する。
  gear: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 006.9 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 14.6a2 2 0 010-4h.1A1.6 1.6 0 004.6 6.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-1.1V3a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.1 2.7H21a2 2 0 010 4h-.1a1.6 1.6 0 00-1.5 1.3z"/></svg>',
};

/** バッジは全画面で同じ数を出す（画面によって通知が消えるのは実装の事故に見える）。 */
function badge(text, on, tone) {
  if (on) {
    return `<span style="margin-left:auto;display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:5px;background:rgba(255,255,255,0.2);color:#fff;font-size:9.5px;font-weight:800;" class="mono">${text}</span>`;
  }
  if (tone === 'danger') {
    return `<span style="margin-left:auto;display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:5px;background:#FEF2F2;border:1px solid #FECACA;color:#B91C1C;font-size:9.5px;font-weight:800;">${text}</span>`;
  }
  return `<span style="margin-left:auto;display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:5px;background:#F5F6F8;color:#6A7280;font-size:9.5px;font-weight:800;" class="mono">${text}</span>`;
}

function item(key, active, icon, label, trailing) {
  const on = key === active;
  const cls = on ? 'nav nav-on' : 'nav';
  const aria = on ? ' aria-current="page"' : '';
  return `      <button type="button" class="${cls}"${aria}>${icon}${label}${trailing ? trailing(on) : ''}</button>`;
}

function deptItem(color, label) {
  return `      <button type="button" class="nav"><span style="width:8px;height:8px;border-radius:2px;background:${color};margin-left:3px;margin-right:4px;"></span>${label}</button>`;
}

function sidebar(active) {
  return `<aside style="width:240px;flex-shrink:0;background:#FFFFFF;border-right:1px solid #E7E9ED;display:flex;flex-direction:column;padding:14px 12px 12px;box-sizing:border-box;">
    <div style="display:flex;align-items:center;gap:9px;padding:0 8px 14px;">
      <div style="width:26px;height:26px;border-radius:7px;background:#101521;display:flex;align-items:center;justify-content:center;">${ICON.logo}</div>
      <div style="font-size:15px;font-weight:800;letter-spacing:-0.01em;">FLOW</div>
    </div>

    <button type="button" aria-label="組織を切り替え — 株式会社フェイズラ、STARTER プラン" style="display:flex;align-items:center;gap:9px;width:100%;padding:8px 9px;border:1px solid #E7E9ED;border-radius:8px;background:#FBFBFC;font-family:inherit;text-align:left;cursor:pointer;box-sizing:border-box;">
      <span style="width:22px;height:22px;border-radius:5px;background:#101521;color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;">株</span>
      <span style="flex:1;min-width:0;">
        <span style="display:block;font-size:11.5px;font-weight:700;color:#101521;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">株式会社フェイズラ</span>
        <span style="display:block;font-size:9.5px;color:#6A7280;font-weight:600;">STARTER プラン</span>
      </span>
      ${ICON.chevron}
    </button>

    <nav style="display:flex;flex-direction:column;gap:2px;margin-top:14px;">
${item('home', active, ICON.home, 'ホーム')}
${item('dashboard', active, ICON.dashboard, 'ダッシュボード')}
${item('chat', active, ICON.chat, 'チャット', (on) => badge('3', on))}
${item('agents', active, ICON.agents, 'エージェント')}
${item('deliverables', active, ICON.doc, '成果物', (on) => `<span class="sr">新着あり</span><span style="margin-left:auto;width:6px;height:6px;border-radius:50%;background:${on ? '#FFFFFF' : '#3D4EFF'};"></span>`)}
${item('tasks', active, ICON.tasks, 'タスク')}

      <div class="grp">業務ページ</div>
${deptItem('#4F46E5', '営業パイプライン')}
${deptItem('#0D9488', 'データ分析')}
${deptItem('#9333EA', 'SNS投稿')}

      <div class="grp">管理</div>
${item('governance', active, ICON.shield, 'ガバナンス', (on) => badge('1', on, 'danger'))}
${item('settings', active, ICON.gear, '設定')}
    </nav>

    <div style="margin-top:auto;">
      <div style="border:1px solid #E7E9ED;border-radius:9px;padding:10px 11px;background:#FBFBFC;">
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:10.5px;font-weight:700;color:#59616F;">今月の AI 呼び出し<span class="mono" style="color:#101521;">62 / 100</span></div>
        <div style="height:4px;border-radius:2px;background:#E7E9ED;margin-top:7px;overflow:hidden;"><div style="width:62%;height:100%;background:#101521;"></div></div>
        <div style="font-size:9.5px;color:#6A7280;margin-top:6px;">9月1日にリセット</div>
      </div>
      <button type="button" aria-label="アカウント — 濱田 大和、OWNER" style="display:flex;align-items:center;gap:9px;width:100%;margin-top:10px;padding:6px 8px;border:none;background:transparent;border-radius:8px;font-family:inherit;text-align:left;cursor:pointer;box-sizing:border-box;">
        <span style="width:26px;height:26px;border-radius:50%;background:#F5F6F8;border:1px solid #E7E9ED;font-size:10.5px;font-weight:800;display:flex;align-items:center;justify-content:center;color:#59616F;flex-shrink:0;">濱</span>
        <span style="flex:1;min-width:0;"><span style="display:block;font-size:11.5px;font-weight:700;color:#101521;">濱田 大和</span><span style="display:block;font-size:9.5px;color:#6A7280;">OWNER</span></span>
      </button>
    </div>
  </aside>`;
}

// ナビは <button>。div + cursor:pointer だとキーボードで到達できない。
const NAV_CSS = `    .nav { display: flex; align-items: center; gap: 9px; width: 100%; height: 32px; padding: 0 10px; border: none; background: transparent; border-radius: 7px; font-family: inherit; font-size: 12.5px; font-weight: 600; color: #59616F; text-align: left; cursor: pointer; }
    .nav:hover { background: #F5F6F8; color: #101521; }
    .nav:focus-visible { outline: 2px solid #3D4EFF; outline-offset: 2px; }
    .nav-on, .nav-on:hover { background: #101521; color: #FFFFFF; }
    .grp { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #6A7280; padding: 0 10px; margin: 16px 0 6px; }
    .sr { width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; flex-shrink: 0; }`;

let changed = 0;
for (const { file, active } of TARGETS) {
  let src = await readFile(file, 'utf8');

  const start = src.indexOf('<aside');
  const end = src.indexOf('</aside>', start);
  if (start === -1 || end === -1) {
    console.error(`skip ${file}: no <aside> found`);
    continue;
  }
  src = src.slice(0, start) + sidebar(active) + src.slice(end + '</aside>'.length);

  // .nav / .nav-on / .grp を1本化する（ファイルごとに微妙に違っていた）
  const cssStart = src.indexOf('    .nav {');
  if (cssStart !== -1) {
    const grpLine = src.indexOf('\n', src.indexOf('.grp {', cssStart));
    src = src.slice(0, cssStart) + NAV_CSS + src.slice(grpLine);
  }

  await writeFile(file, src, 'utf8');
  changed += 1;
  console.log(`sidebar → ${file} (active: ${active})`);
}
console.log(`done: ${changed} files`);
