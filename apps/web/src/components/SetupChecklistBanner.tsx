import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, CheckCircle2, Circle, Sparkles } from 'lucide-react';
import { useAuthStore } from '../store/authStore';

const STORAGE_KEY = 'org-ai-onboarding-v1-dismissed';

export default function SetupChecklistBanner() {
  const token = useAuthStore((s) => s.token);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);

  if (!token || dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  const steps = [
    { done: true, text: 'アカウントにログインしました' },
    {
      done: true,
      text: 'ログイン中のタスク AI は API 経由（重複して Groq を消費しにくい設定です）',
    },
    {
      done: false,
      text: 'ローカル開発では api-gateway（:4000）と ai-engine（:8000）を起動し、GROQ_API_KEY を ai-engine に設定',
    },
    { done: false, text: '「チャット」で相談 →「タスク」でメール・資料などの成果物を生成、の流れがおすすめです' },
  ];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        className="mb-6 rounded-2xl border border-[#8b85ff]/25 bg-gradient-to-br from-[#8b85ff]/8 to-transparent overflow-hidden"
      >
        <div className="p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-[#8b85ff]/15 flex items-center justify-center flex-shrink-0">
                <Sparkles size={18} className="text-[#8b85ff]" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-[#2D2D2D]">はじめのチェックリスト</h3>
                <p className="text-xs text-[#8A8A8A] mt-0.5">この画面をすぐ使い始めるための目安です</p>
              </div>
            </div>
            <button
              type="button"
              onClick={dismiss}
              className="text-[#BCBCBC] hover:text-[#2D2D2D] p-1 rounded-lg transition-colors flex-shrink-0"
              aria-label="閉じる"
            >
              <X size={18} />
            </button>
          </div>
          <ul className="mt-4 space-y-2.5">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-[#2D2D2D] leading-relaxed">
                {s.done ? (
                  <CheckCircle2 size={15} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                ) : (
                  <Circle size={15} className="text-[#BCBCBC] flex-shrink-0 mt-0.5" />
                )}
                <span className={s.done ? 'text-[#5C5C5C]' : ''}>{s.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
