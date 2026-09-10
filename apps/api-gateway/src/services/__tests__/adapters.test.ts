import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = {
  providerConnection: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  requiredCredential: { updateMany: vi.fn() },
  capability: { findMany: vi.fn(), update: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

process.env.CHANNEL_CREDENTIAL_ENC_KEY = 'a'.repeat(64); // 32byte hex
process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'csec';

const { NATIVE_PROVIDER_MAP, credentialProvidersFor, nativeProviderFor } = await import(
  '../adapters/provider-map'
);
const { authTest, postMessage } = await import('../adapters/slack-client');
const { buildSlidesRequests, createSheet } = await import('../adapters/google-client');
const { isTokenExpired, getGoogleAccessToken } = await import('../google-auth');
const { sealSecret } = await import('../secret-box');
const { getNativeAdapter } = await import('../adapters');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.capability.findMany.mockResolvedValue([]);
  prismaMock.requiredCredential.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.providerConnection.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.providerConnection.update.mockResolvedValue({});
});

describe('provider-map', () => {
  it('slack / google docs・sheets・slides のみ native 化される', () => {
    expect(Object.keys(NATIVE_PROVIDER_MAP).sort()).toEqual([
      'googledocs',
      'googleslides',
      'googlesheets',
      'slack',
    ].sort());
  });

  it('google_sheets(summarize_sheet) は意図的に非マップ = 従来の n8n 判定のまま', () => {
    expect(nativeProviderFor('google_sheets')).toBeNull();
    expect(nativeProviderFor('gmail')).toBeNull();
    expect(nativeProviderFor('x')).toBeNull();
  });

  it('逆引きは同じ provider の credential 名をすべて返す', () => {
    expect(credentialProvidersFor('google').sort()).toEqual(
      ['googledocs', 'googlesheets', 'googleslides'].sort(),
    );
    expect(credentialProvidersFor('slack')).toEqual(['slack']);
  });
});

describe('slack-client', () => {
  it('authTest は x-oauth-scopes ヘッダをスコープ配列にする', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => 'chat:write,chat:write.public' },
      json: async () => ({ ok: true, team_id: 'T1', team: 'FLOW社', user_id: 'U1' }),
    });

    const info = await authTest('xoxb-x');
    expect(info?.teamId).toBe('T1');
    expect(info?.scopes).toEqual(['chat:write', 'chat:write.public']);
  });

  it('authTest は ok:false を null にする（トークン不正）', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => '' },
      json: async () => ({ ok: false, error: 'invalid_auth' }),
    });
    expect(await authTest('xoxb-bad')).toBeNull();
  });

  it('postMessage: invalid_auth は authDead=true（再接続が必要）', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'invalid_auth' }) });
    const r = await postMessage('xoxb-x', '#g', 'hi');
    expect(r).toEqual({ ok: false, error: 'invalid_auth', authDead: true });
  });

  it('postMessage: channel_not_found は authDead=false（設定ミス）', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'channel_not_found' }) });
    const r = await postMessage('xoxb-x', '#none', 'hi');
    expect(r).toEqual({ ok: false, error: 'channel_not_found', authDead: false });
  });
});

describe('google-client', () => {
  it('buildSlidesRequests: スライドごとに createSlide + insertText を決定的な objectId で生成', () => {
    const reqs = buildSlidesRequests([
      { title: '表紙', content: '概要' },
      { title: '本編' },
    ]) as Record<string, Record<string, unknown>>[];

    expect(reqs).toHaveLength(5); // create+title+body, create+title
    expect(reqs[0].createSlide.objectId).toBe('slide_0');
    expect(reqs[1].insertText).toEqual({ objectId: 'slide_0_title', text: '表紙' });
    expect(reqs[2].insertText).toEqual({ objectId: 'slide_0_body', text: '概要' });
    expect(reqs[3].createSlide.objectId).toBe('slide_1');
    expect(reqs[4].insertText).toEqual({ objectId: 'slide_1_title', text: '本編' });
  });

  it('空配列なら何も生成しない', () => {
    expect(buildSlidesRequests([])).toEqual([]);
  });

  it('createSheet は headers + rows を A1 から RAW で書く', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ spreadsheetId: 'S1', spreadsheetUrl: 'https://sheet' }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const r = await createSheet('tok', '売上', ['月', '金額'], [['9月', '100']]);

    expect(r.ok).toBe(true);
    const valuesCall = fetchMock.mock.calls[1];
    expect(String(valuesCall[0])).toContain('/values/A1?valueInputOption=RAW');
    expect(JSON.parse(valuesCall[1].body).values).toEqual([
      ['月', '金額'],
      ['9月', '100'],
    ]);
  });

  it('401 は authDead としてマークされる', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    const r = await createSheet('tok', 'x', [], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.authDead).toBe(true);
  });
});

describe('google-auth', () => {
  it('isTokenExpired: 期限なし = 期限切れ扱い、スキュー内も期限切れ扱い', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    expect(isTokenExpired(null, now)).toBe(true);
    expect(isTokenExpired(new Date('2026-09-10T00:00:30Z'), now)).toBe(true); // 30秒後 < 60秒スキュー
    expect(isTokenExpired(new Date('2026-09-10T00:05:00Z'), now)).toBe(false);
  });

  it('期限内ならリフレッシュせず復号したトークンを返す', async () => {
    prismaMock.providerConnection.findUnique.mockResolvedValue({
      id: 'pc1',
      status: 'CONNECTED',
      accessTokenEnc: sealSecret('ya29.live'),
      refreshTokenEnc: sealSecret('rt'),
      tokenExpiresAt: new Date(Date.now() + 30 * 60_000),
    });

    const r = await getGoogleAccessToken('org-1');

    expect(r).toEqual({ ok: true, accessToken: 'ya29.live' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('期限切れならリフレッシュして保存する', async () => {
    prismaMock.providerConnection.findUnique.mockResolvedValue({
      id: 'pc1',
      status: 'CONNECTED',
      accessTokenEnc: sealSecret('old'),
      refreshTokenEnc: sealSecret('rt'),
      tokenExpiresAt: new Date(Date.now() - 60_000),
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'ya29.new', expires_in: 3600 }),
    });

    const r = await getGoogleAccessToken('org-1');

    expect(r).toEqual({ ok: true, accessToken: 'ya29.new' });
    expect(prismaMock.providerConnection.update).toHaveBeenCalled();
  });

  it('invalid_grant（取り消し/テストモード7日失効）は NEEDS_RECONNECT に落とす', async () => {
    prismaMock.providerConnection.findUnique.mockResolvedValue({
      id: 'pc1',
      status: 'CONNECTED',
      accessTokenEnc: sealSecret('old'),
      refreshTokenEnc: sealSecret('rt'),
      tokenExpiresAt: new Date(Date.now() - 60_000),
    });
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'invalid_grant' }) });

    const r = await getGoogleAccessToken('org-1');

    expect(r).toEqual({ ok: false, reason: 'NEEDS_RECONNECT' });
    const updateData = prismaMock.providerConnection.update.mock.calls[0][0].data;
    expect(updateData.status).toBe('NEEDS_RECONNECT');
  });

  it('未接続は NOT_CONNECTED', async () => {
    prismaMock.providerConnection.findUnique.mockResolvedValue(null);
    expect(await getGoogleAccessToken('org-1')).toEqual({ ok: false, reason: 'NOT_CONNECTED' });
  });
});

describe('adapter registry', () => {
  it('native 化された 4 capability だけ adapter を持つ', () => {
    expect(getNativeAdapter('notify_slack')).toBeTypeOf('function');
    expect(getNativeAdapter('create_google_doc')).toBeTypeOf('function');
    expect(getNativeAdapter('create_google_sheet')).toBeTypeOf('function');
    expect(getNativeAdapter('create_google_slides')).toBeTypeOf('function');
    // 従来 n8n 経路のまま
    expect(getNativeAdapter('draft_email')).toBeNull();
    expect(getNativeAdapter('send_email')).toBeNull();
    expect(getNativeAdapter('summarize_sheet')).toBeNull();
  });

  it('Slack 未接続なら外部 API を叩かず AUTH_MISSING を返す', async () => {
    prismaMock.providerConnection.findUnique.mockResolvedValue(null);
    const adapter = getNativeAdapter('notify_slack')!;

    const env = await adapter({ channel: '#g', text: 'hi' }, { orgId: 'org-1' });

    expect(env.status).toBe('error');
    expect(env.error_type).toBe('AUTH_MISSING');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Slack 接続済みなら chat.postMessage を叩いて success を返す', async () => {
    prismaMock.providerConnection.findUnique.mockResolvedValue({
      id: 'pc1',
      status: 'CONNECTED',
      accessTokenEnc: sealSecret('xoxb-live'),
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, channel: 'C1', ts: '1.0' }) });

    const env = await getNativeAdapter('notify_slack')!({ channel: '#g', text: 'hi' }, { orgId: 'org-1' });

    expect(env.status).toBe('success');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/chat.postMessage');
  });
});
