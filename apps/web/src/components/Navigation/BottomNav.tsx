import { motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, Bell, Home, Package, Search, Sparkles } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useChatStore } from '../../store/chatStore';
import { useFooterSearchStore } from '../../store/footerSearchStore';
import { FooterSearch } from './FooterSearch';

const NAV_TONE = '#8fd8ff';

export interface BottomNavProps {
  showBack?: boolean;
  onBack?: () => void;
}

export function BottomNav({ showBack, onBack }: BottomNavProps) {
  const reduceMotion = useReducedMotion();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    selectedAgentId,
    currentSessionId,
    sessions,
    setPendingDepartment,
    setSelectedAgent,
    setAutoCreateSession,
  } =
    useChatStore();
  const secretarySearchOpen = useFooterSearchStore((s) => s.secretarySearchOpen);
  const openSecretarySearch = useFooterSearchStore((s) => s.openSecretarySearch);
  const requestFooterSearchFocus = useFooterSearchStore((s) => s.requestFooterSearchFocus);

  const onChat = location.pathname.startsWith('/chat');
  const isAssistantActive = secretarySearchOpen || (onChat && selectedAgentId === 'assistant');
  const isAiActive = onChat && !isAssistantActive;
  const isHomeActive = location.pathname === '/';
  const isDeliverablesActive = location.pathname.startsWith('/deliverables');

  const goToAi = () => {
    setSelectedAgent(null);
    setPendingDepartment(null);
    setAutoCreateSession(false);
    if (currentSessionId) {
      navigate(`/chat/${currentSessionId}`);
      return;
    }
    if (sessions[0]?.id) {
      navigate(`/chat/${sessions[0].id}`);
      return;
    }
    navigate('/chat');
  };

  return (
    <footer className="relative z-30 flex-shrink-0 bg-transparent px-3 pb-4 pt-2">
      <div className="mx-auto flex w-full max-w-xl items-center gap-2 bg-transparent">
        <div className={reduceMotion ? 'rounded-full' : 'liquid-icon-shell'}>
          <SmallIconBtn
            onClick={showBack ? onBack : () => requestFooterSearchFocus()}
            aria-label={showBack ? '戻る' : '検索'}
            reduceMotion={reduceMotion}
            className={
              reduceMotion
                ? 'border border-white/85 bg-white/82 shadow-elev-1 backdrop-blur-xl'
                : 'liquid-icon-inner'
            }
          >
            {showBack ? (
              <ArrowLeft className="h-[18px] w-[18px]" />
            ) : (
              <Search className="h-[18px] w-[18px]" />
            )}
          </SmallIconBtn>
        </div>

        <div className="min-w-0 flex-1">
          {secretarySearchOpen ? (
            <FooterSearch />
          ) : (
            <div className={reduceMotion ? '' : 'liquid-pill-shell'}>
              <div
                className={
                  reduceMotion
                    ? 'flex h-[52px] items-center justify-between gap-1.5 rounded-full border border-white/88 bg-white/78 px-2.5 shadow-elev-2 backdrop-blur-xl'
                    : 'liquid-pill-inner flex h-[52px] items-center justify-between gap-1.5 px-2.5'
                }
              >
                <NavItem
                  icon={<Home size={20} />}
                  active={isHomeActive}
                  tone={NAV_TONE}
                  onClick={() => navigate('/')}
                  reduceMotion={reduceMotion}
                />

                <NavItem
                  icon={<Package size={20} />}
                  active={isDeliverablesActive}
                  tone={NAV_TONE}
                  onClick={() => navigate('/deliverables')}
                  reduceMotion={reduceMotion}
                />

                <SmallIconBtn
                  aria-label="通知"
                  reduceMotion={reduceMotion}
                  className="relative h-10 w-10 flex-shrink-0"
                >
                  <Bell className="h-[18px] w-[18px]" />
                  <span
                    className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-danger"
                    style={{ boxShadow: '0 0 6px rgba(239,68,68,0.5)' }}
                  />
                </SmallIconBtn>

                <motion.button
                  type="button"
                  onClick={goToAi}
                  className="relative flex h-10 w-10 items-center justify-center rounded-full"
                  whileTap={reduceMotion ? undefined : { scale: 0.92 }}
                >
                  <div
                    className="relative flex h-10 w-10 items-center justify-center rounded-full"
                    style={{
                      background:
                        'linear-gradient(145deg, rgba(255,255,255,0.9) 0%, rgba(248,248,252,0.84) 50%, rgba(241,242,248,0.76) 100%)',
                      boxShadow: isAiActive
                        ? '0 0 0 2px rgba(143,216,255,0.4), 0 4px 16px rgba(143,216,255,0.14)'
                        : '0 2px 10px rgba(17,24,39,0.08)',
                    }}
                  >
                    <Sparkles className="text-[#8fd8ff]" size={18} strokeWidth={2} />
                  </div>
                </motion.button>
              </div>
            </div>
          )}
        </div>

        <motion.button
          type="button"
          onClick={() => openSecretarySearch()}
          className="relative flex h-10 w-10 items-center justify-center rounded-full"
          whileTap={reduceMotion ? undefined : { scale: 0.92 }}
        >
          <div
            className={`h-10 w-10 overflow-hidden rounded-full border-2 transition-all ${
              isAssistantActive
                ? 'border-[#b7e8ff] shadow-[0_0_14px_rgba(143,216,255,0.24)]'
                : 'border-white/82 shadow-sm'
            }`}
          >
            <img
              src="/characters/デザイナー.png"
              alt="秘書AI"
              className="h-full w-full object-cover"
            />
          </div>
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
      className={`flex h-10 w-10 items-center justify-center rounded-full text-[#a59b8c] transition-colors hover:text-primary ${className}`}
      whileTap={reduceMotion ? undefined : { scale: 0.9 }}
    >
      {children}
    </motion.button>
  );
}

function NavItem({
  icon,
  active,
  tone,
  onClick,
  reduceMotion,
}: {
  icon: React.ReactNode;
  active: boolean;
  tone: string;
  onClick: () => void;
  reduceMotion: boolean | null;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      className="relative flex h-10 w-10 items-center justify-center rounded-full"
      whileTap={reduceMotion ? undefined : { scale: 0.92 }}
    >
      <div style={{ color: active ? tone : '#a59b8c' }}>{icon}</div>
      {active && (
        <motion.div
          layoutId="bottomNavDot"
          className="absolute -bottom-0.5 h-1 w-1 rounded-full"
          style={{ backgroundColor: tone }}
          transition={{ type: 'spring', stiffness: 400, damping: 28 }}
        />
      )}
    </motion.button>
  );
}
