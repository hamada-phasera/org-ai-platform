import { describe, it, expect } from 'vitest';
import {
  PLAN_LIMITS,
  STORAGE_ADDON_UNIT_BYTES,
  canUpload,
  formatBytes,
  hasRoleAtLeast,
  isUserRole,
  storageQuotaBytes,
  usageState,
} from '../index';

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('formatBytes', () => {
  it.each([
    [0, '0MB'],
    [-5, '0MB'],
    [1, '1KB'],
    [512 * 1024, '512KB'],
    [MB, '1MB'],
    [240 * MB, '240MB'],
    [GB, '1GB'],
    [1.5 * GB, '1.5GB'],
    [20 * GB, '20GB'],
  ])('%d → %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('storageQuotaBytes / canUpload', () => {
  it('込みの容量 + 追加容量（10GB 単位）', () => {
    expect(storageQuotaBytes('STARTER')).toBe(GB);
    expect(storageQuotaBytes('PRO', 2)).toBe(5 * GB + 2 * STORAGE_ADDON_UNIT_BYTES);
  });

  it('追加容量の負数は 0 扱い', () => {
    expect(storageQuotaBytes('MAX', -3)).toBe(PLAN_LIMITS.MAX.storageBytes);
  });

  it('1ファイルの上限を超えたら FILE_TOO_LARGE（容量より先に判定）', () => {
    const r = canUpload('STARTER', 0, PLAN_LIMITS.STARTER.maxFileBytes + 1);
    expect(r).toEqual({ ok: false, reason: 'FILE_TOO_LARGE', quota: GB });
  });

  it('容量を超えるなら QUOTA_EXCEEDED、ちょうどは OK', () => {
    expect(canUpload('STARTER', GB - MB, MB).ok).toBe(true);
    expect(canUpload('STARTER', GB - MB, MB + 1).reason).toBe('QUOTA_EXCEEDED');
  });

  it('追加容量があれば枠が広がる', () => {
    expect(canUpload('STARTER', GB, MB, 1).ok).toBe(true);
  });
});

describe('役割', () => {
  it('isUserRole は3値だけ', () => {
    expect(isUserRole('OWNER')).toBe(true);
    expect(isUserRole('VIEWER')).toBe(false);
    expect(isUserRole(undefined)).toBe(false);
  });

  it('hasRoleAtLeast は順序どおりで、未知の値は fail-closed', () => {
    expect(hasRoleAtLeast('OWNER', 'ADMIN')).toBe(true);
    expect(hasRoleAtLeast('ADMIN', 'ADMIN')).toBe(true);
    expect(hasRoleAtLeast('MEMBER', 'ADMIN')).toBe(false);
    expect(hasRoleAtLeast('owner', 'MEMBER')).toBe(false);
    expect(hasRoleAtLeast(null, 'MEMBER')).toBe(false);
  });
});

describe('usageState', () => {
  it.each([
    [0, 100, 'ok'],
    [79, 100, 'ok'],
    [80, 100, 'warn'],
    [100, 100, 'over'],
    [5000, 100, 'over'],
    [10, 0, 'ok'],
  ] as const)('%d/%d → %s', (used, limit, expected) => {
    expect(usageState(used, limit)).toBe(expected);
  });
});
