import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useDeptFilterStore } from '../../store/deptFilterStore';
import { DEPARTMENTS } from '../../constants/departments';
import { LiquidTabs } from '../motion/LiquidTabs';
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
  const dept = useDeptFilterStore((s) => s.dept);
  const setDept = useDeptFilterStore((s) => s.setDept);
  const transition = useMotion('enter');
  const reduced = usePrefersReducedMotion();

  const mobileAllowed = isMobileRoute(location.pathname);

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 部署トグル常設のトップバー（v3）。選択は deptFilterStore に載り、
            現状の実データ連動はチャット（送信時の department）のみ。 */}
        <header className="hidden h-[52px] shrink-0 items-center gap-3 border-b border-border bg-elevated px-4 lg:flex lg:px-6">
          <LiquidTabs
            id="global-dept"
            size="sm"
            label="部署で絞り込み"
            items={[
              { value: 'ALL', label: 'すべて' },
              ...DEPARTMENTS.map((d) => ({ value: d.key, label: d.label })),
            ]}
            value={dept ?? 'ALL'}
            onChange={(v) => setDept(v === 'ALL' ? null : v)}
          />
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
