#!/usr/bin/env node
// Render の 3 サービス（gateway / ai-engine / n8n）を 1 コマンドで
// 診断・環境変数設定・リポジトリ張り替え・デプロイ・検証する。
//
//   node scripts/render-deploy.mjs             # = status（読み取りのみ・既定）
//   node scripts/render-deploy.mjs status
//   node scripts/render-deploy.mjs set-env     # GEMINI_API_KEY / ADMIN_EMAILS 等を反映
//   node scripts/render-deploy.mjs set-plan    # プラン変更（既定 starter。render.yaml と揃える）
//   node scripts/render-deploy.mjs rewire      # 接続リポジトリ/ブランチを正準へ張り替え
//   node scripts/render-deploy.mjs deploy      # デプロイ実行
//   node scripts/render-deploy.mjs verify      # /health をポーリング
//
// 必要な env（.env か シェルで）:
//   RENDER_API_KEY   … Render ダッシュボード → Account Settings → API Keys
//   GEMINI_API_KEY   … set-env で ai-engine に入れる値（松竹梅ルーティングの梅/竹用）
//   ADMIN_EMAILS     … 任意。ここに一致する email は常に Claude になる（未設定なら全員 Gemini）
//
// 安全設計:
//   - 既定は読み取りのみ。変更系は明示のサブコマンドが必要。
//   - 環境変数は「キー単位」の更新 API を使う（全置換 API は使わない＝既存の値を消さない）。
//   - シークレットは値を表示せず、長さと先頭数文字のみ出す。

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function loadEnv(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv(join(ROOT, '.env'));

const API = 'https://api.render.com/v1';
const KEY = process.env.RENDER_API_KEY ?? '';

// 正準リポジトリ（docs/hamada-phasera-canonical.md）
const CANONICAL_REPO = 'https://github.com/hamada-phasera/org-ai-platform';
const CANONICAL_BRANCH = 'main';

// サービス名 → 役割。Render 上の実際の名前と突き合わせる（前方一致で拾う）。
const ROLES = [
  { role: 'gateway', match: /api-gateway/i, health: '/health' },
  { role: 'ai-engine', match: /ai-engine/i, health: '/health' },
  { role: 'n8n', match: /n8n/i, health: '/healthz' },
];

// set-env で ai-engine に投入する env（値は環境変数から取る）。
const AI_ENGINE_ENV = ['GEMINI_API_KEY', 'ADMIN_EMAILS'];

// Render のリージョン → 対応する Supabase のリージョン。
// アプリと DB が別大陸だと全クエリに往復レイテンシが乗るため、必ず揃える。
const SUPABASE_REGION_HINT = {
  oregon: 'West US (Oregon) / us-west-1',
  ohio: 'East US (Ohio) / us-east-2',
  virginia: 'East US (North Virginia) / us-east-1',
  frankfurt: 'Central EU (Frankfurt) / eu-central-1',
  singapore: 'Southeast Asia (Singapore) / ap-southeast-1',
};

// set-plan の既定。render.yaml の `plan:` と揃えること（render.yaml が正本）。
const DEFAULT_PLAN = 'starter';
const KNOWN_PLANS = ['free', 'starter', 'standard', 'pro'];

function mask(v) {
  if (!v) return '(未設定)';
  return `${v.slice(0, 6)}…(${v.length}文字)`;
}

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非JSON応答はそのまま扱う */
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

/** Render 上の全サービスを取得し、役割を割り当てる。 */
async function listServices() {
  const raw = await api('/services?limit=100');
  // API は [{ service: {...} }, ...] 形式で返す
  const services = raw.map((r) => r.service ?? r).filter(Boolean);
  return services.map((s) => {
    const role = ROLES.find((r) => r.match.test(s.name ?? ''))?.role ?? null;
    return { ...s, role };
  });
}

function repoOf(s) {
  return s.repo ?? s.serviceDetails?.repo ?? s.ownerId ?? '(不明)';
}

// リージョンは serviceDetails 配下にあるが、サービス種別により位置が違うことがある。
// DB のリージョン選定に直結する情報なので、拾える場所を順に見る。
function regionOf(s) {
  return s.serviceDetails?.region ?? s.serviceDetails?.env ?? s.region ?? '(不明)';
}

async function cmdStatus() {
  const services = await listServices();
  if (!services.length) die('サービスが 0 件。RENDER_API_KEY のアカウントを確認してください。');

  console.log(`\n=== Render サービス (${services.length}) ===`);
  for (const s of services) {
    const url = s.serviceDetails?.url ?? '';
    console.log(
      [
        `\n▸ ${s.name}  [${s.role ?? 'その他'}]`,
        `    id      : ${s.id}`,
        `    repo    : ${repoOf(s)}`,
        `    branch  : ${s.branch ?? '(なし)'}`,
        `    plan    : ${s.serviceDetails?.plan ?? '(不明)'}`,
        `    region  : ${regionOf(s)}   ← DB はこれと同じリージョンに置く`,
        `    suspend : ${s.suspended ?? '(不明)'}`,
        `    autoDep : ${s.autoDeploy ?? '(不明)'}`,
        url ? `    url     : ${url}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );

    const canonical =
      String(repoOf(s)).toLowerCase().includes('hamada-phasera') && s.branch === CANONICAL_BRANCH;
    if (s.role && !canonical) {
      console.log(`    ⚠ 正準(${CANONICAL_REPO} / ${CANONICAL_BRANCH})ではありません → rewire 対象`);
    }
  }

  const engine = services.find((s) => s.role === 'ai-engine');
  if (engine) {
    const vars = await api(`/services/${engine.id}/env-vars?limit=100`);
    const keys = vars.map((v) => (v.envVar ?? v).key);
    console.log(`\n=== ai-engine の env（キーのみ） ===\n  ${keys.join(', ') || '(なし)'}`);
    for (const k of AI_ENGINE_ENV) {
      console.log(`  ${k}: ${keys.includes(k) ? '設定済み' : '未設定 ← set-env で投入'}`);
    }
  }
  // Supabase 移行のためのリージョン確認。DB とアプリが別大陸だと、全クエリに
  // 往復のレイテンシが乗り続ける（1リクエストで数回問い合わせるため体感に出る）。
  const regions = [...new Set(services.filter((s) => s.role).map(regionOf))];
  console.log('\n=== DB リージョン選定 ===');
  console.log(`  Render のリージョン: ${regions.join(' / ') || '(不明)'}`);
  console.log(`  → Supabase も ${SUPABASE_REGION_HINT[regions[0]] ?? '同じ大陸のリージョン'} を選ぶこと。`);
  if (regions.length > 1) {
    console.log('  ⚠ サービス間でリージョンが割れています。DB は gateway と揃えるのが最優先。');
  }

  console.log('\n次: set-env → rewire → deploy → verify\n');
}

async function cmdSetEnv() {
  const services = await listServices();
  const engine = services.find((s) => s.role === 'ai-engine');
  if (!engine) die('ai-engine サービスが見つかりません。');

  const todo = AI_ENGINE_ENV.filter((k) => process.env[k]);
  if (!todo.length) {
    die(`投入する値がありません。.env か シェルで ${AI_ENGINE_ENV.join(' / ')} を設定してください。`);
  }

  for (const key of todo) {
    const value = process.env[key];
    // キー単位の更新（全置換ではないので他の env は消えない）
    await api(`/services/${engine.id}/env-vars/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
    console.log(`✔ ai-engine に ${key} を設定 (${mask(value)})`);
  }
  console.log('\n※ 反映にはデプロイ（または再起動）が必要です → node scripts/render-deploy.mjs deploy\n');
}

async function cmdSetPlan() {
  const plan = (process.argv[3] ?? DEFAULT_PLAN).toLowerCase();
  if (!KNOWN_PLANS.includes(plan)) {
    die(`不明なプラン: ${plan}（想定: ${KNOWN_PLANS.join(' / ')}）`);
  }
  const services = await listServices();
  const targets = services.filter((s) => s.role);
  if (!targets.length) die('対象サービスが見つかりません。');

  for (const s of targets) {
    const current = s.serviceDetails?.plan;
    if (current === plan) {
      console.log(`－ ${s.name} は既に ${plan}（変更なし）`);
      continue;
    }
    await api(`/services/${s.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ serviceDetails: { plan } }),
    });
    console.log(`✔ ${s.name}: ${current ?? '?'} → ${plan}`);
  }
  console.log(
    '\n※ 有料プランへの変更には Render 側に支払い方法の登録が必要（未登録だと' +
      '\n   "Plan requires payment information on file" で 400 になる）。' +
      '\n※ render.yaml の `plan:` も同じ値に揃えておくこと（Blueprint 同期で戻されるため）。\n',
  );
}

async function cmdRewire() {
  const services = await listServices();
  const targets = services.filter((s) => s.role);
  if (!targets.length) die('対象サービスが見つかりません。');

  for (const s of targets) {
    await api(`/services/${s.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ repo: CANONICAL_REPO, branch: CANONICAL_BRANCH, autoDeploy: 'yes' }),
    });
    console.log(`✔ ${s.name} → ${CANONICAL_REPO} / ${CANONICAL_BRANCH} (autoDeploy=yes)`);
  }
  console.log('\n※ env はサービスに紐づくので張り替えでは消えません。\n');
}

async function cmdDeploy() {
  const services = await listServices();
  const targets = services.filter((s) => s.role);
  if (!targets.length) die('対象サービスが見つかりません。');

  for (const s of targets) {
    const d = await api(`/services/${s.id}/deploys`, {
      method: 'POST',
      body: JSON.stringify({ clearCache: 'do_not_clear' }),
    });
    console.log(`✔ ${s.name} デプロイ開始 (deploy id: ${d?.id ?? '?'})`);
  }
  console.log(
    '\n※ gateway の startCommand は `prisma migrate deploy` を含むため、' +
      '\n   未適用のマイグレーション（Deal / Task.scheduledAt 等）は起動時に自動適用されます。' +
      '\n   進捗は Render ダッシュボードの Logs、完了確認は verify で。\n',
  );
}

async function cmdVerify() {
  const services = await listServices();
  const targets = services.filter((s) => s.role && s.serviceDetails?.url);
  if (!targets.length) die('URL 付きのサービスが見つかりません。');

  for (const s of targets) {
    const health = ROLES.find((r) => r.role === s.role)?.health ?? '/health';
    const url = `${s.serviceDetails.url.replace(/\/$/, '')}${health}`;
    let out = '到達不可';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      out = `HTTP ${res.status}`;
    } catch (e) {
      out = `到達不可 (${e.message.slice(0, 60)})`;
    }
    console.log(`  ${s.name.padEnd(22)} ${url} → ${out}`);
  }
  console.log(
    '\n※ 無料プランはスリープするため初回は数十秒かかります（コールドスタート）。' +
      '\n   401 が返れば「起動済み・認証必須」= 正常です。\n',
  );
}

const CMDS = {
  status: cmdStatus,
  'set-env': cmdSetEnv,
  'set-plan': cmdSetPlan,
  rewire: cmdRewire,
  deploy: cmdDeploy,
  verify: cmdVerify,
};

const cmd = process.argv[2] ?? 'status';
if (!CMDS[cmd]) die(`不明なコマンド: ${cmd}\n使い方: ${Object.keys(CMDS).join(' | ')}`);
if (!KEY) die('RENDER_API_KEY が未設定です（.env か シェルで設定してください）。');

CMDS[cmd]().catch((e) => die(e.message));
