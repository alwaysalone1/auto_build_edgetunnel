#!/usr/bin/env node
/**
 * deploy-edgetunnel.mjs — 把 cmliu/edgetunnel 2.1 全自动部署到 Cloudflare Workers
 *
 * 与旧的 deploy-cloudflare-vless.mjs 的根本区别：
 *   1. Worker 内核换成 edgetunnel/_worker.js（321KB，VLESS/Trojan/SS + WS/gRPC/xHTTP）
 *   2. 不再改写源码里的 uuid 常量 —— edgetunnel 的 UUID 由 env.ADMIN + env.KEY 派生
 *   3. 必须绑定 KV 命名空间（edgetunnel 的 /sub 端点在 if(env.KV) 分支内，不绑就没订阅）
 *   4. 直接把「最优 config.json」写进 KV，完全绕开依赖远程站点的管理面板
 *   5. 订阅校验从「找 Clash YAML 关键字」改成「base64 解码后匹配 vless://<uuid>@」
 *
 * 用法（最短）：
 *   node deploy-edgetunnel.mjs --account-id <32位ID> --vses2 <cookie值> --zone example.com
 *
 * 已有 API Token：
 *   node deploy-edgetunnel.mjs --account-id <ID> --api-token <TOKEN> --zone example.com --nodes 500
 *
 * 只改配置不重新部署（改节点数最快路径）：
 *   node deploy-edgetunnel.mjs --reconfigure --nodes 300
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

// 脚本依赖全局 fetch / AbortSignal.timeout，Node < 18 会静默失败，提前给出可读报错
if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error(`\n需要 Node.js >= 18（脚本使用全局 fetch / AbortSignal），当前版本：${process.versions.node}`);
  process.exit(1);
}

const API_BASE = 'https://api.cloudflare.com/client/v4';
const DASH_API_BASE = 'https://dash.cloudflare.com/api/v4';
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;
// edgetunnel/wrangler.toml 要求 compatibility_date >= 2025-11-04
const MIN_COMPATIBILITY_DATE = '2025-11-04';
const DEFAULT_COMPATIBILITY_DATE = '2026-06-13';
const DEFAULT_WORKER_SOURCE = path.resolve('_et', '_worker.js');
const DEFAULT_STATE_FILE = path.resolve('edgetunnel-deploy.state.json');
const DEFAULT_CRED_FILE = path.resolve('edgetunnel-credentials.json');
const WRITE_EDIT_WORD_RE = /\b(write|edit)\b/ig;

// edgetunnel 需要的权限：Workers 脚本 + KV 命名空间读写 + Zone/DNS/Route
const DEFAULT_TOKEN_PAYLOAD = {
  name: 'edgetunnel 部署令牌',
  condition: {},
  policies: [
    {
      effect: 'allow',
      resources: { 'com.cloudflare.api.account.*': '*' },
      permission_groups: [
        { name: 'Account Settings Read' },
        { name: 'Workers Scripts Read' },
        { name: 'Workers Scripts Write' },
        { name: 'Workers KV Storage Read' },
        { name: 'Workers KV Storage Edit' },
      ],
    },
    {
      effect: 'allow',
      resources: { 'com.cloudflare.api.account.zone.*': '*' },
      permission_groups: [
        { name: 'Zone Read' },
        { name: 'Zone Write' },
        { name: 'DNS Read' },
        { name: 'DNS Write' },
        { name: 'Workers Routes Read' },
        { name: 'Workers Routes Write' },
      ],
    },
  ],
};

/* ────────────────────────────────────────────────────────────────
 * 1. 与 edgetunnel 完全对齐的凭据派生
 *    _worker.js L5402-5414  MD5MD5()
 *    _worker.js L31-34      userID
 *    _worker.js L304        订阅TOKEN
 * ──────────────────────────────────────────────────────────────── */
const md5hex = (s) => createHash('md5').update(s, 'utf8').digest('hex');

/** 复刻 MD5MD5：md5(x) -> 取 hex 的 [7,27) -> 再 md5 -> 小写 hex */
function md5md5(text) {
  return md5hex(md5hex(text).slice(7, 27)).toLowerCase();
}

/** 复刻 L34：由 ADMIN+KEY 派生伪 UUIDv4（第13位强制'4'，第17位强制'8|9|a|b'） */
function deriveUserId(admin, key, forcedUuid = '') {
  const uuidv4Re = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
  if (forcedUuid && uuidv4Re.test(forcedUuid)) return forcedUuid.toLowerCase();
  const m = md5md5(admin + key);
  return [m.slice(0, 8), m.slice(8, 12), '4' + m.slice(13, 16), '8' + m.slice(17, 20), m.slice(20)].join('-');
}

/** 复刻 L304：订阅 TOKEN = MD5MD5(host + userID) */
const deriveSubToken = (host, userId) => md5md5(host + userId);

/* ────────────────────────────────────────────────────────────────
 * 2. 参数与环境
 * ──────────────────────────────────────────────────────────────── */
function readArgs(argv) {
  const o = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = a.startsWith('--') ? (eq > -1 ? a.slice(2, eq) : a.slice(2)) : a;
    const inline = a.startsWith('--') && eq > -1;
    const next = () => (inline ? a.slice(eq + 1) : argv[++i]);
    if (name === 'zone') o.zoneName = next();
    else if (name === 'account-id') o.accountId = next();
    else if (name === 'api-token') o.token = next();
    else if (name === 'vses2') o.dashboardVses2 = next();
    else if (name === 'cookie') o.dashboardCookie = next();
    else if (name === 'atok' || name === 'x-atok') o.dashboardAtok = next();
    else if (name === 'hostname') o.hostname = next();
    else if (name === 'worker-name') o.workerName = next();
    else if (name === 'admin') o.admin = next();
    else if (name === 'key') o.key = next();
    else if (name === 'uuid') o.uuid = next();
    else if (name === 'nodes') o.nodes = Number(next());
    else if (name === 'port') o.port = Number(next());
    else if (name === 'sub-update-time') o.subUpdateTime = Number(next());
    else if (name === 'kv-title') o.kvTitle = next();
    else if (name === 'kv-id') o.kvId = next();
    else if (name === 'proxyip') o.proxyip = next();
    else if (name === 'go2socks5') o.go2socks5 = next();
    else if (name === 'path') o.nodePath = next();
    else if (name === 'transport') o.transport = next();
    else if (name === 'protocol') o.protocol = next();
    else if (name === 'sub-name') o.subName = next();
    else if (name === 'subapi') o.subapi = next();
    else if (name === 'worker-source') o.workerSource = next();
    else if (name === 'compatibility-date') o.compatibilityDate = next();
    else if (name === 'state-file') o.stateFile = next();
    else if (name === 'cred-file') o.credFile = next();
    else if (name === 'nodes' && Number.isNaN(o.nodes)) o.nodes = 500;
    else if (name === 'reconfigure') o.reconfigure = true;
    else if (name === 'destroy') o.destroy = true;
    else if (name === 'revoke-token') o.revokeToken = true;
    else if (name === 'keep-token') o.keepToken = true;
    else if (name === 'skip-kv-config') o.skipKvConfig = true;
    else if (name === 'print-config') o.printConfig = true;
    else if (name === 'skip-test') o.skipTest = true;
    else if (name === 'dry-run') o.dryRun = true;
    else if (name === 'assume-ns-ready' || name === 'yes') o.assumeNsReady = true;
    else if (name === 'help' || name === 'h') o.help = true;
    else o.positional.push(a);
  }
  return o;
}

const args = readArgs(process.argv.slice(2));
const env = process.env;
const slug = (n = 4) => randomBytes(n).toString('hex');

function loadState() {
  const f = args.stateFile || DEFAULT_STATE_FILE;
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
}
const state = loadState();

const config = {
  token: args.token || env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN,
  dashboardCookie: args.dashboardCookie || env.CF_DASH_COOKIE || '',
  dashboardAtok: args.dashboardAtok || env.CF_DASH_ATOK || '',
  dashboardVses2: args.dashboardVses2 || env.CF_DASH_VSES2 || env.VSES2,
  accountId: args.accountId || env.CF_ACCOUNT_ID || state.accountId,
  zoneName: args.zoneName || env.CF_ZONE_NAME || state.zoneName || args.positional[0] || '',
  hostname: args.hostname || env.CF_HOSTNAME || state.hostname || '',
  workerName: args.workerName || env.CF_WORKER_NAME || state.workerName || `edt-${slug(6)}`,
  kvTitle: args.kvTitle || env.CF_KV_TITLE || state.kvTitle || 'edgetunnel-kv',
  kvId: args.kvId || env.CF_KV_ID || state.kvId || '',
  workerSource: path.resolve(args.workerSource || env.EDT_WORKER_SOURCE || DEFAULT_WORKER_SOURCE),
  compatibilityDate: args.compatibilityDate || env.CF_COMPATIBILITY_DATE || DEFAULT_COMPATIBILITY_DATE,
  stateFile: args.stateFile || DEFAULT_STATE_FILE,
  credFile: args.credFile || DEFAULT_CRED_FILE,
  // 凭据：优先命令行/环境变量，其次复用 state（保证 --reconfigure 不改变 UUID）
  admin: args.admin || env.EDT_ADMIN || state.admin || slug(12) + slug(6),
  key: args.key || env.EDT_KEY || state.key || slug(8),
  uuid: args.uuid || env.EDT_UUID || state.uuid || '',
  nodes: Number.isFinite(args.nodes) ? args.nodes : (Number(env.EDT_NODES) || state.nodes || 500),
  // 订阅自动刷新间隔（小时）：写进 config 的 SUBUpdateTime，Worker 会随订阅响应下发
  // Profile-Update-Interval 头；v2rayN 的「订阅分组→自动更新间隔」按它或客户端设置定时拉取，
  // 不用进面板手动刷新。默认 2 小时（用户要求；注意随机IP模式下每次刷新节点 IP 全换）。
  subUpdateTime: Number.isFinite(args.subUpdateTime) ? args.subUpdateTime : (Number(env.EDT_SUB_UPDATE_TIME) || state.subUpdateTime || 2),
  port: Number.isFinite(args.port) ? args.port : -1,
  proxyip: args.proxyip || env.EDT_PROXYIP || state.proxyip || 'auto',
  nodePath: args.nodePath || env.EDT_PATH || state.nodePath || '/',
  transport: args.transport || env.EDT_TRANSPORT || state.transport || 'ws',
  protocol: args.protocol || env.EDT_PROTOCOL || state.protocol || 'vless',
  subName: args.subName || env.EDT_SUB_NAME || state.subName || 'EdgeTunnel',
  subapi: args.subapi || env.EDT_SUBAPI || state.subapi || 'https://SUBAPI.cmliussss.net',
  // SOCKS5 域名白名单只能走 env：_worker.js L2432 读的是模块级全局 SOCKS5白名单（L3），
  // config.json 里的 反代.SOCKS5.白名单 从不被读取，面板改它无效。L50-53 只从 env.GO2SOCKS5 追加。
  go2socks5: args.go2socks5 || env.EDT_GO2SOCKS5 || state.go2socks5 || '',
  reconfigure: !!args.reconfigure,
  destroy: !!args.destroy,
  revokeToken: !!args.revokeToken,
  keepToken: !!args.keepToken,
  skipKvConfig: !!args.skipKvConfig,
  printConfig: !!args.printConfig,
  skipTest: !!args.skipTest || env.SKIP_TEST === '1',
  dryRun: !!args.dryRun,
  assumeNsReady: !!args.assumeNsReady || env.ASSUME_NS_READY === '1',
};
config.zoneName = config.zoneName || '';
if (!config.hostname && config.zoneName) config.hostname = `${slug(4)}.${config.zoneName}`;

const userId = deriveUserId(config.admin, config.key, config.uuid);
const subToken = config.hostname ? deriveSubToken(config.hostname, userId) : '(待部署后计算)';

/* ────────────────────────────────────────────────────────────────
 * 3. 最优 config.json —— 针对 v2rayN + 大批量优选节点调校
 *    键名必须与 _worker.js L5599-5698 的默认配置逐字一致（含中文键）
 * ──────────────────────────────────────────────────────────────── */
function buildOptimalConfig(host) {
  const placeholder = '{{IP:PORT}}';
  return {
    TIME: new Date().toISOString(),
    HOST: host,
    HOSTS: [host],
    UUID: userId,
    PATH: config.nodePath,
    ALPN: '',
    // v2rayN 对 VLESS+WS+TLS 支持最成熟；Trojan 走 CF 兼容性差，SS 需 v2ray-plugin
    协议类型: config.protocol,
    传输协议: config.transport,
    gRPC模式: 'gun',
    gRPCUserAgent: '',
    跳过证书验证: false,
    // 0-RTT 的 ?ed=2560 主要服务 xHTTP/gRPC，WS 下 v2ray-core 不主动发，保持关闭
    启用0RTT: false,
    // fragment 是 Xray 节点级参数，不会从订阅 URL 生效，保持 null
    TLS分片: null,
    // 关键：Worker 的 WS 入站只判 Upgrade 头、不校验 path（L67），
    // 所以随机路径是纯伪装，客户端与 Worker 无需路径一致，抗封锁收益白拿
    随机路径: true,
    // v2rayN/GUI 对 ECH 支持不完整，开启易连不上
    ECH: false,
    ECHConfig: { DNS: 'https://dns.alidns.com/dns-query', SNI: 'cloudflare-ech.com' },
    SS: { 加密方式: 'aes-128-gcm', TLS: true },
    Fingerprint: 'chrome',
    优选订阅生成: {
      local: true,
      本地IP库: {
        随机IP: true,
        随机数量: config.nodes,
        // -1 = 在 [443,2053,2083,2087,2096,8443] 中随机，避免单端口被一锅端
        指定端口: config.port,
      },
      SUB: null,
      SUBNAME: config.subName,
      // 订阅自动刷新间隔：v2rayN 等客户端读取 Profile-Update-Interval 头自动更新，无需进面板
      SUBUpdateTime: config.subUpdateTime,
      TOKEN: deriveSubToken(host, userId),
    },
    订阅转换配置: {
      // 仅 clash/singbox/surge/loon/quanx 格式会用到；v2ray(mixed) 走本地生成，不经此后端
      SUBAPI: config.subapi,
      SUBCONFIG: 'https://raw.githubusercontent.com/cmliu/ACL4SSR/refs/heads/main/Clash/config/ACL4SSR_Online_Mini_MultiMode_CF.ini',
      SUBEMOJI: false,
      SUBLIST: true,
      UDP: false,
      XUDP: false,
      TLS13: false,
      APPEND_TYPE: false,
      SORT: false,
    },
    反代: {
      PROXYIP: config.proxyip,
      SOCKS5: {
        启用: null,
        全局: false,
        账号: '',
        白名单: ['*tapecontent.net', '*cloudatacdn.com', '*loadshare.org', '*cdn-centaurus.com', 'scholar.google.com'],
      },
      路径模板: {
        PROXYIP: 'proxyip=' + placeholder,
        SOCKS5: { 全局: 'socks5://' + placeholder, 标准: 'socks5=' + placeholder },
        HTTP: { 全局: 'http://' + placeholder, 标准: 'http=' + placeholder },
        HTTPS: { 全局: 'https://' + placeholder, 标准: 'https=' + placeholder },
        TURN: { 全局: 'turn://' + placeholder, 标准: 'turn=' + placeholder },
        SSTP: { 全局: 'sstp://' + placeholder, 标准: 'sstp=' + placeholder },
      },
    },
    TG: { 启用: false, BotToken: null, ChatID: null },
    CF: {
      Email: null, GlobalAPIKey: null, AccountID: null, APIToken: null, UsageAPI: null,
      Usage: { success: false, pages: 0, workers: 0, total: 0, max: 100000 },
    },
  };
}

/* ────────────────────────────────────────────────────────────────
 * 4. 通用输出与 API 层
 * ──────────────────────────────────────────────────────────────── */
const log = (step, msg) => console.log(`[${step}] ${msg}`);
const fail = (msg) => { console.error(`\n失败：${msg}`); process.exit(1); };

function extractCookieValue(cookie, name) {
  return String(cookie || '').split(';').map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}
function normalizeVses2(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  if (/;\s*$/.test(t) || /=/.test(t)) return t;
  return `vses2=${t};`;
}
const dashboardCookie = () => String(config.dashboardCookie || '').trim() || normalizeVses2(config.dashboardVses2);
const sessionCookie = ({ cookie, vses2 } = {}) => String(cookie || '').trim() || normalizeVses2(vses2);
const hasFullDashboardCookie = () => {
  const c = String(config.dashboardCookie || '');
  return c.includes('vses2=') && c.includes('cf_clearance=');
};

function errorDetail(body, fallback) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  if (errors.length) {
    return errors.map((e) => {
      const m = e.message || JSON.stringify(e);
      if (/<html|<!DOCTYPE html|Attention Required|been blocked/i.test(m)) {
        return 'dash.cloudflare.com 返回了安全拦截页；请从浏览器请求里复制完整 Cookie 并传 --cookie，必要时同时传 --atok。';
      }
      return `${e.code ? `${e.code}: ` : ''}${m}`;
    }).join('; ');
  }
  return body && Object.keys(body).length ? JSON.stringify(body) : fallback;
}

async function parseApiResponse(response, endpoint) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { success: false, errors: [{ message: text || response.statusText }] }; }
  if (!response.ok || body.success === false) throw new Error(`${endpoint} -> ${errorDetail(body, response.statusText)}`);
  return body.result;
}

const materializeOptions = (o) => ({ ...o, body: typeof o.body === 'function' ? o.body() : o.body });

/**
 * Cloudflare 边缘对数据中心新连接偶发 reset（fetch failed 且无 HTTP 响应）。
 * 只在 fetch() 本身抛网络错误时重试 —— HTTP 响应到达后的业务错误（parseApiResponse）不重试。
 */
async function fetchRetry(url, init, { attempts = 3, baseDelayMs = 800 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        log('net', `请求 ${url} 失败（${e.message}），${i + 2}/${attempts} 次重试…`);
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

async function bearerFetch(endpoint, options = {}) {
  const ro = materializeOptions(options);
  const headers = { Authorization: `Bearer ${config.token}`, ...(ro.headers || {}) };
  if (!(ro.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  return parseApiResponse(await fetchRetry(`${API_BASE}${endpoint}`, { ...ro, headers }), endpoint);
}

async function dashboardSessionFetch(endpoint, { accountId, vses2, cookie, atok, method = 'GET', body } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Cookie: sessionCookie({ cookie, vses2 }),
    Origin: 'https://dash.cloudflare.com',
    Referer: accountId ? `https://dash.cloudflare.com/${accountId}` : 'https://dash.cloudflare.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'x-cross-site-security': 'dash',
  };
  if (atok) headers['x-atok'] = atok;
  return parseApiResponse(await fetchRetry(`${DASH_API_BASE}${endpoint}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), endpoint);
}

async function cfFetch(endpoint, options = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await bearerFetch(endpoint, options); } catch (error) {
      lastErr = error;
      if (endpoint === '/zones' && /zone\.create/i.test(error.message) && !hasFullDashboardCookie()) {
        throw new Error(`${error.message}\nToken 缺少添加 Zone 的权限：传 --cookie '完整浏览器 Cookie'（必要时加 --atok）让脚本自动建带权限的 Token，或先在后台手动添加 ${config.zoneName} 再重跑。`);
      }
      // 刚创建的 API Token 需要几秒传播才能生效，期间写操作会报 10000/9109 鉴权错误；
      // 网络层抖动（fetch failed）也在此一并吸收。有界重试，避免死循环。
      const transient = /(?:10000|9109|10021)\b|Authentication error|fetch failed/i.test(error.message);
      if (transient && attempt < 3) {
        const delayMs = 2000 * attempt; // 2s / 4s
        log('net', `${endpoint} 失败（${error.message}），${delayMs / 1000}s 后第 ${attempt + 1}/3 次重试`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw error;
    }
  }
  throw lastErr;
}

/* ────────────────────────────────────────────────────────────────
 * 5. 自动创建 API Token（沿用旧脚本的权限组解析，已加 KV 权限）
 * ──────────────────────────────────────────────────────────────── */
const normalizePermissionName = (v) => String(v || '').toLowerCase()
  .replace(WRITE_EDIT_WORD_RE, 'write').replace(/[^a-z0-9]+/g, ' ').trim();

function permissionNameCandidates(group) {
  const names = [group.name, ...(Array.isArray(group.names) ? group.names : []),
    ...(Array.isArray(group.aliases) ? group.aliases : [])].filter(Boolean);
  const out = [];
  for (const n of names) { out.push(n); out.push(String(n).replace(/\bWrite\b/g, 'Edit')); out.push(String(n).replace(/\bEdit\b/g, 'Write')); }
  return [...new Set(out)];
}

function scopesFromResources(resources = {}) {
  const scopes = new Set();
  for (const r of Object.keys(resources)) {
    if (r.startsWith('com.cloudflare.api.account.zone')) scopes.add('com.cloudflare.api.account.zone');
    else if (r.startsWith('com.cloudflare.api.account')) scopes.add('com.cloudflare.api.account');
    else if (r.startsWith('com.cloudflare.api.user')) scopes.add('com.cloudflare.api.user');
  }
  return [...scopes];
}

async function listPermissionGroups({ accountId, vses2, cookie, atok, name, scope } = {}) {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (scope) params.set('scope', scope);
  params.set('per_page', '1000');
  const qs = params.toString();
  return dashboardSessionFetch(`/user/tokens/permission_groups${qs ? `?${qs}` : ''}`, { accountId, vses2, cookie, atok });
}

/** 每个 scope 只拉一次全量权限组并缓存，避免旧脚本 27 次串行请求 */
async function buildPermissionIndex(session, scopes) {
  const index = new Map();
  for (const scope of scopes.length ? scopes : ['']) {
    const groups = await listPermissionGroups({ ...session, scope });
    for (const g of groups) {
      const key = normalizePermissionName(g.name);
      if (!index.has(key)) index.set(key, g);
      for (const alt of permissionNameCandidates(g)) {
        const k2 = normalizePermissionName(alt);
        if (!index.has(k2)) index.set(k2, g);
      }
    }
  }
  return index;
}

async function createApiTokenFromDashboardSession({ accountId, vses2, cookie, atok } = {}) {
  if (!ACCOUNT_ID_RE.test(accountId || '')) throw new Error('缺少或非法的 Cloudflare account id。');
  if (!sessionCookie({ cookie, vses2 })) throw new Error('缺少登录态。用 --vses2 传入，或用 --cookie 传入完整 Cookie。');
  const session = { accountId, vses2, cookie, atok };
  const policies = [];
  for (const policy of DEFAULT_TOKEN_PAYLOAD.policies) {
    const wantedScopes = scopesFromResources(policy.resources);
    const index = await buildPermissionIndex(session, wantedScopes);
    const groups = [];
    for (const g of policy.permission_groups) {
      let hit = null;
      for (const cand of permissionNameCandidates(g)) {
        hit = index.get(normalizePermissionName(cand));
        if (hit?.id) break;
      }
      if (!hit?.id) {
        const all = [...index.values()].map((x) => x.name).sort().join('\n');
        throw new Error(`找不到权限组：${g.name}\n\n当前账号可见权限组：\n${all || '(空)'}`);
      }
      groups.push({ id: hit.id });
    }
    policies.push({ ...policy, permission_groups: groups });
  }
  const result = await dashboardSessionFetch('/user/tokens', {
    accountId, vses2, cookie, atok, method: 'POST', body: { ...DEFAULT_TOKEN_PAYLOAD, policies },
  });
  const token = result?.value || result?.token;
  if (!token) throw new Error('Cloudflare 创建了 Token，但响应里没有返回 value。');
  return { token, name: result.name || DEFAULT_TOKEN_PAYLOAD.name, id: result.id || null };
}

async function ensureApiToken() {
  if (config.token) return;
  if (config.dryRun) { config.token = '(dry-run)'; log('0', '[dry-run] 跳过 API Token 创建（这是写操作）'); return; }
  log('0', '用 dashboard session 创建带 KV 权限的 API Token');
  const created = await createApiTokenFromDashboardSession({
    accountId: config.accountId, vses2: config.dashboardVses2,
    cookie: config.dashboardCookie, atok: config.dashboardAtok,
  });
  config.token = created.token;
  state.tokenId = created.id;
  state.tokenName = created.name;
  log('0', `API Token 已创建：${created.name} (id=${created.id})`);
}

/* ────────────────────────────────────────────────────────────────
 * 6. KV 命名空间 / Worker 部署 / 配置写入
 * ──────────────────────────────────────────────────────────────── */
async function ensureKvNamespace() {
  if (config.kvId) { log('2', `复用 KV 命名空间 id=${config.kvId}`); return config.kvId; }
  if (config.dryRun) { log('2', `[dry-run] 将查找或创建 KV 命名空间「${config.kvTitle}」`); return '(dry-run)'; }
  const found = await cfFetch(`/accounts/${config.accountId}/storage/kv/namespaces?per_page=100`);
  const hit = (found || []).find((ns) => ns.title === config.kvTitle);
  if (hit) { config.kvId = hit.id; log('2', `找到已存在的 KV：${config.kvTitle} -> ${hit.id}`); return hit.id; }
  const created = await cfFetch(`/accounts/${config.accountId}/storage/kv/namespaces`, {
    method: 'POST', body: JSON.stringify({ title: config.kvTitle, support_url: 'https://github.com/cmliu/edgetunnel' }),
  });
  config.kvId = created.id;
  log('2', `KV 命名空间已创建：${config.kvTitle} -> ${created.id}`);
  return created.id;
}

async function deployWorker(source) {
  const kvId = await ensureKvNamespace();
  if (config.dryRun) { log('3', `[dry-run] 将部署 Worker ${config.workerName}（含 KV 绑定 + ADMIN/KEY 变量）`); return; }
  const bindings = [
    { type: 'plain_text', name: 'ADMIN', text: String(config.admin) },
    { type: 'plain_text', name: 'KEY', text: String(config.key) },
    // --uuid / EDT_UUID 必须注入 env.UUID，否则 Worker 永远用 ADMIN+KEY 派生（_worker.js L33-34），
    // 与本脚本本地预计算的 userId 不一致，/version 探针必然失败。只有显式传了才绑。
    ...(config.uuid ? [{ type: 'plain_text', name: 'UUID', text: String(config.uuid) }] : []),
    // edgetunnel 的 /sub 在 if(env.KV) 分支内，KV 是订阅功能的硬依赖
    { type: 'kv_namespace', name: 'KV', namespace_id: kvId },
    // 关掉 KV 日志写入：CF 免费额度只有 1000 次写/天，500 节点订阅会打爆
    { type: 'plain_text', name: 'OFF_LOG', text: '1' },
    { type: 'plain_text', name: 'PRELOAD_RACE_DIAL', text: '1' },
  ];
  // 白名单唯一有效入口（见上方注释）
  if (config.go2socks5) bindings.push({ type: 'plain_text', name: 'GO2SOCKS5', text: String(config.go2socks5) });
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: config.compatibilityDate,
    // 注意：upstream wrangler.toml 没有任何 compatibility_flags，这里也不加。
    // edgetunnel 不用 cloudflare:sockets，而是走未文档化的 request.fetcher.connect()（_worker.js L3329-3334），
    // 因此既不需要 nodejs_compat，也不依赖 sockets 权限。
    bindings,
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([source], { type: 'application/javascript+module' }), 'worker.js');
  log('3', `部署 Worker：${config.workerName}（源码 ${(source.length / 1024).toFixed(0)}KB）`);
  await cfFetch(`/accounts/${config.accountId}/workers/scripts/${config.workerName}`, { method: 'PUT', body: () => form });
  log('3', 'Worker 已上传，ADMIN/KEY/KV 绑定已随脚本一并写入');
}

async function writeKvConfig(host) {
  if (config.skipKvConfig) { log('4', '已按 --skip-kv-config 跳过配置写入'); return; }
  const cfg = buildOptimalConfig(host);
  if (config.printConfig) {
    writeFileSync(path.resolve('edgetunnel.config.json'), JSON.stringify(cfg, null, 2), 'utf8');
    log('4', '最优配置已导出到 edgetunnel.config.json');
  }
  if (config.dryRun) { log('4', `[dry-run] 将把 config.json 写入 KV（节点数 ${config.nodes}）`); return; }
  // 注意：CF KV 的 values/{key} 端点把请求体【原样】存为值，不会解包 {"value": ...}。
  // 之前用 { value: ... } 包装导致 Worker JSON.parse 得到 {value: "..."}，订阅 500（读取config_JSON L5713）。
  // 正确做法：body 直接就是 config JSON 字符串。
  const endpoint = `/accounts/${config.accountId}/storage/kv/namespaces/${config.kvId}/values/config.json`;
  await cfFetch(endpoint, { method: 'PUT', body: JSON.stringify(cfg, null, 2) });
  log('4', `config.json 已写入 KV：协议=${config.protocol} 传输=${config.transport} 节点数=${config.nodes} 随机路径=on`);
}

async function findZone() {
  if (config.dryRun) {
    log('1', `[dry-run] 跳过全部 API 调用。计划：查/建 Zone ${config.zoneName} → 建/复用 KV「${config.kvTitle}」→ 部署 Worker ${config.workerName} → 写 config.json → AAAA 100:: → Route ${config.hostname}/*`);
    return { id: '(dry-run)', name_servers: [] };
  }
  log('1', `查找 Zone：${config.zoneName}`);
  const result = await cfFetch(`/zones?name=${encodeURIComponent(config.zoneName)}&account.id=${encodeURIComponent(config.accountId)}`);
  let zone = result?.[0];
  if (!zone) {
    if (config.dryRun) { log('1', `[dry-run] 将添加 Zone ${config.zoneName}`); return { id: '(dry-run)', name_servers: [] }; }
    log('1', `账号里还没有这个 Zone，正在添加：${config.zoneName}`);
    zone = await cfFetch('/zones', { method: 'POST', body: JSON.stringify({ name: config.zoneName, account: { id: config.accountId }, type: 'full' }) });
  }
  log('1', `Zone ID：${zone.id}${zone.status ? `  状态：${zone.status}` : ''}`);
  const ns = zone.name_servers || zone.original_name_servers || [];
  if (ns.length) log('1', `Cloudflare 分配的 NS：${ns.join(', ')}`);
  return zone;
}

async function ensureDnsRecord(zoneId) {
  if (config.dryRun) { log('5', `[dry-run] 将创建 DNS：${config.hostname} AAAA 100:: proxied`); return; }
  const existing = await cfFetch(`/zones/${zoneId}/dns_records?type=AAAA&name=${encodeURIComponent(config.hostname)}`);
  const body = { type: 'AAAA', name: config.hostname, content: '100::', ttl: 1, proxied: true };
  if (existing?.[0]?.id) {
    await cfFetch(`/zones/${zoneId}/dns_records/${existing[0].id}`, { method: 'PUT', body: JSON.stringify(body) });
    log('5', 'DNS 已更新');
  } else {
    await cfFetch(`/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify(body) });
    log('5', `DNS 已创建：${config.hostname}`);
  }
}

async function ensureWorkerRoute(zoneId) {
  const pattern = `${config.hostname}/*`;
  if (config.dryRun) { log('6', `[dry-run] 将绑定 Worker Route：${pattern} -> ${config.workerName}`); return; }
  const routes = await cfFetch(`/zones/${zoneId}/workers/routes`);
  const existing = routes?.find((r) => r.pattern === pattern);
  const body = { pattern, script: config.workerName };
  if (existing?.id) {
    await cfFetch(`/zones/${zoneId}/workers/routes/${existing.id}`, { method: 'PUT', body: JSON.stringify(body) });
    log('6', `Worker Route 已更新：${pattern}`);
  } else {
    await cfFetch(`/zones/${zoneId}/workers/routes`, { method: 'POST', body: JSON.stringify(body) });
    log('6', `Worker Route 已创建：${pattern} -> ${config.workerName}`);
  }
}

/* ────────────────────────────────────────────────────────────────
 * 7. 订阅校验：必须拿到 v2rayN 能吃的 base64 vless 链接
 * ──────────────────────────────────────────────────────────────── */
async function confirmNameServersReady(zone) {
  const ns = zone.name_servers || zone.original_name_servers || [];
  if (!ns.length || config.assumeNsReady) {
    if (ns.length) log('7', `已跳过 NS 确认：${ns.join(', ')}`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(`开始 HTTPS 检查前需确认域名服务商 NS 已设为：${ns.join(', ')}。非交互环境请加 --assume-ns-ready。`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n开始订阅检查前，确认域名服务商里的 NS 已改成 Cloudflare 分配的这两条：');
    for (const n of ns) console.log(`- ${n}`);
    const a = await rl.question('确认设置好了？输入 y 继续，其他输入停止：');
    if (!/^y(?:es)?$/i.test(a.trim())) fail('先去域名服务商改 NS，保存后重新运行。');
  } finally { rl.close(); }
}

/**
 * /version 探针 —— 最理想的部署校验点。
 * 它位于 _worker.js 最外层 if-else 链（L54-66），在 if(env.KV) 分支【之外】，
 * 所以不依赖 KV、不依赖登录态，能单独确认「Worker 活着 + ADMIN/KEY 派生的 UUID 正确」。
 * 匹配逻辑（L58-65）：前 8 位 hex 求和相等 且 后 12 位精确相等 → 返回 {Version:<数字>}
 */
async function probeVersion(host, { timeoutMs = 15000 } = {}) {
  const url = `https://${host}/version?uuid=${userId}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'deploy-probe/1.0' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const text = (await res.text()).trim();
  if (res.status !== 200) return { ok: false, status: res.status, text };
  let version = null;
  try { version = JSON.parse(text)?.Version ?? null; } catch { /* 非 JSON */ }
  return { ok: version !== null, status: res.status, version, text };
}

/** 拉一次订阅，返回 { count, sample, bytes, plain } */
async function fetchSubscription(host, token, { ua = 'v2rayN/7.10.1', timeoutMs = 25000 } = {}) {  const url = `https://${host}/sub?token=${token}`;
  const res = await fetch(url, { headers: { 'User-Agent': ua }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = (await res.text()).trim();
  let plain = text;
  // L485：非 mozilla UA 会 btoa()。解不出来就当明文。
  try {
    const d = Buffer.from(text, 'base64').toString('utf8');
    if (d.includes('://')) plain = d;
  } catch { /* 明文 */ }
  const lines = plain.split(/\r?\n/).filter((l) => l.trim());
  return {
    count: lines.length,
    bytes: Buffer.byteLength(plain, 'utf8'),
    sample: lines[0] || '',
    plain,
    status: res.status,
    updateInterval: res.headers.get('profile-update-interval'),
    userinfo: res.headers.get('subscription-userinfo'),
  };
}

async function verifySubscription(host) {
  const token = deriveSubToken(host, userId);

  // 第一段：/version —— 不依赖 KV，先确认 Worker 本体与凭据派生
  log('7', '探针 1/2 /version（校验 Worker 存活 + ADMIN/KEY 派生的 UUID）');
  let versionOk = false;
  for (let i = 1; i <= 8; i += 1) {
    try {
      const v = await probeVersion(host);
      if (v.ok) { log('7', `  Worker 在线，Version=${v.version}，UUID 派生一致`); versionOk = true; break; }
      log('7', `  第 ${i} 次：HTTP ${v.status} 响应=${v.text.slice(0, 60) || '(空)'}（等 DNS/证书/路由生效）`);
    } catch (e) { log('7', `  第 ${i} 次：${e.message}`); }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!versionOk) {
    fail(`/version 探针始终未通过。Worker 未生效或 ADMIN/KEY 不匹配。请确认：
  1) Zone 已激活、域名服务商 NS 已改成 Cloudflare 分配的那两条
  2) Worker Route 已绑定 ${host}/*
  3) 部署时用的 --admin/--key 与本次一致（不一致会导致 UUID 派生不同，探针必然失败）
  手动核对：curl -s "https://${host}/version?uuid=${userId}"`);
  }

  // 第二段：/sub —— 依赖 KV，确认订阅链路（含 config.json 生效）
  log('7', '探针 2/2 /sub（校验 KV 绑定 + config.json 生效 + v2rayN 格式）');
  for (let i = 1; i <= 10; i += 1) {
    try {
      const r = await fetchSubscription(host, token);
      const mine = r.plain.includes(`${userId}@`);
      if (r.count > 3 && mine) {
        log('7', `  订阅正常：${r.count} 个节点，明文 ${(r.bytes / 1024).toFixed(0)}KB，自动刷新 ${r.updateInterval || '?'}h`);
        log('7', `  首条样例：${r.sample.slice(0, 110)}…`);
        return r;
      }
      log('7', `  第 ${i} 次：节点 ${r.count} 个 / UUID 命中=${mine}${r.count <= 3 ? ` 响应前缀=${r.plain.slice(0, 70)}` : ''}`);
    } catch (e) {
      log('7', `  第 ${i} 次：${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  fail(`Worker 在线但订阅链路不通（/version 已过、/sub 未过）。这个组合几乎只有一个原因：
  KV 绑定缺失或 config.json 未写入 —— edgetunnel 的 /sub 在 if(env.KV) 分支内（_worker.js L84），
  没有 KV 时 /sub 直接落到 404 伪装页。
  核对：node deploy-edgetunnel.mjs --reconfigure --hostname ${host} --kv-id <你的KV id>`);
}

/* ────────────────────────────────────────────────────────────────
 * 8. 运维：撤销 Token / 拆除
 * ──────────────────────────────────────────────────────────────── */
async function revokeToken() {
  // 优先按 state.tokenId 删除（用户级 Token 正确端点是 /user/tokens/{id}）。
  // 纯撤销模式不再先创建新 Token（旧逻辑会建了再删、还覆盖 state.tokenId）。
  if (state.tokenId) {
    try {
      if (config.token) {
        await bearerFetch(`/user/tokens/${state.tokenId}`, { method: 'DELETE' });
      } else if (dashboardCookie()) {
        await dashboardSessionFetch(`/user/tokens/${state.tokenId}`, {
          method: 'DELETE', accountId: config.accountId,
          vses2: config.dashboardVses2, cookie: config.dashboardCookie, atok: config.dashboardAtok,
        });
      } else {
        log('revoke', `state 记录了 tokenId=${state.tokenId}，但缺少 --api-token 或 --vses2/--cookie，无法删除`);
        return;
      }
      log('revoke', `已删除 Token：${state.tokenId}`);
      return;
    } catch (e) {
      if (/404|1000[345]|does not exist/i.test(e.message)) {
        log('revoke', `Token ${state.tokenId} 已不存在（可能已删），跳过`);
        return;
      }
      log('revoke', `按 id 删除失败（${e.message}），尝试按值撤销`);
    }
  }
  if (!config.token) { log('revoke', '当前没有 Token 可撤销'); return; }
  try {
    await bearerFetch('/user/tokens/value', { method: 'DELETE' });
    log('revoke', '部署 Token 已撤销');
  } catch (e) { log('revoke', `撤销失败：${e.message}`); }
}

async function destroy() {
  const { hostname, workerName, kvId } = state;
  if (!workerName && !hostname) fail('state 文件里没有可拆除的资源记录。');
  // reconfigure 路径的 state 可能没有 zoneId：按 hostname 的注册域后缀反查 Zone
  let zoneId = state.zoneId;
  if (!zoneId && hostname) {
    const suffix = hostname.split('.').slice(-2).join('.');
    const zones = await cfFetch(`/zones?name=${encodeURIComponent(suffix)}`).catch(() => []);
    if (zones?.length) {
      zoneId = zones[0].id;
      log('destroy', `state 缺 zoneId，按 ${suffix} 解析到 ${zoneId}`);
    }
  }
  log('destroy', `拆除：route=${hostname ? `${hostname}/*` : '无'} dns=${hostname || '无'} worker=${workerName || '无'} kv=${kvId || '保留'}`);
  if (config.dryRun) { log('destroy', '[dry-run] 以上资源将被删除，KV 命名空间默认保留'); return; }
  if (zoneId && hostname) {
    const routes = await cfFetch(`/zones/${zoneId}/workers/routes`).catch(() => []);
    const rt = routes?.find((r) => r.pattern === `${hostname}/*`);
    if (rt) await cfFetch(`/zones/${zoneId}/workers/routes/${rt.id}`, { method: 'DELETE' }).then(() => log('destroy', 'Worker Route 已删除')).catch((e) => log('destroy', `Route 删除失败：${e.message}`));
    const recs = await cfFetch(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`).catch(() => []);
    for (const rec of recs || []) {
      await cfFetch(`/zones/${zoneId}/dns_records/${rec.id}`, { method: 'DELETE' }).catch(() => {});
    }
    log('destroy', `DNS 记录已清理（${(recs || []).length} 条）`);
  }
  if (workerName) {
    await cfFetch(`/accounts/${config.accountId}/workers/scripts/${workerName}`, { method: 'DELETE' })
      .then(() => log('destroy', `Worker ${workerName} 已删除`))
      .catch((e) => log('destroy', `Worker 删除失败：${e.message}`));
  }
  if (args.destroy === true && env.EDT_DROP_KV === '1' && kvId) {
    await cfFetch(`/accounts/${config.accountId}/storage/kv/namespaces/${kvId}`, { method: 'DELETE' })
      .then(() => log('destroy', 'KV 命名空间已删除')).catch((e) => log('destroy', `KV 删除失败：${e.message}`));
  } else log('destroy', 'KV 命名空间已保留（要删设 EDT_DROP_KV=1）');
  if (!config.keepToken) await revokeToken();
}

/* ────────────────────────────────────────────────────────────────
 * 9. 落盘
 * ──────────────────────────────────────────────────────────────── */
function saveState(extra = {}) {
  const merged = {
    ...state,
    accountId: config.accountId,
    zoneName: config.zoneName,
    zoneId: extra.zoneId ?? state.zoneId,
    hostname: config.hostname,
    workerName: config.workerName,
    kvTitle: config.kvTitle,
    kvId: config.kvId || state.kvId,
    admin: config.admin,
    key: config.key,
    nodes: config.nodes,
    port: config.port,
    subUpdateTime: config.subUpdateTime,
    proxyip: config.proxyip,
    nodePath: config.nodePath,
    transport: config.transport,
    protocol: config.protocol,
    subName: config.subName,
    subapi: config.subapi,
    go2socks5: config.go2socks5,
    uuid: userId,
    subToken: deriveSubToken(config.hostname, userId),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(config.stateFile, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function saveCredentials() {
  const doc = {
    警告: '本文件含订阅凭据，不要提交到仓库、不要发给任何人。',
    订阅地址_v2rayN: `https://${config.hostname}/${config.key}`,
    订阅地址_直连: `https://${config.hostname}/sub?token=${deriveSubToken(config.hostname, userId)}`,
    管理面板: `https://${config.hostname}/admin`,
    ADMIN: config.admin,
    KEY: config.key,
    VLESS_UUID: userId,
    节点数: config.nodes,
    Worker: config.workerName,
    KV命名空间: config.kvId || state.kvId,
    TokenId: state.tokenId || null,
  };
  writeFileSync(config.credFile, JSON.stringify(doc, null, 2), 'utf8');
  return doc;
}

function printResult() {
  const sub = `https://${config.hostname}/${config.key}`;
  console.log('\n' + '='.repeat(72));
  console.log('部署完成。v2rayN 直接用这个地址：\n');
  console.log(`  ${sub}`);
  console.log('\n  → v2rayN：订阅设置 → 添加订阅 → 粘贴上面地址 → 更新订阅');
  console.log(`  → 该路径由 env.KEY 决定，等价于 /sub?token=${deriveSubToken(config.hostname, userId)}`);
  console.log(`\n管理面板：https://${config.hostname}/admin   （ADMIN=${config.admin}）`);
  console.log(`  注意：面板前端 HTML 由 https://edt-pages.github.io 远程加载，该站挂了不影响订阅，只影响面板。`);
  console.log(`\n当前实例参数：UUID=${userId}  节点数=${config.nodes}  协议=${config.protocol}/${config.transport}  反代=${config.proxyip}`);
  console.log(`凭据已写入：${config.credFile}   state：${config.stateFile}`);
  console.log('='.repeat(72));
  console.log('\n500 节点必须知道的三件事：');
  console.log('  1. 订阅明文约 113KB / base64 约 151KB，v2rayN 拉取没问题，但「测试真延迟」要逐个连 500 次，');
  console.log('     一轮下来几分钟，且会打出 500 个 Worker 请求。测速请用「测试可用TTFB」或只测选中分组。');
  console.log('  2. 随机优选 IP 每次拉订阅都重新生成 —— 节点名不变（CF电信优选1..N 之类）但 IP 全换，');
  console.log('     所以测速结果无法复用。想要稳定节点，把实测低延迟的 IP 写进 KV 的 ADD.txt 并把 随机IP 设为 false。');
  console.log('  3. 必须在【直连、没开任何代理】的状态下拉订阅。edgetunnel 按访客 ASN 自动选运营商 IP 池');
  console.log('     （_worker.js L5845-5873），挂了梯子再刷新会退化成 CF 官方全量池，拿不到运营商优化线路。');
  console.log('='.repeat(72));
}

/* ────────────────────────────────────────────────────────────────
 * 10. 前置校验与主流程
 * ──────────────────────────────────────────────────────────────── */
function ensureConfig() {
  if (args.help) { usage(); process.exit(0); }
  if (config.compatibilityDate < MIN_COMPATIBILITY_DATE) {
    fail(`compatibility_date 必须 >= ${MIN_COMPATIBILITY_DATE}（edgetunnel 要求），当前 ${config.compatibilityDate}`);
  }
  if (config.destroy) {
    if (!config.accountId) fail('拆除需要 --account-id 或 state 文件里有记录。');
    if (!config.token && !dashboardCookie()) fail('拆除需要 --api-token 或 --vses2/--cookie。');
    return;
  }
  // dry-run 只打印计划，不该要求凭据，也不该要求源文件之外的东西
  if (!config.accountId && !config.dryRun) fail('缺少 --account-id（或用 state 文件记住）。');
  if (!config.token && !dashboardCookie() && !config.dryRun) fail('缺少 --api-token；要让脚本自动建 Token，请提供 --vses2 或 --cookie。');
  // 规模/协议/端口/刷新间隔校验放在 reconfigure return 之前 —— reconfigure 同样用到这些参数
  if (!Number.isInteger(config.nodes) || config.nodes < 1 || config.nodes > 2000) fail('--nodes 需在 1..2000 之间。');
  if (!Number.isFinite(config.subUpdateTime) || config.subUpdateTime < 1 || config.subUpdateTime > 168) fail('--sub-update-time 需在 1..168（小时）之间。');
  if (!['vless', 'trojan', 'ss'].includes(config.protocol)) fail('--protocol 只能是 vless | trojan | ss');
  if (!['ws', 'grpc', 'xhttp'].includes(config.transport)) fail('--transport 只能是 ws | grpc | xhttp');
  if (config.port !== -1 && ![443, 2053, 2083, 2087, 2096, 8443, 80, 8080, 2052, 2082, 2086, 2095].includes(config.port)) {
    fail(`--port ${config.port} 不是 CF 支持的端口。可选：443 2053 2083 2087 2096 8443（TLS）/ 80 2052 2082 2086 2095 8080（非 TLS）；-1 表示随机。`);
  }
  if (config.reconfigure) return;
  if (!config.zoneName) fail('缺少根域名 --zone。edgetunnel 的 /sub、/admin、<KEY> 都靠域名路由。');
  if (!config.hostname.endsWith(config.zoneName)) fail(`--hostname 必须在 ${config.zoneName} 下面。`);
  if (!existsSync(config.workerSource) && !config.dryRun) fail(`找不到 Worker 源文件：${config.workerSource}\n先执行：curl -o _et/_worker.js https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js`);
}

function usage() {
  console.log(`edgetunnel 自动部署器

  node deploy-edgetunnel.mjs --account-id <ID> --vses2 <cookie> --zone <根域名> [选项]

凭据        --admin <密码>        后台密码 / UUID 派生因子（默认随机 36 位）
            --key <密钥>          订阅路径密钥，订阅地址即 https://<域名>/<key>（默认随机 16 位）
            --uuid <UUIDv4>       强制固定 UUID（覆盖 ADMIN+KEY 派生）
规模        --nodes <n>           优选节点数量，默认 500（1..2000）
            --port <p>            固定端口；-1 = 在 6 个 TLS 端口间随机（默认）
            --sub-update-time <h> 订阅自动刷新间隔小时数，默认 2（Worker 随响应下发
                                  Profile-Update-Interval 头；v2rayN 在订阅分组里也可设）
协议        --protocol <p>        vless | trojan | ss   （默认 vless）
            --transport <t>       ws | grpc | xhttp     （默认 ws）
            --path </p>           节点基础路径，默认 /
反代        --proxyip <host:port> 反代出口；默认 auto 走 {colo}.proxyip.cmliussss.net
            --go2socks5 <域名列表> 走 SOCKS5 的域名白名单（逗号分隔）。注意：此字段只能走环境变量，
                                  config.json 里的 反代.SOCKS5.白名单 不被 Worker 读取（L2432 读全局变量）
资源        --kv-title <名>       KV 命名空间名（默认 edgetunnel-kv）
            --kv-id <id>          复用已有 KV
            --worker-name <n>     Worker 名（默认随机 edt-xxxx）
            --worker-source <f>   Worker 源码路径（默认 _et/_worker.js）
运维        --reconfigure         只重写 KV 里的 config.json（改节点数用这个，别重新部署）
            --destroy             删除 Route/DNS/Worker，保留 KV
            --revoke-token        撤销本次创建的 API Token
            --print-config        额外导出 edgetunnel.config.json 便于审阅
            --dry-run             只打印计划
            --skip-kv-config      不写 config.json（用面板自己配）
            --assume-ns-ready     跳过 NS 交互确认
            --skip-test           跳过订阅校验
            --state-file / --cred-file   state 与凭据落盘路径

环境变量    CF_API_TOKEN CF_ACCOUNT_ID CF_ZONE_NAME CF_HOSTNAME EDT_ADMIN EDT_KEY EDT_NODES
            EDT_PROXYIP EDT_TRANSPORT EDT_PROTOCOL EDT_SUB_UPDATE_TIME EDT_DROP_KV=1（拆除时连 KV 一起删）`);
}

async function main() {
  ensureConfig();

  if (args.help) { usage(); return; }

  if (config.destroy) {
    log('destroy', '开始拆除');
    await ensureApiToken();
    await destroy(); // destroy() 内部已按 --keep-token 决定是否撤销
    return;
  }

  // 纯撤销：直接用 state.tokenId + 会话凭据，不创建新 Token
  if (config.revokeToken) { await revokeToken(); return; }

  await ensureApiToken();

  // 只改配置：不碰 Zone / Worker / DNS / Route
  if (config.reconfigure) {
    const host = config.hostname || state.hostname;
    if (!host) fail('--reconfigure 需要 state 文件里有 hostname，或显式传 --hostname');
    config.hostname = host;
    if (!config.kvId && !state.kvId) fail('--reconfigure 需要 KV 命名空间 id（state 文件缺失时用 --kv-id 指定）');
    config.kvId = config.kvId || state.kvId;
    log('reconfigure', `仅重写 KV 配置：${host}  节点数=${config.nodes}`);
    await writeKvConfig(host);
    saveState();
    saveCredentials();
    try {
      const r = await fetchSubscription(host, deriveSubToken(host, userId));
      log('reconfigure', `生效确认：${r.count} 个节点，明文 ${(r.bytes / 1024).toFixed(0)}KB`);
    } catch (e) { log('reconfigure', `订阅拉取校验失败（不影响配置已写入）：${e.message}`); }
    printResult();
    return;
  }

  if (config.revokeToken) { await revokeToken(); return; }

  let source = '';
  if (existsSync(config.workerSource)) {
    source = readFileSync(config.workerSource, 'utf8');
    if (!source.includes('export default')) fail('Worker 源码里没有 export default，源文件可能不完整。');
    log('src', `edgetunnel 源码就绪：${(source.length / 1024).toFixed(0)}KB  ${(source.match(/\n/g) || []).length} 行`);
  } else if (config.dryRun) {
    log('src', `[dry-run] 未找到 ${config.workerSource}，跳过读取`);
  } else {
    fail(`找不到 Worker 源文件：${config.workerSource}`);
  }

  const zone = await findZone();
  await deployWorker(source);
  await writeKvConfig(config.hostname);
  await ensureDnsRecord(zone.id);
  await ensureWorkerRoute(zone.id);
  await confirmNameServersReady(zone);
  if (!config.skipTest && !config.dryRun) await verifySubscription(config.hostname);

  if (config.dryRun) {
    console.log('\n[dry-run] 以上为执行计划，未产生任何云端或本地写入。去掉 --dry-run 即真正部署。');
    console.log(`[dry-run] 部署后 v2rayN 订阅地址将是：https://${config.hostname}/${config.key}`);
    console.log(`[dry-run] VLESS UUID=${userId}`);
    return;
  }
  saveState({ zoneId: zone.id });
  saveCredentials();
  printResult();
  if (!config.keepToken && state.tokenId) {
    console.log(`\n提示：本次自动创建的 API Token id=${state.tokenId} 仍有效。`);
    console.log('用完后执行：node deploy-edgetunnel.mjs --revoke-token');
  }
}

main().catch((e) => fail(`${e.message}${process.env.EDT_DEBUG_TRACE ? '\n' + e.stack : ''}`));
