import { describe, it, expect } from 'vitest';
import {
  getTemplate,
  buildProposalMessages,
  PROPOSAL_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
} from '../../src/routes/sales/proposal-templates';

describe('getTemplate', () => {
  it('正常系: id 指定で該当テンプレート、未指定で既定(standard)を返す', () => {
    expect(getTemplate('short')?.id).toBe('short');
    expect(getTemplate()?.id).toBe(DEFAULT_TEMPLATE_ID);
    expect(getTemplate(DEFAULT_TEMPLATE_ID)?.id).toBe('standard');
  });

  it('エッジ: 未知の id は undefined', () => {
    expect(getTemplate('does-not-exist')).toBeUndefined();
  });
});

describe('buildProposalMessages', () => {
  const template = PROPOSAL_TEMPLATES.find((t) => t.id === 'standard')!;

  it('正常系: system に全章タイトル、user に入力値が含まれる', () => {
    const messages = buildProposalMessages(template, {
      customerName: '株式会社サンプル',
      background: '受発注が電話とFAX中心',
      requirements: '在庫管理を自動化したい',
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    // 章タイトルが system に反映される
    for (const s of template.sections) {
      expect(messages[0].content).toContain(s.title);
    }
    // 入力値が user に反映される
    expect(messages[1].content).toContain('株式会社サンプル');
    expect(messages[1].content).toContain('受発注が電話とFAX中心');
    expect(messages[1].content).toContain('在庫管理を自動化したい');
    // 価格の確定値を出さないガードが system にある
    expect(messages[0].content).toContain('金額の確定値');
  });

  it('エッジ: customerName のみ → 背景/要望行は出さず、2メッセージは維持', () => {
    const messages = buildProposalMessages(template, { customerName: 'A社' });
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain('A社');
    expect(messages[1].content).not.toContain('背景・状況:');
    expect(messages[1].content).not.toContain('要望・要件:');
  });
});
