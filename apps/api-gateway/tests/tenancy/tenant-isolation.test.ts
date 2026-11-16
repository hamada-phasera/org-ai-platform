import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { FakePrisma } from '../helpers/fake-prisma';

// 組織分離テスト（IDOR）。docs/design/multi-tenancy.md §11.5
//
// 本物の requireAuth / requireRole / tenantDb を通し、DB だけをメモリ内の偽 Prisma に差し替える。
// 組織 A（ユーザー a）と組織 B（ユーザー b）のデータを置き、a のトークンで B の id を指定しても
//   I-1 GET / PUT / PATCH / DELETE が 404 で、B のデータが1バイトも変わらない
//   I-2 一覧に B の行が混ざらない
//   I-3 A と B の両方に所属する c でも、A のトークンでは B が 404、B のトークンでだけ見える
//   I-4 body に orgId: 'org-B' を混ぜても A に作られる
//   I-5 B の行を参照する作成（projectId / vendorId / agentId）は通らない
// ことを確かめる。外部（ai-engine・n8n・Stripe・LINE・保存先）は呼ばれても失敗するようにしてある。

let fake: FakePrisma;
vi.mock('../../src/utils/prisma', () => ({
  get prisma() {
    return fake;
  },
}));
vi.mock('../../src/services/storage/driver', () => ({
  currentDriverName: () => 'local',
  readDriver: () => ({ name: 'local', get: async () => null, delete: async () => {}, exists: async () => false }),
  writeDriver: () => ({ name: 'local', put: async () => {}, delete: async () => {} }),
}));
vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'down' }), { status: 503 })));

const { registerTenantContext } = await import('../../src/tenancy/context');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const routes = {
  tasks: (await import('../../src/routes/tasks')).taskRoutes,
  agents: (await import('../../src/routes/agents')).agentRoutes,
  chat: (await import('../../src/routes/chat')).chatRoutes,
  files: (await import('../../src/routes/files')).fileRoutes,
  accounting: (await import('../../src/routes/accounting')).accountingRoutes,
  pipeline: (await import('../../src/routes/sales/pipeline')).salesPipelineRoutes,
  capabilities: (await import('../../src/routes/capabilities')).capabilityRoutes,
  scheduled: (await import('../../src/routes/scheduled-tasks')).scheduledTaskRoutes,
  inboxMessages: (await import('../../src/routes/inbox/messages')).inboxMessagesRoutes,
  inboxConnections: (await import('../../src/routes/inbox/connections')).inboxConnectionsRoutes,
  integrations: (await import('../../src/routes/integrations')).integrationsRoutes,
  members: (await import('../../src/routes/members')).memberRoutes,
  governance: (await import('../../src/routes/governance')).governanceRoutes,
  sns: (await import('../../src/routes/sns/posts')).snsPostsRoutes,
  organizations: (await import('../../src/routes/organizations')).organizationRoutes,
};

const SECRET = 'tenant-isolation-test-secret-32-chars!!';
const now = new Date('2026-11-01T00:00:00Z');

function orgData(X: 'A' | 'B') {
  const org = `org-${X}`;
  return {
    organization: [{
      id: org, name: `${X}社`, plan: 'STARTER', billingEmail: null, subscriptionStatus: null,
      storageUsedBytes: BigInt(0), storageAddonUnits: 0, createdAt: now,
    }],
    task: [
      { id: `task-${X}`, orgId: org, title: `T${X}`, status: 'PENDING_APPROVAL', department: 'GENERAL', taskType: 'agent',
        input: 'in', output: null, approvalData: null, agentId: `agent-${X}`, executionResult: null, createdAt: now, updatedAt: now },
      { id: `sns-${X}`, orgId: org, title: `S${X}`, status: 'PENDING_APPROVAL', department: 'MARKETING', taskType: 'sns',
        input: 'in', output: '{}', approvalData: null, agentId: null, scheduledAt: null, createdAt: now, updatedAt: now },
    ],
    agent: [{ id: `agent-${X}`, orgId: org, name: `Agent${X}`, description: null, department: 'GENERAL', instructions: 'do',
      steps: null, trigger: 'MANUAL', enabled: true, n8nStatus: 'FALLBACK_ONLY', webhookPath: null, n8nWorkflowId: null,
      icon: null, color: null, createdBy: `u-${X.toLowerCase()}`, createdAt: now, updatedAt: now }],
    project: [{ id: `project-${X}`, orgId: org, code: `K-${X}`, name: `工事${X}`, client: null, contractAmount: 100,
      startOn: null, dueOn: null, status: 'IN_PROGRESS', budgetMaterial: 0, budgetLabor: 0, budgetSubcon: 0, budgetOther: 0,
      progressRate: 0, note: null, createdAt: now, updatedAt: now }],
    vendor: [{ id: `vendor-${X}`, orgId: org, name: `業者${X}`, kind: 'SUBCON', invoiceRegistered: false, invoiceNumber: null,
      note: null, createdAt: now, updatedAt: now }],
    costEntry: [{ id: `cost-${X}`, orgId: org, projectId: `project-${X}`, vendorId: `vendor-${X}`, incurredOn: now,
      category: 'MATERIAL', amount: 10, taxAmount: 1, description: null, source: 'MANUAL', status: 'DRAFT', createdBy: null,
      createdAt: now, updatedAt: now }],
    deal: [{ id: `deal-${X}`, orgId: org, title: `商談${X}`, company: null, amount: 1, stage: 'LEAD', ownerId: null,
      createdAt: now, updatedAt: now }],
    capability: [{ id: `cap-${X}`, orgId: org, name: `cap_${X}`, displayName: `Cap${X}`, description: 'd', department: 'GENERAL',
      inputSchema: {}, status: 'ACTIVE', n8nWorkflowId: null, webhookPath: null, kind: 'http', httpConfig: null, createdBy: null,
      createdAt: now, updatedAt: now }],
    capabilityGap: [{ id: `gap-${X}`, orgId: org, requestedBy: 'x', rawRequest: `gap${X}`, inferredName: `gap_${X}`, count: 1,
      createdAt: now, updatedAt: now }],
    executionLog: [{ id: `exec-${X}`, orgId: org, capabilityId: `cap-${X}`, status: 'success', errorType: null, requestArgs: {},
      responseData: null, createdAt: now }],
    scheduledTask: [{ id: `st-${X}`, orgId: org, title: `定期${X}`, department: 'GENERAL', taskType: 'agent', input: 'i',
      recipientEmail: null, frequency: 'daily', hourUtc: 0, dayOfWeek: null, dayOfMonth: null, enabled: true, lastRunAt: null,
      agentId: `agent-${X}`, createdAt: now, updatedAt: now }],
    chatSession: [{ id: `session-${X}`, orgId: org, title: `会話${X}`, createdAt: now }],
    message: [{ id: `msg-${X}`, sessionId: `session-${X}`, role: 'user', content: `secret-${X}`, department: null, createdAt: now }],
    channelConnection: [{ id: `conn-${X}`, orgId: org, provider: 'line', channelId: `line-${X}`, displayName: `LINE${X}`,
      channelSecretEnc: 'enc', accessTokenEnc: 'enc', status: 'ACTIVE', monthlyPushCount: 0, pushCountMonth: null,
      lastEventAt: null, lastCheckedAt: null, createdAt: now, updatedAt: now }],
    inboundMessage: [{ id: `inbound-${X}`, orgId: org, connectionId: `conn-${X}`, provider: 'line', webhookEventId: `ev-${X}`,
      sourceType: 'user', groupId: null, lineUserId: 'U', senderName: 'S', messageType: 'text', text: `hello-${X}`,
      status: 'DRAFTED', draft: 'd', receivedAt: now, createdAt: now, updatedAt: now }],
    providerConnection: [{ id: `pc-${X}`, orgId: org, provider: 'slack', accessTokenEnc: 'enc', refreshTokenEnc: null,
      tokenExpiresAt: null, scopes: null, externalAccountId: `T${X}`, displayName: `WS${X}`, status: 'CONNECTED',
      lastCheckedAt: null, createdAt: now, updatedAt: now }],
    invitation: [{ id: `inv-${X}`, orgId: org, email: `inv${X}@example.com`, role: 'MEMBER', tokenHash: `hash-${X}`,
      expiresAt: new Date('2099-01-01'), acceptedAt: null, acceptedBy: null, revokedAt: null, createdBy: 'x', createdAt: now }],
    riskEvent: [{ id: `risk-${X}`, orgId: org, aiLogId: null, type: 'PII', description: `risk-${X}`, severity: 'HIGH',
      resolved: false, createdAt: now }],
    aILog: [{ id: `ailog-${X}`, orgId: org, department: 'GENERAL', provider: 'x', model: 'm', inputText: `prompt-${X}`,
      outputText: null, tokens: 1, latencyMs: 1, riskScore: 0, createdAt: now }],
    uploadedFile: [{ id: `file-${X}`, orgId: org, uploadedBy: 'x', originalName: `f${X}.txt`, storagePath: `${org}/f`,
      storageDriver: 'local', mimeType: 'text/plain', sizeBytes: 10, createdAt: now }],
  };
}

function seed(): Record<string, Record<string, unknown>[]> {
  const a = orgData('A');
  const b = orgData('B');
  const merged: Record<string, Record<string, unknown>[]> = {};
  for (const k of Object.keys(a) as (keyof typeof a)[]) merged[k] = [...a[k], ...b[k]];
  merged.user = [
    { id: 'u-a', email: 'a@example.com', name: 'a', status: 'ACTIVE', role: 'OWNER', orgId: 'org-A', createdAt: now },
    { id: 'u-b', email: 'b@example.com', name: 'b', status: 'ACTIVE', role: 'OWNER', orgId: 'org-B', createdAt: now },
    { id: 'u-c', email: 'c@example.com', name: 'c', status: 'ACTIVE', role: 'OWNER', orgId: 'org-A', createdAt: now },
  ];
  merged.membership = [
    { id: 'm-a', userId: 'u-a', orgId: 'org-A', role: 'OWNER', status: 'ACTIVE', createdAt: now },
    { id: 'm-b', userId: 'u-b', orgId: 'org-B', role: 'OWNER', status: 'ACTIVE', createdAt: now },
    { id: 'm-cA', userId: 'u-c', orgId: 'org-A', role: 'OWNER', status: 'ACTIVE', createdAt: now },
    { id: 'm-cB', userId: 'u-c', orgId: 'org-B', role: 'OWNER', status: 'ACTIVE', createdAt: now },
  ];
  return merged;
}

let app: FastifyInstance;
async function build(): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(jwt, { secret: SECRET });
  registerTenantContext(a);
  await a.register(routes.tasks, { prefix: '/api/tasks' });
  await a.register(routes.agents, { prefix: '/api/agents' });
  await a.register(routes.chat, { prefix: '/api/chat' });
  await a.register(routes.files, { prefix: '/api/files' });
  await a.register(routes.accounting, { prefix: '/api/accounting' });
  await a.register(routes.pipeline, { prefix: '/api/sales/pipeline' });
  await a.register(routes.capabilities, { prefix: '/api/capabilities' });
  await a.register(routes.scheduled, { prefix: '/api/scheduled-tasks' });
  await a.register(routes.inboxMessages, { prefix: '/api/inbox/messages' });
  await a.register(routes.inboxConnections, { prefix: '/api/inbox/connections' });
  await a.register(routes.integrations, { prefix: '/api/integrations' });
  await a.register(routes.members, { prefix: '/api/members' });
  await a.register(routes.governance, { prefix: '/api/governance' });
  await a.register(routes.sns, { prefix: '/api/sns/posts' });
  await a.register(routes.organizations, { prefix: '/api/organizations' });
  await a.ready();
  return a;
}

const token = (sub: string, orgId: string) => app.jwt.sign({ sub, orgId, role: 'OWNER', email: `${sub}@example.com` });
const as = (sub: string, orgId: string) => ({ authorization: `Bearer ${token(sub, orgId)}` });

beforeEach(async () => {
  fake = new FakePrisma(seed());
  clearMembershipCache();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  if (!app) app = await build();
});

type Req = [method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: Record<string, unknown>];

/** I-1: a（組織 A）のトークンで B のリソースを id 指定する。すべて 404 で、B は1件も変わらない。 */
const IDOR_CASES: Req[] = [
  // Task
  ['GET', '/api/tasks/task-B'],
  ['PATCH', '/api/tasks/task-B', { title: '書き換え' }],
  ['DELETE', '/api/tasks/task-B'],
  ['POST', '/api/tasks/task-B/approve', {}],
  ['POST', '/api/tasks/task-B/reject', { reason: 'x' }],
  ['POST', '/api/tasks/task-B/logs', { message: '注入' }],
  // Agent
  ['GET', '/api/agents/agent-B'],
  ['PATCH', '/api/agents/agent-B', { name: '乗っ取り' }],
  ['DELETE', '/api/agents/agent-B'],
  ['POST', '/api/agents/agent-B/run', { input: 'x' }],
  // UploadedFile
  ['GET', '/api/files/file-B'],
  ['POST', '/api/files/file-B/analyze', { question: 'q' }],
  ['DELETE', '/api/files/file-B'],
  // Project / CostEntry / Vendor
  ['GET', '/api/accounting/projects/project-B'],
  ['PATCH', '/api/accounting/projects/project-B', { name: '書き換え' }],
  ['DELETE', '/api/accounting/projects/project-B'],
  ['PATCH', '/api/accounting/costs/cost-B', { description: '書き換え' }],
  ['DELETE', '/api/accounting/costs/cost-B'],
  ['PATCH', '/api/accounting/vendors/vendor-B', { name: '書き換え' }],
  ['DELETE', '/api/accounting/vendors/vendor-B'],
  // Deal
  ['GET', '/api/sales/pipeline/deal-B'],
  ['PATCH', '/api/sales/pipeline/deal-B', { title: '書き換え' }],
  // Capability
  ['PATCH', '/api/capabilities/cap-B', { displayName: '書き換え' }],
  ['DELETE', '/api/capabilities/cap-B'],
  ['POST', '/api/capabilities/cap-B/test', {}],
  // ScheduledTask
  ['PATCH', '/api/scheduled-tasks/st-B', { title: '書き換え' }],
  ['DELETE', '/api/scheduled-tasks/st-B'],
  // ChatSession / Message
  ['GET', '/api/chat/sessions/session-B/messages'],
  ['POST', '/api/chat/sessions/session-B/messages', { content: 'x' }],
  ['POST', '/api/chat/sessions/session-B/messages/stream', { content: 'x' }],
  ['POST', '/api/chat/sessions/session-B/suggest', {}],
  // InboundMessage
  ['POST', '/api/inbox/messages/inbound-B/approve', { replyText: 'x' }],
  ['POST', '/api/inbox/messages/inbound-B/reject', { reason: 'x' }],
  ['POST', '/api/inbox/messages/inbound-B/regenerate', {}],
  // ChannelConnection
  ['DELETE', '/api/inbox/connections/conn-B'],
  // Invitation
  ['DELETE', '/api/members/invitations/inv-B'],
  // Member（Membership）: B のユーザーを指定
  ['PATCH', '/api/members/u-b/role', { role: 'MEMBER' }],
  ['PATCH', '/api/members/u-b/status', { status: 'DISABLED' }],
  // RiskEvent
  ['PATCH', '/api/governance/risks/risk-B/resolve'],
  // SNS（Task）
  ['POST', '/api/sns/posts/sns-B/approve', {}],
  ['POST', '/api/sns/posts/sns-B/reject', { reason: 'x' }],
  ['PATCH', '/api/sns/posts/sns-B/schedule', { scheduledAt: '2026-12-01T00:00:00.000Z' }],
];

/** I-2: 一覧。応答のどこにも B の行（id・中身）が出てこない。 */
const LIST_CASES: string[] = [
  '/api/tasks',
  '/api/agents',
  '/api/agents/stats',
  '/api/files',
  '/api/accounting/projects',
  '/api/accounting/costs',
  '/api/accounting/costs?projectId=project-B',
  '/api/accounting/vendors',
  '/api/accounting/summary',
  '/api/sales/pipeline',
  '/api/capabilities',
  '/api/capabilities/gaps',
  '/api/capabilities/execution-logs',
  '/api/scheduled-tasks',
  '/api/chat/sessions',
  '/api/chat/search?q=secret',
  '/api/inbox/messages',
  '/api/inbox/connections',
  '/api/integrations',
  '/api/members',
  '/api/members/invitations',
  '/api/governance/risks',
  '/api/governance/logs',
  '/api/governance/stats',
  '/api/sns/posts/queue',
  '/api/sns/posts/calendar',
  '/api/organizations/me',
];

/** B のデータに固有の文字列（id・中身）。応答に1つでも出たら漏えい */
const B_MARKERS = [
  'org-B', 'task-B', 'sns-B', 'agent-B', 'project-B', 'vendor-B', 'cost-B', 'deal-B', 'cap-B', 'cap_B', 'gap-B', 'exec-B',
  'st-B', 'session-B', 'secret-B', 'conn-B', 'inbound-B', 'hello-B', 'pc-B', 'WSB', 'inv-B', 'invB@', 'risk-B',
  'prompt-B', 'file-B', 'AgentB', '工事B', '業者B', '商談B', 'B社', 'u-b', 'b@example.com',
];

describe('I-1: 他組織のリソースを id 指定しても 404（存在を漏らさない）、書き込みは0件', () => {
  it.each(IDOR_CASES)('%s %s', async (method, url, body) => {
    const before = fake.snapshot();
    const res = await app.inject({ method, url, headers: as('u-a', 'org-A'), ...(body ? { payload: body } : {}) });
    expect(res.statusCode).toBe(404);
    for (const m of B_MARKERS.filter((x) => x !== 'org-B')) expect(res.body).not.toContain(m);
    // B の行は（どのテーブルも）1バイトも変わっていない
    const after = JSON.parse(fake.snapshot()) as Record<string, { orgId?: string; id: string }[]>;
    const beforeObj = JSON.parse(before) as typeof after;
    for (const table of Object.keys(beforeObj)) {
      const pick = (rows: { orgId?: string; id: string; userId?: string }[]) =>
        rows.filter((r) => r.orgId === 'org-B' || r.id === 'org-B' || r.userId === 'u-b');
      expect(pick(after[table] ?? [])).toEqual(pick(beforeObj[table]));
    }
  });
});

describe('I-2: 一覧に他組織の行が混ざらない', () => {
  it.each(LIST_CASES)('GET %s', async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: as('u-a', 'org-A') });
    expect(res.statusCode).toBe(200);
    for (const m of B_MARKERS) expect(res.body).not.toContain(m);
  });

  it('一覧には自分の組織の行は出る（絞りすぎて空になっていない）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: as('u-a', 'org-A') });
    expect(res.body).toContain('task-A');
    const p = await app.inject({ method: 'GET', url: '/api/accounting/projects', headers: as('u-a', 'org-A') });
    expect(p.body).toContain('project-A');
  });
});

describe('I-3: 両方に所属するユーザーでも、トークンの組織だけが見える', () => {
  const SINGLES = ['/api/tasks/task-B', '/api/agents/agent-B', '/api/accounting/projects/project-B', '/api/sales/pipeline/deal-B'];
  it.each(SINGLES)('%s', async (url) => {
    const withA = await app.inject({ method: 'GET', url, headers: as('u-c', 'org-A') });
    expect(withA.statusCode).toBe(404);
    const withB = await app.inject({ method: 'GET', url, headers: as('u-c', 'org-B') });
    expect(withB.statusCode).toBe(200);
  });
});

describe('I-4: body の orgId で作成先の組織を変えられない', () => {
  const CREATES: [string, Record<string, unknown>, string][] = [
    ['/api/tasks', { title: 'x', department: 'GENERAL', input: 'i', orgId: 'org-B' }, 'task'],
    ['/api/sales/pipeline', { title: 'x', orgId: 'org-B' }, 'deal'],
    ['/api/accounting/projects', { code: 'K-NEW', name: 'x', orgId: 'org-B' }, 'project'],
    ['/api/accounting/vendors', { name: '新業者', orgId: 'org-B' }, 'vendor'],
    ['/api/chat/sessions', { title: 'x', orgId: 'org-B' }, 'chatSession'],
  ];
  it.each(CREATES)('POST %s', async (url, body, table) => {
    const res = await app.inject({ method: 'POST', url, headers: as('u-a', 'org-A'), payload: body });
    expect(res.statusCode).toBeLessThan(300);
    const created = fake.rows(table).filter((r) => String(r.id).startsWith('new-'));
    expect(created.length).toBe(1);
    expect(created[0].orgId).toBe('org-A');
  });
});

describe('I-5: 他組織の行を参照して作れない（I3）', () => {
  it('B の工事に原価を付けられない', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/accounting/costs', headers: as('u-a', 'org-A'),
      payload: { projectId: 'project-B', incurredOn: '2026-11-01', category: 'MATERIAL', amount: 1 },
    });
    expect([400, 404]).toContain(res.statusCode);
    expect(fake.rows('costEntry').some((r) => String(r.id).startsWith('new-'))).toBe(false);
  });

  it('B の業者を自社の原価に付けられない', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/accounting/costs', headers: as('u-a', 'org-A'),
      payload: { projectId: 'project-A', vendorId: 'vendor-B', incurredOn: '2026-11-01', category: 'MATERIAL', amount: 1 },
    });
    expect([400, 404]).toContain(res.statusCode);
    expect(fake.rows('costEntry').some((r) => String(r.id).startsWith('new-'))).toBe(false);
  });

  it('B のエージェントで定期実行を作れない / 付け替えられない', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/scheduled-tasks', headers: as('u-a', 'org-A'),
      payload: { title: 'x', department: 'GENERAL', taskType: 'agent', input: 'i', frequency: 'daily', hourUtc: 1, agentId: 'agent-B' },
    });
    expect([400, 404]).toContain(create.statusCode);
    expect(fake.rows('scheduledTask').some((r) => String(r.id).startsWith('new-'))).toBe(false);

    const patch = await app.inject({
      method: 'PATCH', url: '/api/scheduled-tasks/st-A', headers: as('u-a', 'org-A'), payload: { agentId: 'agent-B' },
    });
    expect([400, 404]).toContain(patch.statusCode);
    expect(fake.rows('scheduledTask').find((r) => r.id === 'st-A')?.agentId).toBe('agent-A');
  });

  it('まとめて確定に B の原価 id を混ぜても B は確定されない', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/accounting/costs/confirm', headers: as('u-a', 'org-A'), payload: { ids: ['cost-A', 'cost-B'] },
    });
    expect(res.json().data.confirmed).toBe(1);
    expect(fake.rows('costEntry').find((r) => r.id === 'cost-B')?.status).toBe('DRAFT');
  });

  it('連携の解除は自分の組織の接続だけ（B の Slack 接続は残る）', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/integrations/slack', headers: as('u-a', 'org-A') });
    expect(res.statusCode).toBe(200);
    expect(fake.rows('providerConnection').map((r) => r.id)).toEqual(['pc-B']);
  });
});

describe('締め出し', () => {
  it('Membership を無効化されたユーザーは、その組織のトークンで 403 TENANT_ACCESS_REVOKED', async () => {
    fake.rows('membership').find((m) => m.id === 'm-cB')!.status = 'DISABLED';
    const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: as('u-c', 'org-B') });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_ACCESS_REVOKED');
    // 他の組織（A）は今までどおり使える
    const other = await app.inject({ method: 'GET', url: '/api/tasks', headers: as('u-c', 'org-A') });
    expect(other.statusCode).toBe(200);
  });

  it('Membership を消されたユーザーも 403', async () => {
    fake.tables.membership = fake.rows('membership').filter((m) => m.id !== 'm-cB');
    const res = await app.inject({ method: 'GET', url: '/api/agents', headers: as('u-c', 'org-B') });
    expect(res.statusCode).toBe(403);
  });

  it('所属していない組織のトークン（偽造ではなく、外された後の古いトークン）は 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: as('u-a', 'org-B') });
    expect(res.statusCode).toBe(403);
  });

  it('アカウントを無効化されたユーザーは 401', async () => {
    fake.rows('user').find((u) => u.id === 'u-a')!.status = 'DISABLED';
    const res = await app.inject({ method: 'GET', url: '/api/tasks', headers: as('u-a', 'org-A') });
    expect(res.statusCode).toBe(401);
  });

  it('メンバー管理で無効化すると、キャッシュを待たずに締め出される', async () => {
    // c は B で一度アクセスしてキャッシュに乗る
    expect((await app.inject({ method: 'GET', url: '/api/tasks', headers: as('u-c', 'org-B') })).statusCode).toBe(200);
    // B のオーナー b が c を無効化
    const off = await app.inject({
      method: 'PATCH', url: '/api/members/u-c/status', headers: as('u-b', 'org-B'), payload: { status: 'DISABLED' },
    });
    expect(off.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/tasks', headers: as('u-c', 'org-B') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/tasks', headers: as('u-c', 'org-A') })).statusCode).toBe(200);
  });
});

describe('ai-engine への伝播（I11）', () => {
  it('HTTP リクエストから呼ぶ ai-engine には、トークンの組織が X-Org-Id で付き、body の org_id と一致する', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    await app.inject({
      method: 'POST', url: '/api/chat/sessions/session-A/messages', headers: as('u-a', 'org-A'), payload: { content: 'こんにちは' },
    });
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/orchestrate'));
    expect(call).toBeDefined();
    const init = call![1] as { headers: Record<string, string>; body: string };
    expect(init.headers['X-Org-Id']).toBe('org-A');
    expect(JSON.parse(init.body).org_id).toBe('org-A');
  });
});
