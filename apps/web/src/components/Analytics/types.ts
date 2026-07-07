/**
 * A-2 ローカル型。GET /api/dashboard/efficiency を read-only で流用するための表示用型。
 * cost / successRate は現状データ源が無く A-3 (usage-metrics-svc 部署別集計) で接続予定のため null。
 */

/** /dashboard/efficiency レスポンスのうち本画面で使う部分のみ（HomePage の inline 型と整合）。 */
export interface EfficiencyResponse {
  today: { minutesSaved: number; tasksCompleted: number };
  week: { minutesSaved: number; tasksCompleted: number };
  allTime: { minutesSaved: number; tasksCompleted: number; hoursSaved: number };
  byDepartment: { department: string; minutesSaved: number; tasks: number }[];
}

/** 画面表示用に導出した1部署ぶんの行。department は API 由来の生文字列（dirty 値も許容）。 */
export interface DepartmentRow {
  department: string;
  label: string;
  accent: string;
  executions: number; // = byDepartment[].tasks（完了 DONE タスク数＝実行数）
  minutesSaved: number;
  share: number; // 実行数の全体比 (0..1)
  costUsd: number | null; // A-3 で接続予定（現状データ源なし・捏造しない）
  successRate: number | null; // A-3 で接続予定（/efficiency は DONE のみ返すため算出不可）
}
