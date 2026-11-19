import { describe, it, expect, vi } from 'vitest';

// adapters は DB を読む（ここでは引かないので空のモック）
vi.mock('../../utils/prisma', () => ({ prisma: {} }));
import { APPROVAL_REQUIRED_CAPS, FLOW_PARTS } from '@org-ai/shared-types';
import { DEFAULT_CAPABILITIES } from '../default-capabilities';
import { getNativeAdapter } from '../adapters';

/**
 * 業務フローの部品カタログ（shared-types/flow-parts.ts）のうち capability 経由の部品が、
 * gateway の既定の capability と合っているか（docs/design/canvas-home.md §8.3）。
 */
describe('部品カタログ ⇔ 既定の capability', () => {
  const capParts = FLOW_PARTS.flatMap((p) => (p.via.kind === 'capability' ? [{ part: p, name: p.via.name }] : []));

  it('capability 経由の部品は既定の capability にあり、入力の key は引数名と同じで必須も揃う', () => {
    expect(capParts.length).toBeGreaterThan(0);
    for (const { part, name } of capParts) {
      const cap = DEFAULT_CAPABILITIES.find((c) => c.name === name);
      expect(cap, `${part.key} → ${name}`).toBeDefined();
      const schema = cap?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const props = Object.keys(schema.properties ?? {});
      for (const f of part.input) expect(props, `${part.key}.${f.key}`).toContain(f.key);
      const requiredInPart = part.input.filter((f) => f.required).map((f) => f.key).sort();
      expect(requiredInPart, part.key).toEqual([...(schema.required ?? [])].sort());
    }
  });

  it('外へ送る capability（APPROVAL_REQUIRED_CAPS）は external_send、そうでないものは none', () => {
    for (const { part, name } of capParts) {
      expect(part.sideEffect === 'external_send', part.key).toBe((APPROVAL_REQUIRED_CAPS as readonly string[]).includes(name));
    }
  });

  it('Slack・Google の部品は native adapter で動く（顧客の接続を使い、n8n に資格情報を置かない。K7）', () => {
    for (const name of ['create_google_doc', 'create_google_sheet', 'notify_slack']) {
      expect(capParts.some((c) => c.name === name)).toBe(true);
      expect(getNativeAdapter(name), name).not.toBeNull();
    }
  });
});
