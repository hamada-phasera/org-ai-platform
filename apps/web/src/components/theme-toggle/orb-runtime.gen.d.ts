/* orb-runtime.gen.js の型。実体は make-react-runtime.py の生成物 */

export type LiquidOrbState = 'idle' | 'thinking';

export interface LiquidOrbHandle {
  getState(): LiquidOrbState;
  setState(state: LiquidOrbState): void;
  destroy(): void;
}

export function mountLiquidOrb(
  canvas: HTMLCanvasElement,
  options?: {
    /** 初期状態。ダークで開いた場合に "thinking" を渡すとクロスフェード無しで暗い球から始まる */
    initialState?: LiquidOrbState;
    /** WebGPU 不可・デバイスロスト等。呼び出し側はフォールバック表示に切り替える */
    onError?: (error: unknown) => void;
  },
): LiquidOrbHandle;
