export const DEPT_LABEL: Record<string, string> = {
  SALES: '営業部',
  MARKETING: 'マーケ部',
  ACCOUNTING: '経理部',
  ANALYTICS: 'データ分析',
  GENERAL: '総合',
};

export const DEPT_ACCENT: Record<string, string> = {
  SALES: '#4F46E5', // indigo
  MARKETING: '#7C3AED', // violet
  ACCOUNTING: '#0EA5E9', // sky
  ANALYTICS: '#0D9488', // teal
  GENERAL: '#475569', // slate
};

export const DEPARTMENTS = [
  { key: 'SALES', label: '営業部', icon: '🤝' },
  { key: 'MARKETING', label: 'マーケ部', icon: '📣' },
  { key: 'ACCOUNTING', label: '経理部', icon: '📊' },
  { key: 'ANALYTICS', label: 'データ分析', icon: '📈' },
  { key: 'GENERAL', label: '総合AI', icon: '✨' },
];
