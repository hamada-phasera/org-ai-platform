import { NavLink } from 'react-router-dom';
import { Badge } from '../ui';
import { pageIconOf } from './icons';
import { usePagesList } from './pagesApi';

/**
 * サイドバーの「業務ページ」の見出しの下、固定 4 ページの後ろに組織のページを並べる（sortOrder 順はサーバが出す）。
 * 0 件なら何も足さない。下書きは管理者以上にだけ返ってくるので、そのまま「下書き」を付ける。
 */
export function CustomPagesNav({
  linkClass,
}: {
  linkClass: (state: { isActive: boolean }) => string;
}) {
  const { data } = usePagesList();
  if (!data || data.length === 0) return null;
  return (
    <>
      {data.map((p) => {
        const Icon = pageIconOf(p.icon);
        return (
          <NavLink key={p.slug} to={`/p/${encodeURIComponent(p.slug)}`} className={linkClass}>
            <Icon size={15} strokeWidth={2} aria-hidden="true" />
            <span className="flex-1 truncate">{p.title}</span>
            {p.status !== 'PUBLISHED' && <Badge size="xs">下書き</Badge>}
          </NavLink>
        );
      })}
    </>
  );
}
