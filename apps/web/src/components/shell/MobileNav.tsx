import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Menu, Monitor, X } from 'lucide-react';
import { DESKTOP_MENU, MOBILE_MENU, MOBILE_TABS } from './navConfig';
import type { NavItem } from './navConfig';
import { useMotion } from '../motion/springs';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import { OrgSwitcher } from '../org/OrgSwitcher';

/** メニューの行頭。主ナビはアイコン、業務ページは部署色の小さな四角（サイドバーと同じ） */
function ItemMark({ item, muted }: { item: NavItem; muted?: boolean }) {
  if ('icon' in item) {
    const Icon = item.icon;
    return (
      <Icon size={18} strokeWidth={2} className={muted ? 'text-ink-decorative' : undefined} aria-hidden="true" />
    );
  }
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-[2px] ${muted ? 'opacity-60' : ''}`}
      style={{ background: item.colorVar }}
      aria-hidden="true"
    />
  );
}

const tabClass =
  'flex flex-1 flex-col items-center justify-center gap-0.5 h-14 min-w-[44px] text-micro font-semibold transition-colors duration-fast';

export function MobileNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const transition = useMotion('enter');
  // サイドバーと同じキー（同じキャッシュを共有する）
  const { data: org } = useQuery<{ name: string; plan: string } | null>({
    queryKey: ['org-me'],
    queryFn: async () => (await api.get<{ data: { name: string; plan: string } }>('/organizations/me')).data.data,
    staleTime: 5 * 60_000,
    enabled: menuOpen,
  });

  return (
    <>
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            key="menu"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transition}
            className="fixed inset-0 z-40 overflow-y-auto bg-canvas pb-[calc(4rem+env(safe-area-inset-bottom))] pt-[env(safe-area-inset-top)] lg:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="メニュー"
          >
            <div className="flex h-14 items-center justify-between px-4">
              <h2 className="text-sm font-extrabold">メニュー</h2>
              <button
                type="button"
                aria-label="メニューを閉じる"
                onClick={() => setMenuOpen(false)}
                className="flex h-11 w-11 items-center justify-center rounded-md border border-border bg-elevated"
              >
                <X size={16} strokeWidth={2.3} aria-hidden="true" />
              </button>
            </div>

            <div className="px-4 pt-1">
              <OrgSwitcher org={org} />
            </div>

            <p className="px-4 pb-2 pt-3 text-micro font-bold uppercase tracking-[0.1em] text-text-muted">
              スマホで使える
            </p>
            <ul className="border-y border-border bg-elevated">
              {MOBILE_MENU.map((item) => (
                <li key={item.to} className="border-b border-hairline last:border-b-0">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate(item.to);
                    }}
                    className="flex h-[52px] w-full items-center gap-3 px-4 text-left text-sm font-semibold"
                  >
                    <ItemMark item={item} />
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>

            <p className="flex items-center gap-1.5 px-4 pb-2 pt-5 text-micro font-bold uppercase tracking-[0.1em] text-text-muted">
              パソコン向け
              <Monitor size={13} strokeWidth={2} aria-hidden="true" />
            </p>
            <ul className="border-y border-border bg-elevated">
              {DESKTOP_MENU.map((item) => (
                <li
                  key={item.to}
                  className="flex items-center gap-3 border-b border-hairline px-4 py-4 text-sm font-semibold text-text-muted last:border-b-0"
                >
                  <ItemMark item={item} muted />
                  {item.label}
                </li>
              ))}
            </ul>

            <p className="px-4 py-4 text-sm leading-relaxed text-secondary">
              エージェントの手順編集や AI ログの監査は表が横に長く、スマホでは正確に扱えません。
              <b className="text-primary">閲覧・承認・契約はスマホ</b>、
              <b className="text-primary">編集と監査はパソコン</b>という分担にしています。
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <nav
        className="bg-elevated border border-border shadow-elev-3 fixed inset-x-0 bottom-0 z-50 flex rounded-none border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] lg:hidden"
        aria-label="モバイルナビゲーション"
      >
        {MOBILE_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            onClick={() => setMenuOpen(false)}
            className={({ isActive }) =>
              `${tabClass} ${isActive && !menuOpen ? 'text-primary' : 'text-text-muted'}`
            }
          >
            <tab.icon size={19} strokeWidth={2} aria-hidden="true" />
            {tab.label}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          className={`${tabClass} ${menuOpen ? 'text-primary' : 'text-text-muted'}`}
        >
          <Menu size={19} strokeWidth={2} aria-hidden="true" />
          メニュー
        </button>
      </nav>
    </>
  );
}
