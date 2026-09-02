import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { FileText, Home, Menu, MessageCircle, Monitor, X } from 'lucide-react';
import { ADMIN_NAV, MAIN_NAV, WORK_PAGES } from './navConfig';
import type { NavEntry } from './navConfig';
import { useMotion } from '../motion/springs';

const TABS: NavEntry[] = [
  { to: '/', label: 'ホーム', icon: Home, end: true },
  { to: '/chat', label: 'チャット', icon: MessageCircle },
  { to: '/deliverables', label: '成果物', icon: FileText },
];

/** スマホで開ける画面。ここに無いものはパソコン向けとして畳んで見せる。 */
const MOBILE_OK = new Set<string>(['/', '/chat', '/deliverables']);

const tabClass =
  'flex flex-1 flex-col items-center justify-center gap-0.5 h-14 min-w-[44px] text-micro font-semibold transition-colors duration-fast';

export function MobileNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const transition = useMotion('enter');

  const desktopOnly = [...MAIN_NAV, ...ADMIN_NAV].filter((e) => !MOBILE_OK.has(e.to));

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
            className="fixed inset-0 z-40 overflow-y-auto bg-canvas pb-16 lg:hidden"
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

            <p className="px-4 pb-2 pt-3 text-micro font-bold uppercase tracking-[0.1em] text-text-muted">
              スマホで使える
            </p>
            <ul className="border-y border-border bg-elevated">
              {[...TABS].map((tab) => (
                <li key={tab.to}>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate(tab.to);
                    }}
                    className="flex h-[52px] w-full items-center gap-3 border-b border-hairline px-4 py-4 text-left text-sm font-semibold last:border-b-0"
                  >
                    <tab.icon size={18} strokeWidth={2} aria-hidden="true" />
                    {tab.label}
                  </button>
                </li>
              ))}
            </ul>

            <p className="flex items-center gap-1.5 px-4 pb-2 pt-5 text-micro font-bold uppercase tracking-[0.1em] text-text-muted">
              パソコン向け
              <Monitor size={13} strokeWidth={2} aria-hidden="true" />
            </p>
            <ul className="border-y border-border bg-elevated">
              {desktopOnly.map((entry) => (
                <li
                  key={entry.to}
                  className="flex items-center gap-3 border-b border-hairline px-4 py-4 text-sm font-semibold text-text-muted last:border-b-0"
                >
                  <entry.icon size={18} strokeWidth={2} className="text-ink-decorative" aria-hidden="true" />
                  {entry.label}
                </li>
              ))}
              {WORK_PAGES.map((page) => (
                <li
                  key={page.to}
                  className="flex items-center gap-3 border-b border-hairline px-4 py-4 text-sm font-semibold text-text-muted last:border-b-0"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-[2px] opacity-60"
                    style={{ background: page.colorVar }}
                    aria-hidden="true"
                  />
                  {page.label}
                </li>
              ))}
            </ul>

            <p className="px-4 py-4 text-sm leading-relaxed text-secondary">
              エージェントの手順編集や AI ログの監査は表が横に長く、スマホでは正確に扱えません。
              <b className="text-primary">閲覧・承認・チャットはスマホ</b>、
              <b className="text-primary">設定と監査はパソコン</b>という分担にしています。
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <nav
        className="tab-glass fixed inset-x-0 bottom-0 z-50 flex rounded-none border-x-0 border-b-0 lg:hidden"
        aria-label="モバイルナビゲーション"
      >
        {TABS.map((tab) => (
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

export default MobileNav;
