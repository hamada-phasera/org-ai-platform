// 定期のきっかけ（docs/design/canvas-home.md §5.5・K45・K57）。きっかけが「定期」のフローを保存すると、
// 同じトランザクションで ScheduledTask を 1 行 upsert する（やめたら消す）。発火は既存の schedule-dispatcher
// （atomic claim・契約チェック込み）が flowId を見てランナーへ渡す。
//
// ■ 時刻は日本時間で書かれる（hourJst）。ScheduledTask.hourUtc には UTC の時に直して入れ、
//   曜日・日付は**日本時間のまま**入れる（flowId のある行だけ、dispatcher が日本時間の暦で照合する。K57）。
//   UTC に直すと「毎月 1 日 8 時（JST）」が前月の末日（月で変わる）になり、表せないため。
// ■ フローが無効なら行も無効（enabled=false）。dispatcher も発火の直前にフローの enabled を見る（二重の照合）。

import type { FlowDefinition, FlowNodeOf } from '@org-ai/shared-types';
import type { TenantTx } from '../../tenancy/tenant-db';

export interface FlowScheduleRow {
  frequency: 'daily' | 'weekly' | 'monthly';
  hourUtc: number;
  /** 日本時間の曜日（0=日） */
  dayOfWeek: number | null;
  /** 日本時間の日付（1〜28） */
  dayOfMonth: number | null;
}

/** 日本時間の「時」を UTC の「時」に */
export function jstHourToUtc(hourJst: number): number {
  return (((hourJst - 9) % 24) + 24) % 24;
}

/** 定義のきっかけが定期なら、ScheduledTask に入れる値。そうでなければ null */
export function flowScheduleOf(def: Pick<FlowDefinition, 'nodes'>): FlowScheduleRow | null {
  const trigger = def.nodes.find((n): n is FlowNodeOf<'trigger'> => n.type === 'trigger');
  if (!trigger || trigger.config.mode !== 'schedule') return null;
  const c = trigger.config;
  return {
    frequency: c.frequency,
    hourUtc: jstHourToUtc(c.hourJst),
    dayOfWeek: c.frequency === 'weekly' ? c.dayOfWeek ?? null : null,
    dayOfMonth: c.frequency === 'monthly' ? c.dayOfMonth ?? null : null,
  };
}

/** フローの定期の行を定義に合わせる（作る・直す・消す）。呼び出し側のトランザクションの中で */
export async function syncFlowSchedule(
  tx: Pick<TenantTx, 'orgId' | 'scheduledTask'>,
  flow: { id: string; name: string; enabled: boolean },
  def: Pick<FlowDefinition, 'nodes'>,
): Promise<'created' | 'updated' | 'deleted' | 'none'> {
  const want = flowScheduleOf(def);
  const existing = await tx.scheduledTask.findFirst({ where: { flowId: flow.id }, select: { id: true } });
  if (!want) {
    if (!existing) return 'none';
    await tx.scheduledTask.deleteMany({ where: { flowId: flow.id } });
    return 'deleted';
  }
  const data = {
    title: flow.name,
    department: 'GENERAL',
    taskType: 'flow',
    input: '',
    frequency: want.frequency,
    hourUtc: want.hourUtc,
    dayOfWeek: want.dayOfWeek,
    dayOfMonth: want.dayOfMonth,
    enabled: flow.enabled,
  };
  if (existing) {
    await tx.scheduledTask.updateMany({ where: { id: existing.id }, data });
    // 1 フロー 1 行（古い残りがあれば消す）
    await tx.scheduledTask.deleteMany({ where: { flowId: flow.id, id: { not: existing.id } } });
    return 'updated';
  }
  await tx.scheduledTask.create({ data: { ...data, orgId: tx.orgId, flowId: flow.id } });
  return 'created';
}
