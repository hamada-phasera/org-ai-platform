import { useReducedMotion } from 'framer-motion';
import type { Transition } from 'framer-motion';

/**
 * モーションの値はここが正本。各コンポーネントでスプリングを直書きしないこと。
 *
 * v1 は 8 箇所にバラバラの値が散っていた（300/30・400/28・400/30・400/22・
 * 300/28・60/18/mass1.2 …）。用途ごとに 3 つへ集約する。
 */
export const springs = {
  /** タブ／セグメントの選択インジケータ。跳ねずに素早く追従させる。 */
  indicator: { type: 'spring', stiffness: 380, damping: 32 } as Transition,
  /** ボタン → 詳細パネルの展開。面が大きいので少しゆっくり。 */
  morph: { type: 'spring', stiffness: 260, damping: 30 } as Transition,
  /** 一覧・カードの出現。件数が多いとスプリングは騒がしいので ease にする。 */
  enter: { duration: 0.18, ease: [0.2, 0, 0, 1] } as Transition,
};

export type SpringName = keyof typeof springs;

/** 「視差効果を減らす」が ON のときの代替。アニメーションせず即座に確定させる。 */
export const instant: Transition = { duration: 0 };

/**
 * OS の視差効果設定を尊重した transition を返す。
 *
 * index.css の `prefers-reduced-motion` ブロックは CSS アニメーションしか止めず、
 * framer-motion の transform は止まらない。JS 側はこのフックを通すこと。
 */
export function useMotion(name: SpringName): Transition {
  const reduced = useReducedMotion();
  return reduced ? instant : springs[name];
}

/** 動きを完全に止めるべきかどうか（要素の出し入れ自体を省きたいときに使う）。 */
export function usePrefersReducedMotion(): boolean {
  return useReducedMotion() ?? false;
}
