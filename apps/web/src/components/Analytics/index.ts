export { useDepartmentAnalytics, toDepartmentAnalytics } from './useDepartmentAnalytics';
export type { DepartmentAnalytics } from './useDepartmentAnalytics';
export { useDepartmentMetrics } from './useDepartmentMetrics';
export type { DepartmentMetricsRow } from './useDepartmentMetrics';
export { DepartmentBreakdownCard } from './DepartmentBreakdownCard';
export { DepartmentCostCard } from './DepartmentCostCard';
export { ReservedMetricCard } from './ReservedMetricCard';
export type { EfficiencyResponse, DepartmentRow } from './types';

// A-1 KPIイベントスキーマ（提案中モック）。A-4 テスト等が参照する単一 import 面。
export * from './kpiEvents';
