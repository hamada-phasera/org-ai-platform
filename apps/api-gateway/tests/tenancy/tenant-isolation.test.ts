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
// RAG の検索を通すときだけ埋め込みを有効にする（既定は無効 = 従来どおり no-op）
const embed = { enabled: false };
vi.mock('../../src/services/embeddings', async (orig) => {
  const actual = await orig<typeof import('../../src/services/embeddings')>();
  return {
    ...actual,
    isEmbeddingEnabled: () => embed.enabled,
    embedQuery: async () => (embed.enabled ? new Array(actual.EMBEDDING_DIM).fill(0.1) : null),
    embedTexts: async (texts: string[]) => (embed.enabled ? texts.map(() => new Array(actual.EMBEDDING_DIM).fill(0.1)) : null),
  };
});

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
  pages: (await import('../../src/routes/pages')).pageRoutes,
  n8nPages: (await import('../../src/routes/n8n-pages')).n8nPageRoutes,
};
const { hashPageToken } = await import('../../src/services/pages/page-token');
/** 業務ページの登録トークン（組織ごと）。生値はテストだけが知る */
const pageTokenOf = (X: 'A' | 'B') => `flowpg_${X.repeat(43)}`;

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
    auditEvent: [{ id: `audit-${X}`, orgId: org, actorId: `u-${X.toLowerCase()}`, action: 'member.role_change',
      targetType: 'user', targetId: `u-${X.toLowerCase()}`, meta: { role: 'ADMIN', note: `audit-meta-${X}` }, createdAt: now }],
    uploadedFile: [{ id: `file-${X}`, orgId: org, uploadedBy: 'x', originalName: `f${X}.txt`, storagePath: `${org}/f`,
      storageDriver: 'local', mimeType: 'text/plain', sizeBytes: 10, createdAt: now }],
    // 業務ページ（docs/design/custom-pages.md §11）。slug は組織ごとに一意なので、B だけが持つ slug で IDOR を見る
    customPage: [{ id: `page-${X}`, orgId: org, slug: `page-${X.toLowerCase()}-only`, title: `ページ${X}`, icon: 'inbox',
      sortOrder: 0, status: 'PUBLISHED', minRole: 'MEMBER', source: 'N8N', version: 1, schemaVersion: 1,
      definition: { blocks: [{ type: 'heading', text: `見出し${X}` }], actions: { list: { kind: 'query', hook: `hook-${X.toLowerCase()}` } } },
      definitionHash: `h-${X}`, sampleData: null, createdBy: null, updatedBy: null, createdAt: now, updatedAt: now }],
    pageToken: [{ id: `ptok-${X}`, orgId: org, label: `n8n${X}`, tokenHash: hashPageToken(pageTokenOf(X)), prefix: `flowpg_${X}${X}${X}`,
      lastUsedAt: null, revokedAt: null, createdBy: `u-${X.toLowerCase()}`, createdAt: now }],
    pageActionLog: [{ id: `plog-${X}`, orgId: org, pageId: `page-${X}`, slug: `page-${X.toLowerCase()}-only`, actionId: 'create',
      pageVersion: 1, actorId: `u-${X.toLowerCase()}`, requestId: `req-${X}`, status: 'OK', durationMs: 1, inputKeys: [], createdAt: now }],
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
  await a.register(routes.pages, { prefix: '/api/pages' });
  await a.register(routes.n8nPages, { prefix: '/api/webhooks/n8n/pages' });
  await a.ready();
  return a;
}

const token = (sub: string, orgId: string) => app.jwt.sign({ sub, orgId, role: 'OWNER', email: `${sub}@example.com` });
const as = (sub: string, orgId: string) => ({ authorization: `Bearer ${token(sub, orgId)}` });

beforeEach(async () => {
  embed.enabled = false;
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
  // CustomPage（B だけが持つ slug）/ PageToken。PUT は「A に新しく作る」になるので I-4 で見る
  ['GET', '/api/pages/page-b-only'],
  ['PATCH', '/api/pages/page-b-only', { status: 'DRAFT' }],
  ['DELETE', '/api/pages/page-b-only'],
  ['DELETE', '/api/pages/tokens/ptok-B'],
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
  '/api/governance/audit',
  '/api/sns/posts/queue',
  '/api/sns/posts/calendar',
  '/api/organizations/me',
  '/api/pages',
  '/api/pages/admin/list',
  '/api/pages/tokens',
];

/** B のデータに固有の文字列（id・中身）。応答に1つでも出たら漏えい */
const B_MARKERS = [
  'org-B', 'task-B', 'sns-B', 'agent-B', 'project-B', 'vendor-B', 'cost-B', 'deal-B', 'cap-B', 'cap_B', 'gap-B', 'exec-B',
  'st-B', 'session-B', 'secret-B', 'conn-B', 'inbound-B', 'hello-B', 'pc-B', 'WSB', 'inv-B', 'invB@', 'risk-B',
  'prompt-B', 'file-B', 'audit-B', 'audit-meta-B', 'AgentB', '工事B', '業者B', '商談B', 'B社', 'u-b', 'b@example.com',
  'page-B', 'page-b-only', 'ページB', '見出しB', 'hook-b', 'ptok-B', 'flowpg_BBB', 'n8nB', 'plog-B',
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

describe('業務ページ（docs/design/custom-pages.md §11 テナント分離）', () => {
  const bPages = () =>
    JSON.stringify([...fake.rows('customPage'), ...fake.rows('pageToken'), ...fake.rows('pageActionLog')].filter((r) => r.orgId === 'org-B'));
  const def = { blocks: [{ type: 'heading', text: '新規' }], actions: {} };

  it('A のトークン（JWT）で B と同じ slug を PUT しても A に作られ、B は 1 バイトも変わらない', async () => {
    fake.rows('organization').find((o) => o.id === 'org-A')!.plan = 'PRO';
    const before = bPages();
    const res = await app.inject({
      method: 'PUT', url: '/api/pages/page-b-only', headers: as('u-a', 'org-A'), payload: { title: '同名', definition: def },
    });
    expect(res.statusCode).toBe(201);
    expect(fake.rows('customPage').filter((p) => p.slug === 'page-b-only').map((p) => p.orgId).sort()).toEqual(['org-A', 'org-B']);
    expect(bPages()).toBe(before);
  });

  it('A の登録トークンで B と同じ slug を登録しても A に作られ、B は 1 バイトも変わらない', async () => {
    fake.rows('organization').find((o) => o.id === 'org-A')!.plan = 'PRO';
    const before = bPages();
    const res = await app.inject({
      method: 'PUT', url: '/api/webhooks/n8n/pages/page-b-only', headers: { 'x-page-token': pageTokenOf('A') },
      payload: { title: '同名', definition: def },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('org-B');
    expect(bPages()).toBe(before);
  });

  it('A の登録トークンで B のページは消せず、一覧にも出ない', async () => {
    const before = bPages();
    const del = await app.inject({
      method: 'DELETE', url: '/api/webhooks/n8n/pages/page-b-only', headers: { 'x-page-token': pageTokenOf('A') },
    });
    expect(del.json().data).toEqual({ deleted: false });
    const list = await app.inject({ method: 'GET', url: '/api/webhooks/n8n/pages', headers: { 'x-page-token': pageTokenOf('A') } });
    expect(list.body).toContain('page-a-only');
    expect(list.body).not.toContain('page-b-only');
    expect(bPages()).toBe(before);
  });

  it('JWT（ユーザーのトークン）では登録経路を使えない', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/webhooks/n8n/pages/x-page', headers: as('u-a', 'org-A'), payload: { title: 'x', definition: def },
    });
    expect(res.statusCode).toBe(401);
  });

  it('両方に所属する c でも、A のトークンでは B のページが 404、B のトークンでだけ見える', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/pages/page-b-only', headers: as('u-c', 'org-A') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/pages/page-b-only', headers: as('u-c', 'org-B') })).statusCode).toBe(200);
  });

  it('自分のページの定義を開いても hook は返らない（T17）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages/page-a-only', headers: as('u-a', 'org-A') });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('hook-a');
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

// ── services 経由の経路（チャンク 10: services を tenantDb にしたことの確認） ──
// ルートを通らない実行（エージェントのステップ実行・RAG の検索・LINE の取り込み）でも、
// 組織 A として動いている処理が B の行を読まない・書かないことを確かめる。

const services = {
  stepRunner: await import('../../src/services/step-runner'),
  rag: await import('../../src/services/rag'),
  lineInbox: await import('../../src/services/inbox/line-inbox'),
  draft: await import('../../src/services/inbox/draft-generator'),
  receipt: await import('../../src/services/inbox/receipt-capture'),
  lifecycle: await import('../../src/services/lifecycle-core'),
  tenancy: await import('../../src/tenancy/tenant-db'),
};

/** B の行（orgId が org-B、または B の組織そのもの）だけを取り出したスナップショット。 */
function bRows(): string {
  const all = JSON.parse(fake.snapshot()) as Record<string, { orgId?: string; id: string }[]>;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(all)
        .map(([t, rows]) => [t, rows.filter((r) => r.orgId === 'org-B' || r.id === 'org-B')] as const)
        // 処理中に初めて触られた表（空）は差分に数えない
        .filter(([, rows]) => rows.length > 0),
    ),
  );
}

/** tracked() で起動したバックグラウンド処理（下書き生成など）が終わるのを待つ。次のテストの fake に書かせない */
async function settle(): Promise<void> {
  await vi.waitFor(() => expect(services.lifecycle.jobs.size).toBe(0));
}

describe('S-1: エージェント実行（step-runner → capability-resolver）', () => {
  const agentA = { id: 'agent-A', instructions: 'do', department: 'GENERAL', createdBy: 'u-a' };

  it('A のエージェントが B のケイパビリティ名を指しても見つからず、B の行は変わらない', async () => {
    const before = bRows();
    await services.stepRunner.runAgentTask(
      { id: 'task-A', orgId: 'org-A', input: 'x' },
      { ...agentA, steps: [{ capabilityName: 'cap_B' }] },
    );
    const task = fake.rows('task').find((r) => r.id === 'task-A')!;
    expect(task.status).toBe('FAILED');
    expect(String(task.lastError)).toContain('capability が見つかりません');
    expect(bRows()).toBe(before);
    // 未対応の記録（CapabilityGap。管理者通知の分を含む）も A にだけ積まれる
    const gaps = fake.rows('capabilityGap').filter((r) => String(r.id).startsWith('new-'));
    expect(gaps.length).toBeGreaterThan(0);
    expect(new Set(gaps.map((g) => g.orgId))).toEqual(new Set(['org-A']));
  });

  it('A として B の Task の承認再開を呼んでも、B の Task は動かない', async () => {
    fake.rows('task').find((r) => r.id === 'task-B')!.status = 'RUNNING';
    const before = bRows();
    await services.stepRunner.resumeAgentTask('task-B', { orgId: 'org-A' });
    expect(bRows()).toBe(before);
  });
});

describe('S-2: RAG の検索（raw SQL）', () => {
  it('検索の SQL はすべて A の orgId を束ね、B の orgId を含まない', async () => {
    embed.enabled = true;
    fake.rawCalls.length = 0;
    const res = await services.rag.retrieveContext({ orgId: 'org-A', query: '見積', fileIds: ['file-B'] });
    expect(res).toBeNull(); // 偽 DB の raw SQL は 0 行
    expect(fake.rawCalls.length).toBe(2);
    for (const call of fake.rawCalls) {
      const sql = call[0] as { strings?: readonly string[]; values?: unknown[] };
      expect((sql.strings ?? []).join('?')).toContain('"orgId"');
      expect(sql.values).toContain('org-A');
      expect(sql.values).not.toContain('org-B');
    }
  });

  it('索引の書き込みも A の orgId で行う', async () => {
    embed.enabled = true;
    fake.rawCalls.length = 0;
    await services.rag.indexMessages('org-A', 'session-A', [{ messageId: 'msg-A', role: 'user', content: '十分な長さのある本文をここに書きます。' }]);
    expect(fake.rawCalls.length).toBe(1);
    expect(fake.rawCalls[0]).toContain('org-A');
    expect(fake.rawCalls[0]).not.toContain('org-B');
  });
});

describe('S-3: LINE の受信（line-inbox → draft-generator / receipt-capture）', () => {
  const event = {
    type: 'message',
    webhookEventId: 'ev-new',
    timestamp: now.getTime(),
    source: { type: 'user', userId: 'U9' },
    message: { id: 'line-msg', type: 'text', text: '見積をください' },
  } as const;

  it('接続 A の受信は A に積まれ、B の接続・受信は変わらない', async () => {
    const before = bRows();
    await services.lineInbox.processLineEvents({ id: 'conn-A', orgId: 'org-A', accessTokenEnc: 'enc' }, [event]);
    await settle();
    const created = fake.rows('inboundMessage').filter((r) => String(r.id).startsWith('new-'));
    expect(created.map((r) => r.orgId)).toEqual(['org-A']);
    expect(fake.rows('channelConnection').find((r) => r.id === 'conn-A')!.lastEventAt).toBeInstanceOf(Date);
    expect(bRows()).toBe(before);
  });

  it('組織と食い違う接続（id が B・orgId が A）では B の接続を更新しない', async () => {
    const before = bRows();
    await services.lineInbox.processLineEvents({ id: 'conn-B', orgId: 'org-A', accessTokenEnc: 'enc' }, [event]);
    await settle();
    expect(bRows()).toBe(before);
  });

  it('A のクライアントで B の受信の下書きを作り直そうとしても、B の受信は変わらない', async () => {
    const before = bRows();
    await services.draft.generateInboxDraft(services.tenancy.tenantDb('org-A'), 'inbound-B', { allowRegenerate: true });
    expect(bRows()).toBe(before);
  });

  it('領収書の工事・取引先の照合は A の中だけ（B の工事名・番号・業者名は当たらない）', async () => {
    expect(await services.receipt.matchProject('org-A', '工事B')).toBeNull();
    expect(await services.receipt.matchProject('org-A', 'K-B')).toBeNull();
    expect(await services.receipt.matchVendor('org-A', '業者B')).toBeNull();
    // 絞りすぎていない
    expect((await services.receipt.matchProject('org-A', 'K-A'))?.id).toBe('project-A');
    expect((await services.receipt.matchVendor('org-A', '業者A'))?.id).toBe('vendor-A');
  });
});
