import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { usePrefersReducedMotion } from '../motion/springs';
import { isStalled, phaseDetail, phaseLabel, type ChatPhase } from '../../utils/chatProgress';

/**
 * 回答を待っているあいだの表示。
 *
 * 回答は生成が終わってから一括で出す方針なので、待っている時間が長い。
 * その間「止まっている」と誤解されないよう、いま何をしているかを出す。
 *
 * ⚠️ 進捗率（何%）は出さない。全体の長さが分からないので必ず嘘になる。
 *    出すのは実際に起きたフェーズと、受信済みの文字数だけ。
 */

interface Props {
  phase: ChatPhase | null;
  chars: number | null;
  lastEventAt: number | null;
}

export function ChatProgress({ phase, chars, lastEventAt }: Props) {
  const reduceMotion = usePrefersReducedMotion();
  const [now, setNow] = useState(() => Date.now());

  /* 「時間がかかっています」の判定にだけ使う時計。1秒ごとで足りる */
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const label = phaseLabel(phase);
  const detail = phaseDetail(phase, chars);
  const stalled = isStalled(lastEventAt, now);

  return (
    <div className="flex items-center gap-2.5 pt-2" aria-live="polite">
      {/* 3点の律動。reduced motion なら静止した点にする */}
      <div className="flex items-center gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-accent"
            animate={reduceMotion ? undefined : { opacity: [0.3, 1, 0.3] }}
            transition={
              reduceMotion
                ? undefined
                : { duration: 1.2, repeat: Infinity, delay: i * 0.15, ease: 'easeInOut' }
            }
            style={reduceMotion ? { opacity: 0.6 } : undefined}
          />
        ))}
      </div>

      <p className="text-xs text-secondary">
        {label}
        {detail && <span className="tabular ml-1.5 text-text-muted">{detail}</span>}
      </p>

      {stalled && (
        <p className="text-micro text-text-muted">
          いつもより時間がかかっています。そのままお待ちください。
        </p>
      )}
    </div>
  );
}

export default ChatProgress;
