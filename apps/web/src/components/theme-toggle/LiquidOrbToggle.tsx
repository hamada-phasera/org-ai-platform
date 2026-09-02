import { useEffect, useRef, useState } from 'react';
import { useThemeStore } from '../../store/themeStore';
import type { LiquidOrbHandle } from './orb-runtime.gen';
import './liquid-orb-toggle.css';

/**
 * WebGPU のシャボン玉が楕円ピルの上をスライドするテーマトグル。
 * 見た目の正本は demo/liquid-orb.html — 内部座標はデモと同一で、
 * CSS の --lo-scale だけで縮小している（数値調整はデモ側で行う）。
 *
 * 実行時JS (orb-runtime.gen.js, 約85KB) は WebGPU がある環境でだけ
 * 動的 import する。無い環境・デバイスロスト時は CSS だけの
 * シャボン玉に落ち、トグルとしては同じに動く。
 */
export function LiquidOrbToggle() {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const orbRef = useRef<LiquidOrbHandle | null>(null);
  const mountedOnce = useRef(false);
  const [moving, setMoving] = useState(false);
  const [fallback, setFallback] = useState(
    () => typeof navigator === 'undefined' || !('gpu' in navigator),
  );

  useEffect(() => {
    if (fallback) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let handle: LiquidOrbHandle | null = null;
    import('./orb-runtime.gen')
      .then(({ mountLiquidOrb }) => {
        if (cancelled) return;
        handle = mountLiquidOrb(canvas, {
          initialState: useThemeStore.getState().theme === 'dark' ? 'thinking' : 'idle',
          onError: () => setFallback(true),
        });
        orbRef.current = handle;
      })
      .catch(() => setFallback(true));
    return () => {
      cancelled = true;
      handle?.destroy();
      orbRef.current = null;
    };
  }, [fallback]);

  /* テーマ変更に追随（このトグル以外から変わっても球が動く）。
   * 球の色は idle=ライトの白流体 / thinking=ダークのリボンで、
   * エンジン内蔵の sRGB クロスフェード(0.65s)がスライドと同時に走る。 */
  useEffect(() => {
    if (!mountedOnce.current) {
      mountedOnce.current = true;
      return;
    }
    orbRef.current?.setState(theme === 'dark' ? 'thinking' : 'idle');
    setMoving(false);
    requestAnimationFrame(() => setMoving(true));
  }, [theme]);

  return (
    <span className="lo-wrap">
      <button
        type="button"
        role="switch"
        aria-checked={theme === 'dark'}
        aria-label="テーマを切り替え（ライト / ダーク）"
        className={['lo-scene', moving ? 'lo-moving' : '', fallback ? 'lo-fallback' : '']
          .filter(Boolean)
          .join(' ')}
        onClick={toggle}
      >
        <span className="lo-pill">
          <span className="lo-lab lo-lab-light">Light</span>
          <span className="lo-lab lo-lab-dark">Dark</span>
        </span>
        <span className="lo-carrier" onAnimationEnd={() => setMoving(false)}>
          <span className="lo-orb-slot">
            <canvas ref={canvasRef} className="lo-canvas" aria-hidden="true" />
          </span>
          <span className="lo-orb-icon" aria-hidden="true">
            <svg
              className="lo-icon-sun"
              width="60"
              height="60"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="4.1" fill="currentColor" stroke="none" />
              <path d="M12 2.6v2.4M12 19v2.4M2.6 12h2.4M19 12h2.4M5.4 5.4l1.7 1.7M16.9 16.9l1.7 1.7M18.6 5.4l-1.7 1.7M7.1 16.9l-1.7 1.7" />
            </svg>
            <svg
              className="lo-icon-moon"
              width="54"
              height="54"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" fill="currentColor" stroke="none" />
            </svg>
          </span>
        </span>
      </button>
    </span>
  );
}

export default LiquidOrbToggle;
