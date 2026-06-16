import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { BottomNav } from './Navigation/BottomNav';
import { AmbientBackground } from './ui/AmbientBackground';

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="flex flex-col h-screen overflow-hidden relative">
      <AmbientBackground />
      <main className="flex-1 overflow-auto relative z-0">
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            className="h-full"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>
      <BottomNav showBack={location.pathname !== '/'} onBack={() => navigate(-1)} />
    </div>
  );
}
