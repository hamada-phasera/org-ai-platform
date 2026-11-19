// 部品: n8n の parts/<key> と既存の capability の呼び出しはチャンク 6（part-client.ts）。
// それまでは届けずに失敗させる（送ったつもりで届いていない事故を避ける。K8）。
import type { NodeResult } from './types';

export async function runPartNode(): Promise<NodeResult> {
  return { ok: false, error: { code: 'FLOW_PART_NOT_CONNECTED', message: '部品はまだ使えません' } };
}
