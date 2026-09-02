/* <theme-toggle> — Liquid Glass テーマ切替トグル（依存ゼロの Web Component）
 *
 * 設計上の約束:
 *  - JSはクラスの付与/除去と属性反映だけ。動きの駆動はすべてCSS
 *  - requestAnimationFrame をループさせない（初期化の1回だけ）
 *  - アイドル時に動くものは無い
 *
 * 使い方:
 *   <link rel="stylesheet" href=".../theme-toggle.css">
 *   <script type="module" src=".../theme-toggle.js"></script>
 *   <theme-toggle></theme-toggle>
 *
 * 状態は <html data-theme="light|dark|clear"> に反映し、既存アプリ互換のため
 * .dark クラスも同期する。永続化は localStorage("tt-theme")。
 */

const THEMES = ['light', 'dark', 'clear'];
const STORE_KEY = 'tt-theme';

const LABELS = { light: 'Light', dark: 'Dark', clear: 'Clear' };

const ICONS = {
  light:
    '<svg data-icon="light" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/></svg>',
  dark:
    '<svg data-icon="dark" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>',
  clear:
    '<svg data-icon="clear" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path d="M12 3.4a8.6 8.6 0 0 1 0 17.2z" fill="currentColor" stroke="none"/></svg>',
};

/* 放射状のレンズ変位マップ（feImage 用 data URI）。
 * R=横ランプ / G=縦ランプ を半々で合成し、中心と最外周は中立(128)に戻す。
 * → 縁だけが屈折するレンズになる。 */
const MAP_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'>" +
  "<defs>" +
  "<linearGradient id='h' x1='0' y1='0' x2='1' y2='0'>" +
  "<stop offset='0' stop-color='rgb(0,128,128)'/><stop offset='1' stop-color='rgb(255,128,128)'/>" +
  "</linearGradient>" +
  "<linearGradient id='v' x1='0' y1='0' x2='0' y2='1'>" +
  "<stop offset='0' stop-color='rgb(128,0,128)'/><stop offset='1' stop-color='rgb(128,255,128)'/>" +
  "</linearGradient>" +
  "<radialGradient id='c' cx='0.5' cy='0.5' r='0.5'>" +
  "<stop offset='0' stop-color='rgb(128,128,128)' stop-opacity='1'/>" +
  "<stop offset='0.52' stop-color='rgb(128,128,128)' stop-opacity='1'/>" +
  "<stop offset='0.78' stop-color='rgb(128,128,128)' stop-opacity='0'/>" +
  "</radialGradient>" +
  "<radialGradient id='o' cx='0.5' cy='0.5' r='0.5'>" +
  "<stop offset='0.85' stop-color='rgb(128,128,128)' stop-opacity='0'/>" +
  "<stop offset='1' stop-color='rgb(128,128,128)' stop-opacity='1'/>" +
  "</radialGradient>" +
  "</defs>" +
  "<rect width='128' height='128' fill='url(%23h)'/>" +
  "<rect width='128' height='128' fill='url(%23v)' opacity='0.5'/>" +
  "<rect width='128' height='128' fill='url(%23c)'/>" +
  "<rect width='128' height='128' fill='url(%23o)'/>" +
  '</svg>';
const MAP_URI = 'data:image/svg+xml,' + MAP_SVG.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/'/g, '%27').replace(/ /g, '%20');

/* 色収差: 変位後にRGBへ分解し、R/B を ±1px ずらして screen 合成 */
function filterMarkup(id, scale, aberration) {
  const disp =
    `<feImage href="${MAP_URI}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="disp"/>`;
  if (!aberration) {
    return `<filter id="${id}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">${disp}</filter>`;
  }
  return (
    `<filter id="${id}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">` +
    disp +
    '<feColorMatrix in="disp" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r"/>' +
    '<feOffset in="r" dx="-1" dy="0" result="ro"/>' +
    '<feColorMatrix in="disp" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g"/>' +
    '<feColorMatrix in="disp" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b"/>' +
    '<feOffset in="b" dx="1" dy="0" result="bo"/>' +
    '<feBlend in="ro" in2="g" mode="screen" result="rg"/>' +
    '<feBlend in="rg" in2="bo" mode="screen"/>' +
    '</filter>'
  );
}

function readInitialTheme() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && THEMES.includes(saved)) return saved;
  } catch {
    /* localStorage 不可（プライベートモード等）は既定に落とす */
  }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function reflectToDocument(theme) {
  document.documentElement.dataset.theme = theme;
  /* 既存アプリ（Tailwind darkMode:'class'）との互換 */
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export class ThemeToggle extends HTMLElement {
  #value = 'light';

  connectedCallback() {
    if (this.dataset.rendered) return;
    this.dataset.rendered = '1';

    this.#value = readInitialTheme();
    reflectToDocument(this.#value);

    const segs = THEMES.map(
      (t) =>
        `<button type="button" class="tt-seg" role="radio" data-theme-value="${t}"` +
        ` aria-checked="${t === this.#value}" tabindex="${t === this.#value ? 0 : -1}">` +
        `<span class="tt-seg-icon" aria-hidden="true">${ICONS[t]}</span><span class="tt-seg-label">${LABELS[t]}</span>` +
        '</button>',
    ).join('');

    /* SVG defs は文書内で1組だけ（複数トグル設置時の id 重複を避ける） */
    const defs = document.getElementById('tt-defs')
      ? ''
      : `<svg id="tt-defs" width="0" height="0" style="position:absolute" aria-hidden="true">` +
        filterMarkup('tt-map-idle', 10, false) +
        filterMarkup('tt-map-move', 26, true) +
        '</svg>';

    this.innerHTML =
      defs +
      `<div class="tt-bar" role="radiogroup" aria-label="表示テーマ">${segs}</div>` +
      '<span class="tt-lens">' +
      '<span class="tt-refract-idle"></span>' +
      '<span class="tt-refract-move"></span>' +
      '<span class="tt-film"></span>' +
      '<span class="tt-rim"></span>' +
      '<span class="tt-shine"></span>' +
      `<span class="tt-icon" aria-hidden="true">${ICONS.light}${ICONS.dark}${ICONS.clear}</span>` +
      '</span>';

    this.dataset.value = this.#value;

    this.addEventListener('click', (e) => {
      const seg = e.target.closest('.tt-seg');
      if (seg) this.setTheme(seg.dataset.themeValue);
    });

    /* ← → はフォーカス移動のみ。決定は Enter/Space（button の click として届く） */
    this.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const segList = [...this.querySelectorAll('.tt-seg')];
      const current = segList.indexOf(document.activeElement);
      if (current === -1) return;
      e.preventDefault();
      const next = (current + (e.key === 'ArrowRight' ? 1 : -1) + segList.length) % segList.length;
      segList.forEach((s, i) => s.setAttribute('tabindex', i === next ? '0' : '-1'));
      segList[next].focus();
    });

    /* 動きの終端でクラスを外す（駆動はCSSに委譲、JSは後始末のみ） */
    this.querySelector('.tt-lens').addEventListener('animationend', (e) => {
      if (e.animationName === 'tt-squash') this.classList.remove('is-moving');
    });

    /* 初期配置で transition が走らないよう、描画確定後に有効化（1回だけ） */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.classList.add('is-ready'));
    });
  }

  get theme() {
    return this.#value;
  }

  /** 外部API。状態が変わればレンズが動き、同じ値なら何もしない */
  setTheme(theme) {
    if (!THEMES.includes(theme) || theme === this.#value) return;
    this.#value = theme;
    try {
      localStorage.setItem(STORE_KEY, theme);
    } catch {
      /* 保存できなくても動作は継続 */
    }
    reflectToDocument(theme);
    this.dataset.value = theme;

    this.querySelectorAll('.tt-seg').forEach((seg) => {
      const on = seg.dataset.themeValue === theme;
      seg.setAttribute('aria-checked', String(on));
      seg.setAttribute('tabindex', on ? '0' : '-1');
    });

    if (this.classList.contains('is-ready')) {
      this.classList.remove('is-moving');
      void this.offsetWidth; /* アニメーションの再始動 */
      this.classList.add('is-moving');
    }

    this.dispatchEvent(new CustomEvent('themechange', { detail: { theme }, bubbles: true }));
  }
}

if (!customElements.get('theme-toggle')) {
  customElements.define('theme-toggle', ThemeToggle);
}
