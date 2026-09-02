import { motion } from 'framer-motion';

const SUGGESTIONS: Record<string, { label: string; prompts: string[] }> = {
  sales: {
    label: '営業部',
    prompts: ['提案書を作成して', 'メールの下書きを作って', '見積もりを生成して', '商談レポートを書いて'],
  },
  marketing: {
    label: 'マーケ部',
    prompts: ['SNS投稿を作成して', 'キャンペーン企画を立てて', 'コンテンツカレンダーを作成', 'ブランド分析レポート'],
  },
  accounting: {
    label: '経理部',
    prompts: ['月次レポートを作成', '経費を集計して', '予算分析をして', '売上データを可視化'],
  },
  analytics: {
    label: '分析部',
    prompts: ['データを可視化して', 'トレンド分析をして', 'KPIレポートを作成', 'ダッシュボードを生成'],
  },
  general: {
    label: '総務部',
    prompts: ['議事録を作成して', '社内通知を書いて', 'マニュアルを作成', '業務フローを整理'],
  },
  secretary: {
    label: '秘書',
    prompts: ['スケジュールを管理して', '会議を設定して', 'リマインダーを作成', '出張手配をして'],
  },
};

interface AgentSuggestionsProps {
  agentId: string | null;
  onSelect: (prompt: string) => void;
}

export function AgentSuggestions({ agentId, onSelect }: AgentSuggestionsProps) {
  if (!agentId) return null;

  const suggestion = SUGGESTIONS[agentId] ?? SUGGESTIONS['general'];
  if (!suggestion) return null;

  return (
    <motion.div
      className="flex flex-wrap gap-2 px-1 pb-3"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      {suggestion.prompts.map((prompt) => (
        <motion.button
          key={prompt}
          onClick={() => onSelect(prompt)}
          className="text-xs bg-elevated border border-border text-primary px-3.5 py-2 rounded-full hover:bg-accent-soft hover:border-accent transition-all"
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
        >
          {prompt}
        </motion.button>
      ))}
    </motion.div>
  );
}
