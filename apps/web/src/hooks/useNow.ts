import { useEffect, useState } from 'react';

/**
 * いまの時刻（ミリ秒）。描画中に Date.now() を呼ばないためのもの（react-hooks/purity）。
 * 期限の判定（無料期間の残り日数など）に使う。既定は 1 分ごとに進める。
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
