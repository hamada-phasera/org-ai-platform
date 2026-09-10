import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from '../components/motion/springs';

/**
 * 件数を1つずつ増やして「組み上がっていく」様子を見せる。
 *
 * AI が返した手順を順に現すための演出。実際の生成は一度に返ってくるので、
 * これは**結果の見せ方**であって生成過程の中継ではない（そう見せかけない）。
 * 動きを減らす設定の人には一括表示する。
 */
export function useStaggeredReveal(total: number, stepMs = 180): number {
  const reduced = usePrefersReducedMotion();
  const [visible, setVisible] = useState(() => (reduced ? total : 0));

  useEffect(() => {
    if (reduced) {
      setVisible(total);
      return;
    }
    if (total <= 0) {
      setVisible(0);
      return;
    }
    setVisible(0);
    let current = 0;
    const timer = window.setInterval(() => {
      current += 1;
      setVisible(current);
      if (current >= total) window.clearInterval(timer);
    }, stepMs);
    return () => window.clearInterval(timer);
  }, [total, stepMs, reduced]);

  return visible;
}
