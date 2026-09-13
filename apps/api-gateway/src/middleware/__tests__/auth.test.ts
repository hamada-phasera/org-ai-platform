import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = { user: { findUnique: vi.fn() }, organization: { findUnique: vi.fn() } };
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const { requireRole, requireAdmin, requireOwner } = await import('../auth');

/** jwtVerify が成功した状態の request を作る（書き込み要求として扱う） */
function makeReq(sub = 'u-1', method = 'POST', url = '/api/members/invitations') {
  return {
    user: { sub, orgId: 'org-JWT', role: 'OWNER' },
    method,
    url,
    jwtVerify: vi.fn(async () => {}),
  } as never;
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

beforeEach(() => {
  vi.clearAllMocks();
  // 既定は「まだ決済を繋いでいない組織」＝契約チェックは通る
  prismaMock.organization.findUnique.mockResolvedValue({ subscriptionStatus: null });
});

describe('requireRole', () => {
  it('DB の role を見る（JWT の role は信用しない）', async () => {
    // ⚠️ JWT には OWNER が入っているが、DB では降格済み。降格が効かないと事故になる
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u-1', role: 'MEMBER', status: 'ACTIVE', orgId: 'org-1', email: 'a@b.c',
    });
    const req = makeReq();
    const reply = makeReply();

    await requireAdmin(req, reply as never);

    expect(reply.statusCode).toBe(403);
  });

  it('DB の orgId で request.user を上書きする（JWT の orgId が古くても正本に揃う）', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u-1', role: 'ADMIN', status: 'ACTIVE', orgId: 'org-REAL', email: 'a@b.c',
    });
    const req = makeReq();
    const reply = makeReply();

    await requireAdmin(req, reply as never);

    expect(reply.sent).toBe(false);
    expect((req as unknown as { user: { orgId: string; role: string } }).user.orgId).toBe('org-REAL');
    expect((req as unknown as { user: { role: string } }).user.role).toBe('ADMIN');
  });

  it('⚠️ 無効化された利用者は 401（403 ではない）', async () => {
    // 「権限が足りない」ではなく「このアカウントはもう使えない」なので、
    // フロントの 401→ログアウト導線に乗せる
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u-1', role: 'OWNER', status: 'DISABLED', orgId: 'org-1', email: 'a@b.c',
    });
    const reply = makeReply();
    await requireAdmin(makeReq(), reply as never);
    expect(reply.statusCode).toBe(401);
  });

  it('DB に居ない利用者は 401', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    const reply = makeReply();
    await requireAdmin(makeReq(), reply as never);
    expect(reply.statusCode).toBe(401);
  });

  it('組織に属していない利用者は 401', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u-1', role: 'OWNER', status: 'ACTIVE', orgId: null, email: 'a@b.c',
    });
    const reply = makeReply();
    await requireAdmin(makeReq(), reply as never);
    expect(reply.statusCode).toBe(401);
  });

  it('OWNER は ADMIN の要求を満たす（上位は下位を含む）', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u-1', role: 'OWNER', status: 'ACTIVE', orgId: 'org-1', email: 'a@b.c',
    });
    const reply = makeReply();
    await requireAdmin(makeReq(), reply as never);
    expect(reply.sent).toBe(false);
  });

  it('⚠️ ADMIN は OWNER の要求を満たさない', async () => {
    // requireOwner を「ADMIN も通す」に緩めると、メンバー管理を守ったつもりの穴になる
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u-1', role: 'ADMIN', status: 'ACTIVE', orgId: 'org-1', email: 'a@b.c',
    });
    const reply = makeReply();
    await requireOwner(makeReq(), reply as never);
    expect(reply.statusCode).toBe(403);
  });

  it('MEMBER は ADMIN も OWNER も満たさない', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u-1', role: 'MEMBER', status: 'ACTIVE', orgId: 'org-1', email: 'a@b.c',
    });
    for (const guard of [requireAdmin, requireOwner]) {
      const reply = makeReply();
      await guard(makeReq(), reply as never);
      expect(reply.statusCode).toBe(403);
    }
  });

  it('未知の role は fail-closed（通さない）', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u-1', role: 'SUPERUSER', status: 'ACTIVE', orgId: 'org-1', email: 'a@b.c',
    });
    const reply = makeReply();
    await requireRole('MEMBER')(makeReq(), reply as never);
    expect(reply.statusCode).toBe(403);
  });

  it('認証に失敗したら DB を引かない', async () => {
    const req = { user: undefined, jwtVerify: vi.fn(async () => { throw new Error('bad'); }) } as never;
    const reply = makeReply();
    await requireAdmin(req, reply as never);
    expect(reply.statusCode).toBe(401);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('契約が切れた組織', () => {
  it('書き込みは 402 で止まり、role の判定まで進まない', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({ subscriptionStatus: 'canceled' });
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u-1', role: 'OWNER', status: 'ACTIVE', orgId: 'org-1', email: 'a@b.c',
    });
    const req = makeReq();
    const reply = makeReply();

    await requireOwner(req, reply as never);

    expect(reply.statusCode).toBe(402);
    // ⚠️ 契約で止めた時点で終わり。ここで role を引くと無駄なクエリが増える
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it('読み取りは契約を見ずに通す', async () => {
    prismaMock.organization.findUnique.mockResolvedValue({ subscriptionStatus: 'canceled' });
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'u-1', role: 'OWNER', status: 'ACTIVE', orgId: 'org-1', email: 'a@b.c',
    });
    const req = makeReq('u-1', 'GET', '/api/members');
    const reply = makeReply();

    await requireOwner(req, reply as never);

    expect(reply.statusCode).toBe(0);
    expect(prismaMock.organization.findUnique).not.toHaveBeenCalled();
  });
});
