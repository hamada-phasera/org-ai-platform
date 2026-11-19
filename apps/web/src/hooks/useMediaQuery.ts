import { useEffect, useState } from 'react';

/** Tailwind の `lg`（1024px）。これ未満がスマホ・タブレット縦の扱い（DESIGN.md §4） */
export const DESKTOP_QUERY = '(min-width: 1024px)';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/**
 * メディアクエリの一致。CSS（`lg:hidden`）では隠すだけで読み込みは止まらないので、
 * 読み込み自体を分けたいとき（スマホで `@xyflow/react` を読まない）に使う。
 * matchMedia が無い環境（テスト）は一致しない＝スマホ側に倒す。
 */
export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setValue(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return value;
}
