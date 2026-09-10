// ユーザーが定義した外部 API を gateway から叩くための SSRF ガード。
//
// このリポジトリで初めて「ユーザー入力由来の URL に fetch する」経路であり、
// gateway は Render 上（＝クラウドのメタデータ IP や社内サービスと同じネットワーク）で動く。
// 169.254.169.254 に到達できるだけで資格情報の窃取に直結するため、ここが最重要の防御層になる。
//
// 防御は 2 段構えで、どちらが欠けても破られる:
//   (A) 静的検査 validateUrlTemplate / assertSafeUrl … scheme・userinfo・port・IP リテラル・
//       内部ホスト・長さ・プレースホルダ位置を見る。DNS は引かない。
//   (B) DNS ピン留め createGuardedLookup … 実際に接続するアドレスそのものを検証する。
// (A) だけだと DNS リバインディングで破られ、(B) だけだと IP リテラル指定時に lookup が
// 呼ばれないため素通りする。両方必要（各関数のコメント参照）。

import { BlockList, isIP, type LookupFunction } from 'net';
import { lookup as systemLookup, type LookupAddress, type LookupAllOptions } from 'dns';

export type GuardReason =
  | 'SCHEME_NOT_ALLOWED'
  | 'USERINFO_NOT_ALLOWED'
  | 'PORT_NOT_ALLOWED'
  | 'IP_LITERAL_NOT_ALLOWED'
  | 'PLACEHOLDER_IN_ORIGIN'
  | 'URL_TOO_LONG'
  | 'MALFORMED_URL'
  | 'BLOCKED_DESTINATION';

export type GuardVerdict = { ok: true; url: URL } | { ok: false; reason: GuardReason; detail: string };

/** URL 長の上限。極端に長い URL はパーサ差異を突く難読化の温床なので機械的に切る。 */
export const MAX_URL_LENGTH = 2048;

/** ポート許可制の既定値。https の 443 と、よくある代替 https ポートの 8443 のみ。 */
const DEFAULT_ALLOWED_PORTS = '443,8443';

/** 単一ラベル以外で内部を示すサフィックス（Docker / mDNS / 社内 DNS）。 */
const INTERNAL_SUFFIXES = ['.internal', '.local', '.localdomain'];

/**
 * 内部ホスト名を拾うために hostname を読む環境変数。
 * Render ではこれらが `*.onrender.com` のような**公開 DNS 名**になるため、
 * IP ベースの BlockList では絶対に捕まらない（解決先はパブリック IP）。
 * つまり本番環境では、この env 由来 denylist が実質的な最重要防御になる。
 */
const INTERNAL_HOST_ENV_KEYS = [
  'N8N_CLOUD_URL',
  'N8N_URL',
  'AI_ENGINE_URL',
  'API_GATEWAY_URL',
  'DATABASE_URL',
] as const;

// ---------------------------------------------------------------------------
// IP denylist（モジュールスコープで一度だけ構築する）
// ---------------------------------------------------------------------------

/**
 * 非公開・特殊用途の IP レンジ。net.BlockList は C++ 側で範囲比較するので
 * 文字列比較や正規表現より正確かつ速い。リクエストごとに作り直さず一度だけ構築する。
 */
const IP_DENYLIST = (() => {
  const list = new BlockList();

  // --- IPv4 ---
  list.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network" / 0.0.0.0 は多くのスタックで localhost 扱い
  list.addSubnet('10.0.0.0', 8, 'ipv4'); // RFC1918 プライベート
  list.addSubnet('127.0.0.0', 8, 'ipv4'); // ループバック（gateway 自身の管理 API）
  list.addSubnet('169.254.0.0', 16, 'ipv4'); // リンクローカル＝クラウドメタデータ 169.254.169.254
  list.addSubnet('172.16.0.0', 12, 'ipv4'); // RFC1918（172.16〜172.31 のみ。172.15/172.32 は公開）
  list.addSubnet('192.168.0.0', 16, 'ipv4'); // RFC1918
  list.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT（RFC6598）。Tailscale 等の内部網でも使われる
  list.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF プロトコル割当（NAT64 の 192.0.0.170 等）
  list.addSubnet('198.18.0.0', 15, 'ipv4'); // ベンチマーク用（RFC2544）
  list.addSubnet('224.0.0.0', 4, 'ipv4'); // マルチキャスト
  list.addSubnet('240.0.0.0', 4, 'ipv4'); // 予約（255.255.255.255 のブロードキャストを含む）

  // --- IPv6 ---
  list.addAddress('::', 'ipv6'); // 未指定アドレス（::/128 は addSubnet より addAddress が確実）
  list.addAddress('::1', 'ipv6'); // ループバック
  list.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64（埋め込み v4 経由で内部に出られる）
  list.addSubnet('100::', 64, 'ipv6'); // Discard-Only（RFC6666）
  list.addSubnet('2001:db8::', 32, 'ipv6'); // ドキュメント用
  list.addSubnet('fc00::', 7, 'ipv6'); // ユニークローカル（fc00::/8 + fd00::/8）
  list.addSubnet('fe80::', 10, 'ipv6'); // リンクローカル
  list.addSubnet('ff00::', 8, 'ipv6'); // マルチキャスト

  return list;
})();

/** `fe80::1%eth0` のゾーン ID を落とし、`[::1]` の角括弧も外す。 */
function normalizeIpString(address: string): string {
  let addr = address.trim();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  return addr;
}

/** IPv6 文字列を 16 バイトへ展開する。壊れていれば null。 */
function ipv6ToBytes(address: string): number[] | null {
  let text = address.toLowerCase();

  // 末尾がドット付き（::ffff:127.0.0.1）なら 2 つの 16bit グループへ畳む
  const lastColon = text.lastIndexOf(':');
  if (lastColon < 0) return null;
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const quad = tail.split('.');
    if (quad.length !== 4) return null;
    const nums = quad.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
    if (nums.some((n) => n < 0 || n > 255)) return null;
    const g1 = ((nums[0] << 8) | nums[1]).toString(16);
    const g2 = ((nums[2] << 8) | nums[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${g1}:${g2}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tailGroups = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const missing = 8 - (head.length + tailGroups.length);
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && missing < 0) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tailGroups];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

/**
 * IPv4-mapped / IPv4-compatible IPv6 に埋め込まれた v4 アドレスを取り出す。
 * `::ffff:127.0.0.1` と `::ffff:7f00:1` は同じアドレスだが、
 * **BlockList の v4 サブネット規則には（v6 として評価されると）一致し得ない**ので、
 * 埋め込み v4 を自前で抽出して v4 側の規則で再判定する必要がある。
 */
function embeddedIPv4(bytes: number[]): string | null {
  const firstTenZero = bytes.slice(0, 10).every((b) => b === 0);
  if (!firstTenZero) return null;
  const isMapped = bytes[10] === 0xff && bytes[11] === 0xff; // ::ffff:a.b.c.d
  const isCompat = bytes[10] === 0 && bytes[11] === 0; // ::a.b.c.d（廃止済みだが解釈系は残っている）
  if (!isMapped && !isCompat) return null;
  const v4 = bytes.slice(12);
  if (isCompat && v4.every((b) => b === 0)) return null; // :: 自体は v4 ではない
  if (isCompat && v4[0] === 0 && v4[1] === 0 && v4[2] === 0 && v4[3] === 1) return null; // ::1 も同様
  return v4.join('.');
}

/**
 * IP 文字列の許可判定。非公開・特殊用途なら allowed=false。
 * `createGuardedLookup` が解決結果を判定するのに使う中核関数。
 */
export function classifyIp(address: string): { allowed: boolean; reason?: string } {
  const addr = normalizeIpString(address);
  const version = isIP(addr);
  if (version === 0) {
    // IP でないものは「安全と判断できない」ので拒否側に倒す
    return { allowed: false, reason: 'NOT_AN_IP' };
  }

  if (version === 4) {
    return IP_DENYLIST.check(addr, 'ipv4')
      ? { allowed: false, reason: 'BLOCKED_IPV4_RANGE' }
      : { allowed: true };
  }

  // v6: まず埋め込み v4 を v4 規則で判定する（::ffff:127.0.0.1 対策）
  const bytes = ipv6ToBytes(addr);
  if (!bytes) return { allowed: false, reason: 'MALFORMED_IPV6' };
  const mapped = embeddedIPv4(bytes);
  if (mapped) {
    if (IP_DENYLIST.check(mapped, 'ipv4')) {
      return { allowed: false, reason: 'BLOCKED_IPV4_MAPPED' };
    }
  }
  return IP_DENYLIST.check(addr, 'ipv6')
    ? { allowed: false, reason: 'BLOCKED_IPV6_RANGE' }
    : { allowed: true };
}

// ---------------------------------------------------------------------------
// 内部ホスト denylist（env 由来）
// ---------------------------------------------------------------------------

function hostnameFromEnvValue(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    // DATABASE_URL(postgresql://...) も WHATWG URL でホスト名を取り出せる
    const host = new URL(raw).hostname;
    if (host) return normalizeHostname(host);
  } catch {
    // scheme 無しでホスト名だけが入っている運用もあるので素の値も見る
  }
  if (!/[\s/\\]/.test(raw)) return normalizeHostname(raw);
  return null;
}

function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1); // 'localhost.' のような絶対 FQDN 表記を潰す
  return host;
}

function buildInternalHostDenylist(): Set<string> {
  const hosts = new Set<string>();
  for (const key of INTERNAL_HOST_ENV_KEYS) {
    const value = process.env[key];
    if (!value) continue;
    const host = hostnameFromEnvValue(value);
    if (host) hosts.add(host);
  }
  // 運用側で足したいホストを追加できる逃げ道
  for (const entry of (process.env.HTTP_NODE_BLOCKED_HOSTS ?? '').split(',')) {
    const host = normalizeHostname(entry);
    if (host) hosts.add(host);
  }
  return hosts;
}

let internalHostDenylist = buildInternalHostDenylist();

/** テスト用に内部ホスト denylist を作り直す（env を差し替えたあとに呼ぶ）。 */
export function rebuildInternalHostDenylist(): void {
  internalHostDenylist = buildInternalHostDenylist();
}

/**
 * ホスト名ベースの拒否判定。IP ブロックでは捕まらない宛先をここで落とす。
 * - env 由来の内部サービス（Render では公開 DNS 名なので IP では判定不能）
 * - ドットを含まない単一ラベル（localhost / n8n / redis 等＝コンテナ内サービス名）
 * - .internal / .local / .localdomain
 */
function blockedHostReason(hostname: string): string | null {
  const host = normalizeHostname(hostname);
  if (!host) return 'EMPTY_HOST';
  if (internalHostDenylist.has(host)) return 'INTERNAL_SERVICE_HOST';
  if (!host.includes('.')) return 'SINGLE_LABEL_HOST';
  for (const suffix of INTERNAL_SUFFIXES) {
    if (host.endsWith(suffix)) return 'INTERNAL_SUFFIX';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 静的検査
// ---------------------------------------------------------------------------

function allowedPorts(): Set<number> {
  const raw = process.env.HTTP_NODE_ALLOWED_PORTS?.trim() || DEFAULT_ALLOWED_PORTS;
  const ports = new Set<number>();
  for (const entry of raw.split(',')) {
    const port = Number(entry.trim());
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return ports;
}

function deny(reason: GuardReason, detail: string): GuardVerdict {
  return { ok: false, reason, detail };
}

/** 生文字列から origin 部分（scheme + host + port）だけを切り出す。 */
function rawOrigin(raw: string): string | null {
  const schemeEnd = raw.indexOf('://');
  if (schemeEnd < 0) return null;
  const rest = raw.slice(schemeEnd + 3);
  const stop = rest.search(/[/?#]/);
  return raw.slice(0, schemeEnd + 3) + (stop < 0 ? rest : rest.slice(0, stop));
}

/** 静的検査の本体。テンプレート検証と実行時検証で共通。 */
function inspect(raw: string): GuardVerdict {
  if (typeof raw !== 'string' || !raw.trim()) {
    return deny('MALFORMED_URL', 'URL が空です');
  }
  // 1) 長さ。パースの前に切る（長大入力でのパーサ差異・DoS を避ける）
  if (raw.length > MAX_URL_LENGTH) {
    return deny('URL_TOO_LONG', `URL は ${MAX_URL_LENGTH} 文字以内にしてください`);
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return deny('MALFORMED_URL', 'URL として解釈できません');
  }

  // 2) https 限定。http は平文なので API キーが素で流れるうえ、
  //    途中の中間者にダウングレード・リダイレクト誘導の余地を与える。
  if (url.protocol !== 'https:') {
    return deny('SCHEME_NOT_ALLOWED', 'https:// のみ許可されています');
  }

  // 3) userinfo 禁止。`https://api.example.com@169.254.169.254/` は人間には
  //    api.example.com 宛に見えるが実際の接続先は 169.254.169.254 になる典型的な混同攻撃。
  //    加えて URL 内の資格情報はログ・エラーメッセージに漏れる。
  if (url.username || url.password) {
    return deny('USERINFO_NOT_ALLOWED', 'URL に user:password を含められません');
  }

  const hostname = normalizeIpString(url.hostname);
  if (!hostname) {
    return deny('MALFORMED_URL', 'ホスト名がありません');
  }

  // 4) IP リテラルのホストは一律拒否。
  //    WHATWG URL は http://0x7f000001/ や http://0x7f.1/ を 127.0.0.1 に、
  //    [::ffff:127.0.0.1] を [::ffff:7f00:1] に正規化してくれるので、
  //    「isIP が非0なら拒否」だけで 8進/16進/10進の難読化を一網打尽にできる。
  //    さらに重要な点として、**ホストが IP リテラルの場合 net.connect は DNS を引かず
  //    connect.lookup が一切呼ばれない**。つまり createGuardedLookup による DNS ピン留めは
  //    この経路を守れない。この静的拒否がピン留めの必須の相方になる。
  if (isIP(hostname) !== 0) {
    return deny('IP_LITERAL_NOT_ALLOWED', 'IP アドレス直接指定は許可されていません（ホスト名で指定してください）');
  }

  // 5) ポート許可制。443/8443 以外は内部サービス（22, 6379, 5432, 9200 …）狙いとみなす。
  const port = url.port ? Number(url.port) : 443;
  if (!allowedPorts().has(port)) {
    return deny('PORT_NOT_ALLOWED', `ポート ${port} は許可されていません`);
  }

  // 6) ホスト名 denylist。ここは理由を握り潰して BLOCKED_DESTINATION に畳む（後述）。
  const hostReason = blockedHostReason(hostname);
  if (hostReason) {
    return deny('BLOCKED_DESTINATION', 'この宛先には接続できません');
  }

  return { ok: true, url };
}

/**
 * 保存時の静的検査（DNS を引かない）。プレースホルダ規則もここで見る。
 *
 * origin（scheme + host + port）に `{{...}}` を含むテンプレートは拒否する。
 * これを許すと「保存時にガードを通した URL」の宛先ホストを実行時パラメータで
 * 差し替えられてしまい、ここまでの検査すべてが無意味になる。
 * プレースホルダは path / query / fragment でのみ使える。
 */
export function validateUrlTemplate(raw: string): GuardVerdict {
  if (typeof raw !== 'string' || !raw.trim()) {
    return deny('MALFORMED_URL', 'URL が空です');
  }
  if (raw.length > MAX_URL_LENGTH) {
    return deny('URL_TOO_LONG', `URL は ${MAX_URL_LENGTH} 文字以内にしてください`);
  }

  // URL パーサに通す前に生文字列で見る。`https://{{host}}.example.com/` は
  // パース自体は成功してしまい（hostname='{{host}}.example.com'）、
  // パース後の検査では「ドットがあるただのホスト名」として通り抜けかねない。
  const origin = rawOrigin(raw.trim());
  if (origin === null) {
    return deny('MALFORMED_URL', 'URL として解釈できません');
  }
  if (origin.includes('{{') || origin.includes('}}')) {
    return deny(
      'PLACEHOLDER_IN_ORIGIN',
      'プレースホルダはパス・クエリ・フラグメントにのみ使えます（ホスト名やポートには使えません）',
    );
  }

  return inspect(raw);
}

/**
 * 実行時の検査（プレースホルダ展開後の URL）。
 * プレースホルダ規則以外は validateUrlTemplate と同じ。
 * 保存時に通っていても、展開後にもう一度必ず通すこと（展開値でパスから origin を
 * 生やす細工や、保存後の env 変更に追随するため）。
 */
export function assertSafeUrl(raw: string): GuardVerdict {
  return inspect(raw);
}

// ---------------------------------------------------------------------------
// DNS ピン留め
// ---------------------------------------------------------------------------

/** 宛先関連の失敗はすべてこの 1 種類に畳む（内部ネットワークスキャナにしないため）。 */
function blockedDestinationError(detail: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('この宛先には接続できません');
  err.code = 'ERR_BLOCKED_DESTINATION';
  // detail は運用ログ向け。呼び出し元がユーザーに出さないこと。
  (err as NodeJS.ErrnoException & { detail?: string }).detail = detail;
  return err;
}

/**
 * undici Agent の `connect.lookup` に差す DNS ピン留め関数。
 *
 * 「先に解決して検証 → その後 fetch」は TOCTOU で破れる。攻撃者は TTL 0 の DNS を用意し、
 * 検証時はパブリック IP を、接続時は 169.254.169.254 を返せばよい（DNS リバインディング）。
 * 一方 `connect.lookup` は **net.connect が実際に接続する宛先を決める関数そのもの**なので、
 * ここで検証すれば「検証したアドレス == 接続するアドレス」が構造的に保証される。
 *
 * 解決結果に 1 つでも非公開アドレスがあればホストごと拒否する。
 * 公開アドレスだけに絞って返す実装にしてはならない: Node 20+ の autoSelectFamily
 * (Happy Eyeballs) は候補を順に試すため、絞り込み実装だとフォールバック経路で
 * 非公開側に到達し得るし、そもそも「公開と非公開を同時に返すホスト」は攻撃の兆候そのもの。
 */
export function createGuardedLookup(resolver: typeof systemLookup = systemLookup): LookupFunction {
  return (hostname, options, callback) => {
    // リダイレクト追跡で別ホストに飛んだ場合もここを通るので、ホスト名 denylist を再度見る
    const hostReason = blockedHostReason(hostname);
    if (hostReason) {
      callback(blockedDestinationError(`${hostname}: ${hostReason}`), '', 4);
      return;
    }

    const wantsAll = options?.all === true;
    const allOptions: LookupAllOptions = {
      ...(options ?? {}),
      all: true, // 一部だけ見て通すことがないよう、常に全アドレスを取る
      verbatim: true, // OS の並べ替えに依存せず、返ってきた候補をそのまま全部検査する
    };

    resolver(hostname, allOptions, (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      // DNS 失敗も「宛先ブロック」と同じエラーに畳む（解決不能と内部宛を区別させない）
      if (err) {
        callback(blockedDestinationError(`${hostname}: DNS_LOOKUP_FAILED`), '', 4);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) {
        callback(blockedDestinationError(`${hostname}: NO_ADDRESS`), '', 4);
        return;
      }

      for (const entry of list) {
        const verdict = classifyIp(entry.address);
        if (!verdict.allowed) {
          // 1 つでも非公開なら「公開分だけ使う」ではなくホストごと拒否
          callback(
            blockedDestinationError(`${hostname}: ${entry.address} ${verdict.reason ?? 'BLOCKED'}`),
            '',
            4,
          );
          return;
        }
      }

      if (wantsAll) {
        callback(null, list);
        return;
      }
      const first = list[0];
      callback(null, first.address, first.family);
    });
  };
}
