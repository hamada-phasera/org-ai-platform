import { describe, it, expect } from 'vitest';
import {
  isPipelineStage,
  canTransition,
  PIPELINE_STAGES,
  type PipelineStage,
} from '../../src/routes/sales/pipeline-core';

describe('isPipelineStage', () => {
  it('正常系: 有効なステージ文字列を true と判定する', () => {
    for (const s of PIPELINE_STAGES) {
      expect(isPipelineStage(s)).toBe(true);
    }
  });

  it('エッジ: 未知の文字列・非文字列を false と判定する', () => {
    expect(isPipelineStage('LOST')).toBe(false);
    expect(isPipelineStage('lead')).toBe(false); // 大文字小文字は区別する
    expect(isPipelineStage('')).toBe(false);
    expect(isPipelineStage(undefined)).toBe(false);
    expect(isPipelineStage(3)).toBe(false);
    expect(isPipelineStage(null)).toBe(false);
  });
});

describe('canTransition', () => {
  it('正常系: 非終端ステージ間は前後どちらへも移動できる', () => {
    expect(canTransition('LEAD', 'NEGOTIATION')).toBe(true);
    expect(canTransition('NEGOTIATION', 'PROPOSAL')).toBe(true);
    expect(canTransition('PROPOSAL', 'WON')).toBe(true);
    // 差し戻し（後退）も許可
    expect(canTransition('PROPOSAL', 'LEAD')).toBe(true);
    expect(canTransition('NEGOTIATION', 'LEAD')).toBe(true);
  });

  it('エッジ: 受注(WON)は終端。他ステージへは戻せない', () => {
    expect(canTransition('WON', 'LEAD')).toBe(false);
    expect(canTransition('WON', 'PROPOSAL')).toBe(false);
    // WON→WON（変化なし）は許容
    expect(canTransition('WON', 'WON')).toBe(true);
  });

  it('エッジ: 不正なステージ値が混ざると false', () => {
    expect(canTransition('LEAD', 'DONE' as PipelineStage)).toBe(false);
    expect(canTransition('FOO' as PipelineStage, 'LEAD')).toBe(false);
  });
});
