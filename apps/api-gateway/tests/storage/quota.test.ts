import { describe, it, expect } from 'vitest';
import {
  PLAN_LIMITS,
  STORAGE_ADDON_UNIT_BYTES,
  canUpload,
  formatBytes,
  storageQuotaBytes,
} from '@org-ai/shared-types';

const MB = 1024 * 1024;

describe('storageQuotaBytes', () => {
  it('プランの無料枠に追加容量を足す', () => {
    expect(storageQuotaBytes('STARTER')).toBe(PLAN_LIMITS.STARTER.storageBytes);
    expect(storageQuotaBytes('STARTER', 2)).toBe(PLAN_LIMITS.STARTER.storageBytes + 2 * STORAGE_ADDON_UNIT_BYTES);
  });

  it('負の口数は 0 として扱う', () => {
    expect(storageQuotaBytes('PRO', -3)).toBe(PLAN_LIMITS.PRO.storageBytes);
  });

  it('松竹梅の順に容量と1ファイルの上限が大きい', () => {
    expect(PLAN_LIMITS.STARTER.storageBytes).toBeLessThan(PLAN_LIMITS.PRO.storageBytes);
    expect(PLAN_LIMITS.PRO.storageBytes).toBeLessThan(PLAN_LIMITS.MAX.storageBytes);
    expect(PLAN_LIMITS.STARTER.maxFileBytes).toBeLessThanOrEqual(PLAN_LIMITS.PRO.maxFileBytes);
    expect(PLAN_LIMITS.PRO.maxFileBytes).toBeLessThanOrEqual(PLAN_LIMITS.MAX.maxFileBytes);
  });

  it('1ファイルの上限は、そのプランの容量を超えない', () => {
    for (const limits of Object.values(PLAN_LIMITS)) {
      expect(limits.maxFileBytes).toBeLessThanOrEqual(limits.storageBytes);
    }
  });
});

describe('canUpload', () => {
  const quota = PLAN_LIMITS.STARTER.storageBytes;

  it('ちょうど上限までは受け付ける', () => {
    expect(canUpload('STARTER', quota - MB, MB).ok).toBe(true);
  });

  it('1バイトでも超えたら QUOTA_EXCEEDED', () => {
    expect(canUpload('STARTER', quota - MB, MB + 1)).toMatchObject({ ok: false, reason: 'QUOTA_EXCEEDED', quota });
  });

  it('1ファイルの上限はプランごとに違う', () => {
    const size = PLAN_LIMITS.STARTER.maxFileBytes + 1;
    expect(canUpload('STARTER', 0, size).reason).toBe('FILE_TOO_LARGE');
    expect(canUpload('PRO', 0, size).ok).toBe(true);
  });

  it('サイズ超過を容量超過より先に判定する（直し方が違うので、正しい方を案内する）', () => {
    expect(canUpload('STARTER', quota, PLAN_LIMITS.STARTER.maxFileBytes + 1).reason).toBe('FILE_TOO_LARGE');
  });

  it('追加容量があれば、無料枠を使い切った組織も保存できる', () => {
    expect(canUpload('STARTER', quota, MB).ok).toBe(false);
    expect(canUpload('STARTER', quota, MB, 1).ok).toBe(true);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0MB'],
    [512, '1KB'],
    [300 * 1024, '300KB'],
    [100 * MB, '100MB'],
    [1024 * MB, '1GB'],
    [1536 * MB, '1.5GB'],
  ])('%i → %s', (bytes, label) => {
    expect(formatBytes(bytes)).toBe(label);
  });
});
