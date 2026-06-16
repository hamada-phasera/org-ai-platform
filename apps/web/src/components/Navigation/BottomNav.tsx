import { motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, Bot, Home, Moon, Package, Search, Shield, Sparkles, Sun } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useChatStore } from '../../store/chatStore';
import { useFooterSearchStore } from '../../store/footerSearchStore';
import { useThemeStore } from '../../store/themeStore';
import { FooterSearch } from './FooterSearch';

const NAV_TONE = 'var(--accent)';
const INACTIVE = 'var(--text-muted)';

export interface BottomNavProps {
  showBack?: boolean;
  onBack?: () => void;
}

export function BottomNav({ showBack, onBack }: BottomNavProps) {
  const reduceMotion = useReducedMotion();
  const navigate = useNavigate();
  const location = useLocation();
  const { currentSessionId, sessions, setPendingDepartment, setSelectedAgent, setAutoCreateSession } =
    useChatStore();
  const secretarySearchOpen = useFooterSearchStore((s) => s.secretarySearchOpen);
  const openSecretarySearch = useFooterSearchStore((s) => s.openSecretarySearch);
  const requestFooterSearchFocus = useFooterSearchStore((s) => s.requestFooterSearchFocus);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);

  const onChat = location.pathname.startsWith('/chat');
  const isHomeActive = location.pathname === '/';
  const isDeliverablesActive = location.pathname.startsWith('/deliverables');
  const isAgentsActive = location.pathname.startsWith('/agents');
  const isGovernanceActive = location.pathname.startsWith('/governance');

  const goToAi = () => {
    setSelectedAgent(null);
    setPendingDepartment(null);
    setAutoCreateSession(false);
    if (currentSessionId) return navigate(`/chat/${currentSessionId}`);
    if (sessions[0]?.id) return navigate(`/chat/${sessions[0].id}`);
    navigate('/chat');
  };

  return (
    <footer className="relative z-30 flex-shrink-0 bg-transparent px-3 pb-4 pt-2">
      <div className="mx-auto flex w-full max-w-2xl items-center gap-2">
        {/* left: back / search */}
        <SmallIconBtn
          onClick={showBack ? onBack : () => requestFooterSearchFocus()}
          aria-label={showBack ? '戻る' : '検索'}
          reduceMotion={reduceMotion}
          className="liquid-icon-inner"
        >
          {showBack ? <ArrowLeft className="h-[18px] w-[18px]" /> : <Search className="h-[18px] w-[18px]" />}
        </SmallIconBtn>

        {/* center: nav pill */}
        <div className="min-w-0 flex-1">
          {secretarySearchOpen ? (
            <FooterSearch />
          ) : (
            <div className="liquid-pill-inner flex h-[52px] items-center justify-between gap-1 px-3">
              <NavItem icon={<Home size={19} />} active={isHomeActive} onClick={() => navigate('/')} reduceMotion={reduceMotion} />
              <NavItem icon={<Bot size={19} />} active={isAgentsActive} onClick={() => navigate('/agents')} reduceMotion={reduceMotion} />
              <NavItem icon={<Package size={19} />} active={isDeliverablesActive} onClick={() => navigate('/deliverables')} reduceMotion={reduceMotion} />
              <NavItem icon={<Shield size={19} />} active={isGovernanceActive} onClick={() => navigate('/governance')} reduceMotion={reduceMotion} />
              <motion.button
                type="button"
                onClick={goToAi}
                aria-label="AIチャット"
                className="relative flex h-9 w-9 items-center justify-center rounded-full"
                style={{ background: onChat ? 'var(--accent)' : 'var(--accent-soft)' }}
                whileTap={reduceMotion ? undefined : { scale: 0.92 }}
              >
                <Sparkles size={17} strokeWidth={2} style={{ color: onChat ? '#fff' : 'var(--accent)' }} />
              </motion.button>
            </div>
          )}
        </div>

        {/* right: theme toggle + secretary */}
        <SmallIconBtn onClick={toggleTheme} aria-label="テーマ切替" reduceMotion={reduceMotion} className="liquid-icon-inner">
          {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </SmallIconBtn>
        <motion.button
          type="button"
          onClick={() => openSecretarySearch()}
          aria-label="秘書AI"
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full liquid-icon-inner"
          style={secretarySearchOpen ? { boxShadow: '0 0 0 2px var(--accent-glow)' } : undefined}
          whileTap={reduceMotion ? undefined : { scale: 0.92 }}
        >
          <Sparkles size={18} style={{ color: 'var(--accent)' }} />
        </motion.button>
      </div>
    </footer>
  );
}

/* ---- sub-components ---- */

function SmallIconBtn({
  children,
  onClick,
  className = '',
  'aria-label': ariaLabel,
  reduceMotion,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  'aria-label'?: string;
  reduceMotion: boolean | null;
}) {
  return (
    <motion.button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:text-primary ${className}`}
      whileTap={reduceMotion ? undefined : { scale: 0.9 }}
    >
      {children}
    </motion.button>
  );
}

function NavItem({
  icon,
  active,
  onClick,
  reduceMotion,
}: {
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  reduceMotion: boolean | null;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      className="relative flex h-10 w-10 items-center justify-center rounded-full transition-colors"
      whileTap={reduceMotion ? undefined : { scale: 0.92 }}
    >
      <div style={{ color: active ? NAV_TONE : INACTIVE }}>{icon}</div>
      {active && (
        <motion.div
          layoutId="bottomNavDot"
          className="absolute -bottom-0.5 h-1 w-1 rounded-full"
          style={{ backgroundColor: NAV_TONE }}
          transition={{ type: 'spring', stiffness: 400, damping: 28 }}
        />
      )}
    </motion.button>
  );
}
