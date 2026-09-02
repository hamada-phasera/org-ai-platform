import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Moon, Sun } from 'lucide-react';
import { useThemeStore } from '../../store/themeStore';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { DesktopOnly } from './DesktopOnly';
import { isMobileRoute } from './navConfig';
import { useMotion, usePrefersReducedMotion } from '../motion/springs';

/**
 * アプリの唯一のシェル。
 *
 * v1 は Layout.tsx（全ルート）と Dashboard/DashboardLayout.tsx（"/" 専用）の
 * 2 つが並立し、同じ h-screen + AmbientBackground + BottomNav を二重に持っていた。
 * ここへ統合する。
 */
export function AppShell() {
  const location = useLocation();
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const transition = useMotion('enter');
  const reduced = usePrefersReducedMotion();

  const mobileAllowed = isMobileRoute(location.pathname);

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center gap-3 px-4 lg:px-6">
          <div className="ml-auto flex items-center gap-2">
            {/* デスクトップのテーマ切替はサイドバー下部の LiquidOrbToggle。
                ここはサイドバーが無いモバイルだけの簡易ボタン。 */}
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
              className="flex h-11 w-11 items-center justify-center rounded-sm border border-border bg-elevated text-secondary transition-colors duration-fast hover:text-primary lg:hidden"
            >
              {theme === 'dark' ? (
                <Sun size={14} strokeWidth={2} aria-hidden="true" />
              ) : (
                <Moon size={14} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          </div>
        </header>

        <main className="relative min-h-0 flex-1 overflow-y-auto pb-14 lg:pb-0">
          {/* スマホで開かない画面はここで一括して誘導に差し替える。
              各ページに分岐を撒くとすぐに漏れるので、判定は 1 箇所に置く。 */}
          <div className="lg:hidden">{!mobileAllowed && <DesktopOnly />}</div>

          <div className={mobileAllowed ? 'h-full' : 'hidden h-full lg:block'}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={location.pathname}
                className="h-full"
                initial={reduced ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? undefined : { opacity: 0, y: -6 }}
                transition={transition}
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>

      <MobileNav />
    </div>
  );
}

export default AppShell;
