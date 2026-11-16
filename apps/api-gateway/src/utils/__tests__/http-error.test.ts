import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { errorBody, sendError, upstreamStatus } from '../http-error';

function fakeReply() {
  const reply = {
    code: vi.fn(),
    send: vi.fn(),
  };
  reply.code.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply;
}

describe('errorBody', () => {
  it('統一フォーマット { success:false, error:{code,message} } を作る', () => {
    expect(errorBody('NOT_FOUND', '見つかりません')).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: '見つかりません' },
    });
  });

  it('余計なキーを持たない', () => {
    const body = errorBody('X', 'y');
    expect(Object.keys(body)).toEqual(['success', 'error']);
    expect(Object.keys(body.error)).toEqual(['code', 'message']);
  });
});

describe('sendError', () => {
  it('ステータスを付けて本文を送り、reply を返す', () => {
    const reply = fakeReply();
    const out = sendError(reply as unknown as FastifyReply, 409, 'CONFLICT', '重複しています');
    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: { code: 'CONFLICT', message: '重複しています' },
    });
    expect(out).toBe(reply);
  });
});

describe('upstreamStatus', () => {
  it.each([
    [500, 502],
    [503, 502],
    [599, 502],
    [400, 400],
    [404, 404],
    [429, 429],
    [499, 499],
  ])('%i → %i', (input, expected) => {
    expect(upstreamStatus(input)).toBe(expected);
  });
});
