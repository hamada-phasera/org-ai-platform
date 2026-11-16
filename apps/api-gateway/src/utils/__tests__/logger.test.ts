import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger, errorMessage } from '../logger';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('info は console.log に [scope] を付けて出す', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('chat').info('responded via ai-engine', { n: 1 });
    expect(spy).toHaveBeenCalledWith('[chat] responded via ai-engine', { n: 1 });
  });

  it('warn / error はそれぞれ console.warn / console.error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('inbox/draft');
    log.warn('w');
    log.error('e:', 'detail');
    expect(warn).toHaveBeenCalledWith('[inbox/draft] w');
    expect(error).toHaveBeenCalledWith('[inbox/draft] e:', 'detail');
  });

  it('console を握り込まない（作成後の spyOn も効く）', () => {
    const log = createLogger('late');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.error('x');
    expect(spy).toHaveBeenCalledWith('[late] x');
  });
});

describe('errorMessage', () => {
  it('Error ならメッセージだけ', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('Error 以外は値そのもの', () => {
    const obj = { code: 1 };
    expect(errorMessage(obj)).toBe(obj);
    expect(errorMessage('str')).toBe('str');
    expect(errorMessage(undefined)).toBeUndefined();
  });
});
