import { describe, it, expect, vi, beforeEach } from 'vitest';
import { userWithMembership, type MembershipRowOptions } from '../../../tests/helpers/membership';

// requireAuth / requireRole（Membership 基準）。docs/design/multi-tenancy.md §11.3 M1〜M8

const prismaMock = { user: { findUnique: vi.fn() } };
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const { requireAuth, requireRole, requireAdmin, requireOwner, requireUser } = await import('../auth');
const { clearMembershipCache, invalidateMembership } = await import('../../tenancy/membership-cache');

type Req = {
  user: Record<string, unknown> | undefined;
  tenant?: { orgId: string; role: string | null; userId: string; db: unknown };
  method: string;
  url: string;
  jwtVerify: ReturnType<typeof vi.fn>;
};

/** jwtVerify が成功した状態の request を作る（既定は書き込み要求） */
function makeReq(over: { sub?: string; orgId?: string | null; jwtRole?: string; method?: string; url?: string } = {}): Req {
  return {
    user: { sub: over.sub ?? 'u-1', orgId: over.orgId === undefined ? 'org-A' : over.orgId, role: over.jwtRole ?? 'OWNER' },
    method: over.method ?? 'POST',
    url: over.url ?? '/api/members/invitations',
    jwtVerify: vi.fn(async () => {}),
  };
}

function makeReply() {
  const r = {
    sent: false,
    statusCode: 0,
    body: null as unknown,
    code(n: number) {
      r.statusCode = n;
      return r;
    },
    send(b: unknown) {
      r.sent = true;
      r.body = b;
      return r;
    },
  };
  return r;
}
const codeOf = (reply: ReturnType<typeof makeReply>) => (reply.body as { error?: { code: string } } | null)?.error?.code;

function dbSays(o: MembershipRowOptions | null) {
  prismaMock.user.findUnique.mockResolvedValue(o === null ? null : userWithMembership(o));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMembershipCache();
});

describe('requireAuth（テナントの解決）', () => {
  it('M1: 所属が ACTIVE なら通り、request.tenant に組織と Membership の role が入る', async () => {
    dbSays({ role: 'ADMIN' });
    const req = makeReq({ jwtRole: 'MEMBER' });
    const reply = makeReply();
    await requireAuth(req as never, reply as never);
    expect(reply.sent).toBe(false);
    expect(req.tenant?.orgId).toBe('org-A');
    expect(req.tenant?.role).toBe('ADMIN');
    expect(req.tenant?.userId).toBe('u-1');
    expect(req.tenant?.db).toBeTruthy();
    // 所属の確認はトークンの組織で引く
    expect(prismaMock.user.findUnique.mock.calls[0][0].select.memberships.where).toEqual({ orgId: 'org-A' });
  });

  it('M2: その組織の Membership が無ければ 403 TENANT_ACCESS_REVOKED', async () => {
    dbSays({ member: false });
    const reply = makeReply();
    await requireAuth(makeReq() as never, reply as never);
    expect(reply.statusCode).toBe(403);
    expect(codeOf(reply)).toBe('TENANT_ACCESS_REVOKED');
  });

  it('M3: Membership が DISABLED なら 403 TENANT_ACCESS_REVOKED（ログアウトはさせない）', async () => {
    dbSays({ status: 'DISABLED' });
    const reply = makeReply();
    const req = makeReq({ method: 'GET', url: '/api/tasks' });
    await requireAuth(req as never, reply as never);
    expect(reply.statusCode).toBe(403);
    expect(codeOf(reply)).toBe('TENANT_ACCESS_REVOKED');
    expect(req.tenant).toBeUndefined();
  });

  it('M4: アカウントが無効化されていたら 401（E3。読み取りでも止める）', async () => {
    dbSays({ userStatus: 'DISABLED' });
    const reply = makeReply();
    await requireAuth(makeReq({ method: 'GET', url: '/api/tasks' }) as never, reply as never);
    expect(reply.statusCode).toBe(401);
  });

  it('アカウントが DB に無ければ 401', async () => {
    dbSays(null);
    const reply = makeReply();
    await requireAuth(makeReq() as never, reply as never);
    expect(reply.statusCode).toBe(401);
  });

  it('所属組織の無いトークン（orgId=null）は 403 TENANT_REQUIRED で、DB を引かない', async () => {
    const reply = makeReply();
    await requireAuth(makeReq({ orgId: null }) as never, reply as never);
    expect(reply.statusCode).toBe(403);
    expect(codeOf(reply)).toBe('TENANT_REQUIRED');
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it('認証に失敗したら DB を引かない', async () => {
    const req = { user: undefined, jwtVerify: vi.fn(async () => { throw new Error('bad'); }) } as never;
    const reply = makeReply();
    await requireAuth(req, reply as never);
    expect(reply.statusCode).toBe(401);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it('M6: 同じ (user, org) は 30 秒キャッシュされ、破棄すると読み直す', async () => {
    dbSays({});
    await requireAuth(makeReq() as never, makeReply() as never);
    await requireAuth(makeReq() as never, makeReply() as never);
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);

    // メンバー管理 API が呼ぶ破棄
    invalidateMembership('u-1', 'org-A');
    dbSays({ status: 'DISABLED' });
    const reply = makeReply();
    await requireAuth(makeReq() as never, reply as never);
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(2);
    expect(reply.statusCode).toBe(403);
  });

  it('キャッシュは組織ごと（A の結果を B に使わない）', async () => {
    dbSays({});
    await requireAuth(makeReq({ orgId: 'org-A' }) as never, makeReply() as never);
    dbSays({ member: false });
    const reply = makeReply();
    await requireAuth(makeReq({ orgId: 'org-B' }) as never, reply as never);
    expect(reply.statusCode).toBe(403);
  });

  it('M8: 解約済みの組織への書き込みは 402、読み取りは通す', async () => {
    dbSays({ subscriptionStatus: 'canceled' });
    const w = makeReply();
    await requireAuth(makeReq() as never, w as never);
    expect(w.statusCode).toBe(402);

    const r = makeReply();
    await requireAuth(makeReq({ method: 'GET', url: '/api/tasks' }) as never, r as never);
    expect(r.sent).toBe(false);
  });
});

describe('requireRole', () => {
  it('M5: JWT の role が OWNER でも、Membership.role が MEMBER なら 403（JWT を信じない）', async () => {
    dbSays({ role: 'MEMBER' });
    const reply = makeReply();
    await requireAdmin(makeReq({ jwtRole: 'OWNER' }) as never, reply as never);
    expect(reply.statusCode).toBe(403);
    expect(codeOf(reply)).toBe('FORBIDDEN');
  });

  it('M7: キャッシュを通らない（2回とも DB を読む＝降格が即座に効く）', async () => {
    dbSays({ role: 'OWNER' });
    await requireOwner(makeReq() as never, makeReply() as never);
    dbSays({ role: 'ADMIN' });
    const reply = makeReply();
    await requireOwner(makeReq() as never, reply as never);
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(2);
    expect(reply.statusCode).toBe(403);
  });

  it('⚠️ 無効化された利用者は 401（403 ではない）', async () => {
    dbSays({ userStatus: 'DISABLED' });
    const reply = makeReply();
    await requireAdmin(makeReq() as never, reply as never);
    expect(reply.statusCode).toBe(401);
  });

  it('組織から外された利用者は 403 TENANT_ACCESS_REVOKED', async () => {
    dbSays({ member: false });
    const reply = makeReply();
    await requireAdmin(makeReq() as never, reply as never);
    expect(reply.statusCode).toBe(403);
    expect(codeOf(reply)).toBe('TENANT_ACCESS_REVOKED');
  });

  it('JWT の orgId がそのまま操作対象（DB の User.orgId で上書きしない）', async () => {
    // User.orgId は「最後に選んだ組織」にすぎない。トークンは組織ごとに独立している（S7）
    dbSays({ role: 'ADMIN' });
    const req = makeReq({ orgId: 'org-B' });
    await requireAdmin(req as never, makeReply() as never);
    expect(req.tenant?.orgId).toBe('org-B');
    expect(req.user?.orgId).toBe('org-B');
    expect(req.user?.role).toBe('ADMIN');
  });

  it('OWNER は ADMIN の要求を満たす（上位は下位を含む）', async () => {
    dbSays({ role: 'OWNER' });
    const reply = makeReply();
    await requireAdmin(makeReq() as never, reply as never);
    expect(reply.sent).toBe(false);
  });

  it('⚠️ ADMIN は OWNER の要求を満たさない', async () => {
    dbSays({ role: 'ADMIN' });
    const reply = makeReply();
    await requireOwner(makeReq() as never, reply as never);
    expect(reply.statusCode).toBe(403);
  });

  it('MEMBER は ADMIN も OWNER も満たさない', async () => {
    dbSays({ role: 'MEMBER' });
    for (const guard of [requireAdmin, requireOwner]) {
      const reply = makeReply();
      await guard(makeReq() as never, reply as never);
      expect(reply.statusCode).toBe(403);
    }
  });

  it('未知の role は fail-closed（通さない）', async () => {
    dbSays({ role: 'SUPERUSER' });
    const reply = makeReply();
    await requireRole('MEMBER')(makeReq() as never, reply as never);
    expect(reply.statusCode).toBe(403);
  });

  it('書き込みは契約で止まった時点で終わり（role の判定まで進まない）', async () => {
    dbSays({ role: 'OWNER', subscriptionStatus: 'canceled' });
    const reply = makeReply();
    await requireOwner(makeReq() as never, reply as never);
    expect(reply.statusCode).toBe(402);
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('requireUser（組織を選ぶ前の操作）', () => {
  it('有効なアカウントなら組織が無くても通す', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    const reply = makeReply();
    await requireUser(makeReq({ orgId: null }) as never, reply as never);
    expect(reply.sent).toBe(false);
  });

  it('無効化されたアカウントは 401', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ status: 'DISABLED' });
    const reply = makeReply();
    await requireUser(makeReq() as never, reply as never);
    expect(reply.statusCode).toBe(401);
  });
});
