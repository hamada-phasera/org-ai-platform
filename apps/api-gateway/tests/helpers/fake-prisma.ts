// 組織分離テスト用のメモリ内の偽 Prisma（docs/design/multi-tenancy.md §11.5）。
//
// テナントクライアント（tenantDb）が書き換えた後の args をそのまま評価する。
// 「ルートが tenantDb を使っていれば絞られる」ことと「ルートの 404 の処理」を DB 無しで確かめるのが目的で、
// Prisma の完全な再実装ではない（orderBy は無視、groupBy は空、relation の include は浅く解決するだけ）。

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** relation のフィールド名 → [参照先モデルのキー, 外部キー列] */
const RELATIONS: Record<string, [string, string]> = {
  org: ['organization', 'orgId'],
  agent: ['agent', 'agentId'],
  project: ['project', 'projectId'],
  vendor: ['vendor', 'vendorId'],
  user: ['user', 'userId'],
  session: ['chatSession', 'sessionId'],
  connection: ['channelConnection', 'connectionId'],
  capability: ['capability', 'capabilityId'],
  task: ['task', 'taskId'],
  file: ['uploadedFile', 'fileId'],
  message: ['message', 'messageId'],
};

/** schema.prisma の @default のうち、テストの判定に効くもの */
const DEFAULTS: Record<string, Row> = {
  membership: { status: 'ACTIVE', role: 'MEMBER' },
  user: { status: 'ACTIVE', role: 'MEMBER' },
  organization: {
    plan: 'STARTER', storageUsedBytes: BigInt(0), storageAddonUnits: 0, subscriptionStatus: null,
    // 課金の列（nullable は null、Boolean は false）。未設定の列は select で [] になってしまうため明示する
    billingEmail: null, stripeCustomerId: null, stripeSubscriptionId: null, billingInterval: null,
    currentPeriodEnd: null, trialEndsAt: null, cancelAtPeriodEnd: false, createdBy: null,
  },
  // 業務ページ（docs/design/custom-pages.md §3）
  customPage: {
    icon: 'file-text', sortOrder: 0, status: 'DRAFT', minRole: 'MEMBER', version: 1, schemaVersion: 1,
    sampleData: null, createdBy: null, updatedBy: null,
  },
  pageToken: { lastUsedAt: null, revokedAt: null },
  pageActionLog: { status: 'PENDING', durationMs: null, inputKeys: [] },
};

/**
 * schema.prisma の一意制約のうち、偽 Prisma でも P2002 を投げるもの（二重送信・同名ページの判定をルートで確かめるため）。
 * 既存のモデルは足していない（今までのテストの前提を変えないため）。足すなら schema.prisma の @@unique と同じ列で。
 */
const UNIQUES: Record<string, string[][]> = {
  customPage: [['orgId', 'slug']],
  pageToken: [['tokenHash']],
  pageActionLog: [['orgId', 'requestId']],
};

const OPS = new Set(['equals', 'in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'mode', 'has', 'some', 'every', 'none', 'isEmpty']);

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : typeof a === 'bigint' ? Number(a) : (a as number);
  const y = b instanceof Date ? b.getTime() : typeof b === 'bigint' ? Number(b) : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}
function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a != null && b != null && cmp(a, b) === 0;
  if (typeof a === 'bigint' || typeof b === 'bigint') return a != null && b != null && Number(a) === Number(b);
  return a === b || (a == null && b == null);
}

export class FakePrisma {
  tables: Record<string, Row[]> = {};
  private seq = 0;
  rawCalls: unknown[][] = [];
  /** モデル名でアクセスできる自分自身（トランザクションの tx として渡す） */
  private self: FakePrisma = this;

  constructor(seed: Record<string, Row[]>) {
    for (const [k, rows] of Object.entries(seed)) this.tables[k] = rows.map((r) => ({ ...r }));
    const proxy = new Proxy(this, {
      get: (t, prop: string | symbol) => {
        if (typeof prop !== 'string' || prop in t) return (t as unknown as Record<string | symbol, unknown>)[prop];
        return t.delegate(prop);
      },
    });
    this.self = proxy;
    return proxy;
  }

  snapshot(): string {
    return JSON.stringify(this.tables, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  }

  rows(model: string): Row[] {
    return (this.tables[model] ??= []);
  }

  $transaction = async (fn: unknown) => {
    if (Array.isArray(fn)) return Promise.all(fn);
    return (fn as (tx: unknown) => Promise<unknown>)(this.self);
  };
  $queryRaw = async (...args: unknown[]) => {
    this.rawCalls.push(args);
    return [];
  };
  $executeRaw = async (...args: unknown[]) => {
    this.rawCalls.push(args);
    return 0;
  };

  matches(model: string, row: Row, where: Where | undefined): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (k === 'AND') {
        const list = Array.isArray(v) ? v : [v];
        if (!list.every((w) => this.matches(model, row, w as Where))) return false;
        continue;
      }
      if (k === 'OR') {
        if (!(v as Where[]).some((w) => this.matches(model, row, w))) return false;
        continue;
      }
      if (k === 'NOT') {
        const list = Array.isArray(v) ? v : [v];
        if (list.some((w) => this.matches(model, row, w as Where))) return false;
        continue;
      }
      // 複合一意キー（orgId_name: { orgId, name }）
      if (!(k in row) && k.includes('_') && v && typeof v === 'object' && !(v instanceof Date)) {
        if (!this.matches(model, row, v as Where)) return false;
        continue;
      }
      if (!this.matchField(row, k, v)) return false;
    }
    return true;
  }

  private matchField(row: Row, k: string, v: unknown): boolean {
    const actual = row[k];
    if (v === null || typeof v !== 'object' || v instanceof Date) return eq(actual, v);
    const ops = v as Record<string, unknown>;
    const keys = Object.keys(ops);
    if (keys.length > 0 && keys.every((x) => OPS.has(x))) {
      for (const [op, val] of Object.entries(ops)) {
        if (val === undefined) continue;
        switch (op) {
          case 'equals': if (!eq(actual, val)) return false; break;
          case 'in': if (!(val as unknown[]).some((x) => eq(actual, x))) return false; break;
          case 'notIn': if ((val as unknown[]).some((x) => eq(actual, x))) return false; break;
          case 'not':
            if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
              if (this.matchField(row, k, val)) return false;
            } else if (eq(actual, val)) return false;
            break;
          case 'lt': if (actual == null || cmp(actual, val) >= 0) return false; break;
          case 'lte': if (actual == null || cmp(actual, val) > 0) return false; break;
          case 'gt': if (actual == null || cmp(actual, val) <= 0) return false; break;
          case 'gte': if (actual == null || cmp(actual, val) < 0) return false; break;
          case 'contains': if (typeof actual !== 'string' || !actual.toLowerCase().includes(String(val).toLowerCase())) return false; break;
          case 'startsWith': if (typeof actual !== 'string' || !actual.startsWith(String(val))) return false; break;
          case 'endsWith': if (typeof actual !== 'string' || !actual.endsWith(String(val))) return false; break;
          default: break; // mode / some / every / none / has: 分離の検証には影響しないので素通し
        }
      }
      return true;
    }
    // relation のフィルタ（session: { orgId } など）
    const rel = RELATIONS[k];
    if (rel) {
      const target = this.rows(rel[0]).find((r) => r.id === row[rel[1]]);
      return !!target && this.matches(rel[0], target, ops);
    }
    return true;
  }

  private projectRow(model: string, row: Row, shape: Record<string, unknown> | undefined, mode: 'select' | 'include'): Row {
    const out: Row = mode === 'include' || !shape ? { ...row } : {};
    if (!shape) return out;
    for (const [k, v] of Object.entries(shape)) {
      if (!v) continue;
      if (k === '_count') {
        const sel = ((v as Row).select ?? {}) as Row;
        out._count = Object.fromEntries(Object.keys(sel).map((x) => [x, 0]));
        continue;
      }
      if (k in row) {
        out[k] = row[k];
        continue;
      }
      const rel = RELATIONS[k];
      const nested = typeof v === 'object' ? (v as Row) : undefined;
      if (rel) {
        const target = this.rows(rel[0]).find((r) => r.id === row[rel[1]]);
        out[k] = target ? this.shape(rel[0], target, nested) : null;
      } else if (k === 'memberships') {
        // User.memberships / Organization.memberships（所属の確認が使う）
        const fk = model === 'user' ? 'userId' : 'orgId';
        let list = this.rows('membership').filter((m) => m[fk] === row.id && this.matches('membership', m, nested?.where as Where));
        if (typeof nested?.take === 'number') list = list.slice(0, nested.take);
        out[k] = list.map((m) => this.shape('membership', m, nested));
      } else {
        out[k] = []; // そのほかの1対多（logs / messages など）は空で返す
      }
    }
    return out;
  }

  private shape(model: string, row: Row, args: Row | undefined): Row {
    if (args?.select) return this.projectRow(model, row, args.select as Row, 'select');
    if (args?.include) return this.projectRow(model, row, args.include as Row, 'include');
    return { ...row };
  }

  /** 一意制約の違反なら Prisma と同じ形（code: 'P2002'）の例外を投げる */
  private assertUnique(model: string, row: Row, except?: Row): void {
    for (const cols of UNIQUES[model] ?? []) {
      const clash = this.rows(model).some((r) => r !== row && r !== except && cols.every((c) => eq(r[c], row[c])));
      if (clash) {
        throw Object.assign(new Error(`Unique constraint failed on the fields: (${cols.join(',')})`), {
          code: 'P2002',
          meta: { target: cols },
        });
      }
    }
  }

  private notFound(): Error {
    return Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
  }

  private applyData(row: Row, data: Row): void {
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
        const o = v as Row;
        if ('increment' in o) { row[k] = (row[k] as number) + Number(o.increment); continue; }
        if ('decrement' in o) { row[k] = (row[k] as number) - Number(o.decrement); continue; }
        if ('set' in o) { row[k] = o.set; continue; }
      }
      row[k] = v;
    }
    row.updatedAt = new Date();
  }

  private delegate(model: string): Record<string, (args?: Row) => Promise<unknown>> {
    const find = (args?: Row) => this.rows(model).filter((r) => this.matches(model, r, args?.where as Where));
    return {
      findMany: async (args) => {
        let rows = find(args);
        if (typeof args?.skip === 'number') rows = rows.slice(args.skip);
        if (typeof args?.take === 'number') rows = rows.slice(0, Math.abs(args.take));
        return rows.map((r) => this.shape(model, r, args));
      },
      findFirst: async (args) => {
        const r = find(args)[0];
        return r ? this.shape(model, r, args) : null;
      },
      findUnique: async (args) => {
        const r = find(args)[0];
        return r ? this.shape(model, r, args) : null;
      },
      findFirstOrThrow: async (args) => {
        const r = find(args)[0];
        if (!r) throw this.notFound();
        return this.shape(model, r, args);
      },
      findUniqueOrThrow: async (args) => {
        const r = find(args)[0];
        if (!r) throw this.notFound();
        return this.shape(model, r, args);
      },
      count: async (args) => find(args).length,
      aggregate: async () => ({ _sum: {}, _count: { _all: 0 }, _max: {}, _min: {}, _avg: {} }),
      groupBy: async () => [],
      create: async (args) => {
        const row: Row = {
          id: `new-${model}-${++this.seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...DEFAULTS[model],
          ...(args?.data as Row),
        };
        this.assertUnique(model, row);
        this.rows(model).push(row);
        return this.shape(model, row, args);
      },
      createMany: async (args) => {
        const list = (Array.isArray(args?.data) ? args?.data : [args?.data]) as Row[];
        for (const d of list) {
          const row: Row = { id: `new-${model}-${++this.seq}`, createdAt: new Date(), ...DEFAULTS[model], ...d };
          this.assertUnique(model, row);
          this.rows(model).push(row);
        }
        return { count: list.length };
      },
      update: async (args) => {
        const r = find(args)[0];
        if (!r) throw this.notFound();
        this.assertUnique(model, { ...r, ...(args?.data as Row) }, r);
        this.applyData(r, args?.data as Row);
        return this.shape(model, r, args);
      },
      updateMany: async (args) => {
        const rows = find(args);
        for (const r of rows) this.applyData(r, args?.data as Row);
        return { count: rows.length };
      },
      delete: async (args) => {
        const r = find(args)[0];
        if (!r) throw this.notFound();
        this.tables[model] = this.rows(model).filter((x) => x !== r);
        return r;
      },
      deleteMany: async (args) => {
        const rows = find(args);
        this.tables[model] = this.rows(model).filter((x) => !rows.includes(x));
        return { count: rows.length };
      },
      upsert: async (args) => {
        const r = find(args)[0];
        if (r) {
          this.applyData(r, args?.update as Row);
          return r;
        }
        const row: Row = {
          id: `new-${model}-${++this.seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...DEFAULTS[model],
          ...(args?.create as Row),
        };
        this.assertUnique(model, row);
        this.rows(model).push(row);
        return row;
      },
    };
  }
}
