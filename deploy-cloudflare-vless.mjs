#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const DASH_API_BASE = 'https://dash.cloudflare.com/api/v4';
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;
const DEFAULT_COMPATIBILITY_DATE = '2026-06-13';
const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';
const DEFAULT_WORKER_SOURCE = path.resolve('worker.fixed.js');
const WRITE_EDIT_WORD_RE = /\b(write|edit)\b/ig;
const DEFAULT_TOKEN_PAYLOAD = {
  name: '账号部署令牌',
  condition: {},
  policies: [
    {
      effect: 'allow',
      resources: {
        'com.cloudflare.api.account.*': '*',
      },
      permission_groups: [
        { name: 'Account Settings Read' },
        { name: 'Workers Scripts Read' },
        { name: 'Workers Scripts Write' },
      ],
    },
    {
      effect: 'allow',
      resources: {
        'com.cloudflare.api.account.zone.*': '*',
      },
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

function randomSlug(bytes = 5) {
  return randomBytes(bytes).toString('hex');
}

function readArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--zone') options.zoneName = argv[++i];
    else if (arg === '--account-id') options.accountId = argv[++i];
    else if (arg === '--vses2') options.dashboardVses2 = argv[++i];
    else if (arg === '--cookie') options.dashboardCookie = argv[++i];
    else if (arg === '--atok' || arg === '--x-atok') options.dashboardAtok = argv[++i];
    else if (arg === '--api-token') options.token = argv[++i];
    else if (arg === '--hostname') options.hostname = argv[++i];
    else if (arg === '--worker-name') options.workerName = argv[++i];
    else if (arg === '--uuid') options.uuid = argv[++i];
    else if (arg === '--proxy-name') options.proxyName = argv[++i];
    else if (arg === '--worker-source') options.workerSource = argv[++i];
    else if (arg === '--compatibility-date') options.compatibilityDate = argv[++i];
    else if (arg === '--test-url') options.testUrl = argv[++i];
    else if (arg === '--skip-test') options.skipTest = true;
    else if (arg === '--assume-ns-ready' || arg === '--yes') options.assumeNsReady = true;
    else options.positional.push(arg);
  }
  return options;
}

const env = process.env;
const args = readArgs(process.argv.slice(2));

function extractCookieValue(cookie, name) {
  return String(cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || '';
}

const config = {
  token: args.token || env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN,
  dashboardCookie: args.dashboardCookie || env.CF_DASH_COOKIE || '',
  dashboardAtok: args.dashboardAtok || env.CF_DASH_ATOK || '',
  dashboardVses2: args.dashboardVses2 || extractCookieValue(args.dashboardCookie || env.CF_DASH_COOKIE, 'vses2') || env.CF_DASH_VSES2 || env.CF_VSES2 || env.VSES2,
  accountId: args.accountId || env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID,
  zoneName: args.zoneName || env.CF_ZONE_NAME || env.ZONE_NAME || args.positional[0] || '',
  hostname: args.hostname || env.CF_HOSTNAME || env.HOSTNAME || '',
  workerName: args.workerName || env.CF_WORKER_NAME || env.WORKER_NAME || '',
  uuid: args.uuid || env.VLESS_UUID || randomUUID(),
  proxyName: args.proxyName || env.PROXY_NAME || `node-${randomSlug(4)}`,
  workerSource: path.resolve(args.workerSource || env.WORKER_SOURCE || DEFAULT_WORKER_SOURCE),
  compatibilityDate: args.compatibilityDate || env.CF_COMPATIBILITY_DATE || DEFAULT_COMPATIBILITY_DATE,
  testUrl: args.testUrl || env.TEST_URL || DEFAULT_TEST_URL,
  skipTest: args.skipTest || env.SKIP_TEST === '1' || env.NO_TEST === '1',
  assumeNsReady: args.assumeNsReady || env.ASSUME_NS_READY === '1',
};

if (!config.hostname && config.zoneName) config.hostname = `${randomSlug(4)}.${config.zoneName}`;
if (!config.workerName) config.workerName = `svc-${randomSlug(6)}`;

const clashConfig = ({ server, host }) => `port: 17990
socks-port: 17991
allow-lan: false
mode: rule
log-level: info

proxies:
  - name: "${config.proxyName}"
    type: vless
    server: ${server}
    port: 443
    uuid: ${config.uuid}
    network: ws
    tls: true
    udp: false
    sni: ${host}
    client-fingerprint: chrome
    ws-opts:
      path: "/"
      headers:
        host: ${host}

proxy-groups:
  - name: "PROXY"
    type: select
    proxies:
      - "${config.proxyName}"

rules:
  - MATCH,PROXY
`;

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

function fail(message) {
  console.error(`\n失败：${message}`);
  process.exit(1);
}

function normalizeVses2(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/;\s*$/.test(trimmed) || /=/.test(trimmed)) return trimmed;
  return `vses2=${trimmed};`;
}

function dashboardCookie() {
  return String(config.dashboardCookie || '').trim() || normalizeVses2(config.dashboardVses2);
}

function sessionCookie({ cookie, vses2 } = {}) {
  return String(cookie || '').trim() || normalizeVses2(vses2);
}

function hasFullDashboardCookie() {
  const cookie = String(config.dashboardCookie || '');
  return cookie.includes('vses2=') && cookie.includes('cf_clearance=');
}

function ensureConfig() {
  if (!config.accountId) fail('缺少 --account-id。');
  if (!config.token && !dashboardCookie()) {
    fail('缺少 --api-token；如果要让脚本自动创建 Token，请提供 --vses2 或 --cookie。');
  }
  if (!config.zoneName) {
    fail('缺少根域名。创建 API Token 不需要域名，但添加 Zone、DNS 和 Route 必须知道真实根域名；可以把它作为第一个参数传入。');
  }
  if (!config.hostname.endsWith(config.zoneName)) {
    fail(`--hostname 必须在 ${config.zoneName} 下面；如果不传，脚本会随机生成。`);
  }
  if (!existsSync(config.workerSource)) {
    fail(`找不到 Worker 源文件：${config.workerSource}`);
  }
}

async function ensureApiToken() {
  if (config.token) return;
  log('0/7', '用 dashboard session 创建 API Token');
  const created = await createApiTokenFromDashboardSession({
    accountId: config.accountId,
    vses2: config.dashboardVses2,
    cookie: config.dashboardCookie,
    atok: config.dashboardAtok,
  });
  config.token = created.token;
  log('0/7', `API Token 已创建：${created.name}`);
}

function errorDetail(body, fallback) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  if (errors.length) {
    return errors.map((error) => {
      const message = error.message || JSON.stringify(error);
      if (/<html|<!DOCTYPE html|Attention Required|been blocked/i.test(message)) {
        return 'dash.cloudflare.com 返回了 Cloudflare 安全拦截页；请从浏览器请求里复制完整 Cookie 并传 --cookie，必要时同时传 --atok。';
      }
      return `${error.code ? `${error.code}: ` : ''}${message}`;
    }).join('; ');
  }
  return body && Object.keys(body).length ? JSON.stringify(body) : fallback;
}

async function parseApiResponse(response, endpoint) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { success: false, errors: [{ message: text || response.statusText }] };
  }
  if (!response.ok || body.success === false) {
    throw new Error(`${endpoint} -> ${errorDetail(body, response.statusText)}`);
  }
  return body.result;
}

function materializeOptions(options) {
  return {
    ...options,
    body: typeof options.body === 'function' ? options.body() : options.body,
  };
}

async function bearerFetch(endpoint, options = {}) {
  const requestOptions = materializeOptions(options);
  const headers = {
    Authorization: `Bearer ${config.token}`,
    ...(requestOptions.headers || {}),
  };
  if (!(requestOptions.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...requestOptions,
    headers,
  });
  return parseApiResponse(response, endpoint);
}

async function dashboardApiFetch(endpoint, options = {}) {
  const requestOptions = materializeOptions(options);
  const headers = {
    Cookie: dashboardCookie(),
    Origin: 'https://dash.cloudflare.com',
    Referer: `https://dash.cloudflare.com/${config.accountId}`,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'x-cross-site-security': 'dash',
    ...(requestOptions.headers || {}),
  };
  if (!(requestOptions.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (config.dashboardAtok) headers['x-atok'] = config.dashboardAtok;
  const response = await fetch(`https://dash.cloudflare.com/api/v4${endpoint}`, {
    ...requestOptions,
    headers,
  });
  return parseApiResponse(response, endpoint);
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
  const response = await fetch(`${DASH_API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return parseApiResponse(response, endpoint);
}

function normalizePermissionName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(WRITE_EDIT_WORD_RE, 'write')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function permissionNameCandidates(group) {
  const names = [
    group.name,
    ...(Array.isArray(group.names) ? group.names : []),
    ...(Array.isArray(group.aliases) ? group.aliases : []),
  ].filter(Boolean);
  const expanded = [];
  for (const name of names) {
    expanded.push(name);
    expanded.push(String(name).replace(/\bWrite\b/g, 'Edit'));
    expanded.push(String(name).replace(/\bEdit\b/g, 'Write'));
  }
  return [...new Set(expanded)];
}

function scopesFromResources(resources = {}) {
  const scopes = new Set();
  for (const resource of Object.keys(resources)) {
    if (resource.startsWith('com.cloudflare.api.account.zone')) {
      scopes.add('com.cloudflare.api.account.zone');
    } else if (resource.startsWith('com.cloudflare.api.account')) {
      scopes.add('com.cloudflare.api.account');
    } else if (resource.startsWith('com.cloudflare.api.user')) {
      scopes.add('com.cloudflare.api.user');
    } else if (resource.startsWith('com.cloudflare.edge.r2.bucket')) {
      scopes.add('com.cloudflare.edge.r2.bucket');
    }
  }
  return [...scopes];
}

function scopeMatches(permissionGroup, wantedScopes) {
  if (!wantedScopes.length) return true;
  const actualScopes = Array.isArray(permissionGroup.scopes) ? permissionGroup.scopes : [];
  return wantedScopes.some((scope) => actualScopes.includes(scope));
}

async function listPermissionGroups({ accountId, vses2, cookie, atok, name, scope }) {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (scope) params.set('scope', scope);
  params.set('per_page', '1000');
  const suffix = params.toString() ? `?${params}` : '';
  return dashboardSessionFetch(`/user/tokens/permission_groups${suffix}`, {
    accountId,
    vses2,
    cookie,
    atok,
  });
}

async function visiblePermissionNames(session, scopes) {
  const seen = new Set();
  const groups = [];
  for (const scope of scopes.length ? scopes : ['']) {
    for (const group of await listPermissionGroups({ ...session, scope })) {
      const key = `${group.id}:${group.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        groups.push(group);
      }
    }
  }
  return groups
    .map((group) => `${group.name}${group.scopes?.length ? ` [${group.scopes.join(', ')}]` : ''}`)
    .sort()
    .join('\n');
}

async function resolvePermissionGroup(group, wantedScopes, session) {
  if (group.id) return { id: group.id };
  const candidates = permissionNameCandidates(group);
  if (!candidates.length) throw new Error('permission_groups 里缺少 id 或 name。');

  for (const candidate of candidates) {
    const groups = await listPermissionGroups({
      ...session,
      name: candidate,
      scope: wantedScopes[0],
    });
    const match = groups.find((item) => normalizePermissionName(item.name) === normalizePermissionName(candidate) && scopeMatches(item, wantedScopes))
      || groups.find((item) => normalizePermissionName(item.name) === normalizePermissionName(candidate));
    if (match?.id) return { id: match.id };
  }

  const visible = await visiblePermissionNames(session, wantedScopes);
  throw new Error(`找不到权限组：${candidates.join(' / ')}${wantedScopes.length ? `（scope: ${wantedScopes.join(', ')}）` : ''}\n\n当前可见权限组：\n${visible || '(空)'}`);
}

async function resolveTokenPayload(payload, session) {
  const policies = [];
  for (const policy of payload.policies || []) {
    const wantedScopes = scopesFromResources(policy.resources);
    const permissionGroups = [];
    for (const group of policy.permission_groups || []) {
      permissionGroups.push(await resolvePermissionGroup(group, wantedScopes, session));
    }
    policies.push({
      ...policy,
      permission_groups: permissionGroups,
    });
  }
  return {
    ...payload,
    policies,
  };
}

async function createApiTokenFromDashboardSession({ accountId, vses2, cookie, atok } = {}) {
  if (!ACCOUNT_ID_RE.test(accountId || '')) {
    throw new Error('缺少或非法的 Cloudflare account id。');
  }
  if (!sessionCookie({ cookie, vses2 })) {
    throw new Error('缺少登录态。请用 --vses2 传入，或用 --cookie 传入完整 Cookie。');
  }

  const payload = await resolveTokenPayload(DEFAULT_TOKEN_PAYLOAD, {
    accountId,
    vses2,
    cookie,
    atok,
  });
  const result = await dashboardSessionFetch('/user/tokens', {
    accountId,
    vses2,
    cookie,
    atok,
    method: 'POST',
    body: payload,
  });
  const token = result?.value || result?.token;
  if (!token) throw new Error('Cloudflare 创建了 Token，但响应里没有返回 token value。');
  return {
    token,
    name: result.name || DEFAULT_TOKEN_PAYLOAD.name,
    id: result.id || null,
  };
}

async function cfFetch(endpoint, options = {}) {
  try {
    return await bearerFetch(endpoint, options);
  } catch (error) {
    if (endpoint === '/zones' && /zone\.create/i.test(error.message) && !hasFullDashboardCookie()) {
      throw new Error(`${error.message}\n当前 Token 仍然缺少添加 Zone 的权限。要继续自动添加 Zone，请传 --cookie '完整浏览器 Cookie'，必要时再传 --atok；或者先在 Cloudflare 后台手动添加 ${config.zoneName}，再重新运行。`);
    }
    if (!hasFullDashboardCookie() || options.dashboardFallback === false) throw error;
    log('auth', `Token 调用失败，改用 dashboard session：${endpoint}`);
    return dashboardApiFetch(endpoint, options);
  }
}

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: config.token,
        CLOUDFLARE_ACCOUNT_ID: config.accountId,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function prepareWorkerSource() {
  const source = await readFile(config.workerSource, 'utf8');
  const prepared = source
    .replace(/^\s*const uuid = '[^']+';.*$/m, `const uuid = '${config.uuid}';`)
    .replace(/^\s*\/\/.*(?:vless|trojan|密码|警告).*$/gim, '');
  if (!prepared.includes(`const uuid = '${config.uuid}';`)) {
    throw new Error('Worker 源码处理失败：没有生成 uuid 常量。');
  }
  return prepared;
}

async function findZone() {
  log('1/7', `查找 Zone：${config.zoneName}`);
  const result = await cfFetch(`/zones?name=${encodeURIComponent(config.zoneName)}&account.id=${encodeURIComponent(config.accountId)}`);
  let zone = result?.[0];
  if (!zone) {
    log('1/7', `账号里还没有这个 Zone，正在添加：${config.zoneName}`);
    zone = await cfFetch('/zones', {
      method: 'POST',
      body: JSON.stringify({
        name: config.zoneName,
        account: { id: config.accountId },
        type: 'full',
      }),
    });
  }
  log('1/7', `找到 Zone ID：${zone.id}`);
  if (zone.status && zone.status !== 'active') {
    log('1/7', `Zone 当前状态：${zone.status}`);
  }
  const nameServers = zone.name_servers || zone.original_name_servers || [];
  if (nameServers.length) {
    log('1/7', `Cloudflare 分配的 NS：${nameServers.join(', ')}`);
  }
  return zone;
}

async function deployWorker() {
  log('2/7', `部署 Worker：${config.workerName}`);
  const source = await prepareWorkerSource();
  const createForm = () => {
    const metadata = {
      main_module: 'worker.js',
      compatibility_date: config.compatibilityDate,
    };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('worker.js', new Blob([source], { type: 'application/javascript+module' }), 'worker.js');
    return form;
  };
  await cfFetch(`/accounts/${config.accountId}/workers/scripts/${config.workerName}`, {
    method: 'PUT',
    body: createForm,
  });
}

async function ensureDnsRecord(zoneId) {
  log('4/7', `创建或更新 DNS：${config.hostname}`);
  const existing = await cfFetch(`/zones/${zoneId}/dns_records?type=AAAA&name=${encodeURIComponent(config.hostname)}`);
  const body = {
    type: 'AAAA',
    name: config.hostname,
    content: '100::',
    ttl: 1,
    proxied: true,
  };
  if (existing?.[0]?.id) {
    await cfFetch(`/zones/${zoneId}/dns_records/${existing[0].id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    log('4/7', 'DNS 已更新');
  } else {
    await cfFetch(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    log('4/7', 'DNS 已创建');
  }
}

async function ensureWorkerRoute(zoneId) {
  const pattern = `${config.hostname}/*`;
  log('5/7', `创建或更新 Worker Route：${pattern}`);
  const routes = await cfFetch(`/zones/${zoneId}/workers/routes`);
  const existing = routes?.find((route) => route.pattern === pattern);
  const body = {
    pattern,
    script: config.workerName,
  };
  if (existing?.id) {
    await cfFetch(`/zones/${zoneId}/workers/routes/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    log('5/7', 'Worker Route 已更新');
  } else {
    await cfFetch(`/zones/${zoneId}/workers/routes`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    log('5/7', 'Worker Route 已创建');
  }
}

async function confirmNameServersReady(zone) {
  const nameServers = zone.name_servers || zone.original_name_servers || [];
  if (!nameServers.length) return;
  if (config.assumeNsReady) {
    log('6/7', `已按 --assume-ns-ready 跳过 NS 确认：${nameServers.join(', ')}`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(`开始 HTTPS 检查前需要确认域名服务商 NS 已设置为：${nameServers.join(', ')}。非交互环境请确认后加 --assume-ns-ready。`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n开始 HTTPS 检查前，先确认域名服务商里的 NS 已经改成 Cloudflare 分配的这两条：');
    for (const ns of nameServers) console.log(`- ${ns}`);
    const answer = await rl.question('确认已经设置好了？输入 y 继续检查，其他输入停止：');
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      fail('先去域名服务商把 NS 改成上面两条，等保存后再重新运行脚本。');
    }
  } finally {
    rl.close();
  }
}

async function waitForHttp() {
  log('6/7', `检查 Clash 订阅入口：https://${config.hostname}/`);
  for (let i = 1; i <= 10; i += 1) {
    try {
      const response = await fetch(`https://${config.hostname}/`, { redirect: 'manual' });
      const text = await response.text();
      if (response.ok && text.includes('proxies:') && text.includes('proxy-groups:') && text.includes(config.uuid)) {
        log('6/7', `Clash 订阅入口正常，状态码 ${response.status}`);
        return;
      }
      log('6/7', `第 ${i} 次：状态码 ${response.status}，继续等 DNS/路由生效`);
    } catch (error) {
      log('6/7', `第 ${i} 次：${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  fail('HTTPS 入口没有返回 Clash 订阅。通常是 Zone 还没激活，或域名服务商那边的 NS 没填成 Cloudflare 分配的那两条。');
}

async function testWithMihomo() {
  if (config.skipTest) {
    log('7/7', '已跳过 mihomo 测试');
    return null;
  }
  try {
    await run('mihomo', ['-v'], { capture: true });
  } catch {
    log('7/7', '本机没有 mihomo，跳过真实代理测试');
    return null;
  }

  log('7/7', `用 mihomo 测试：${config.testUrl}`);
  const dir = await mkdtemp(path.join(tmpdir(), 'svc-check-'));
  const configFile = path.join(dir, 'config.yaml');
  await writeFile(configFile, clashConfig({ server: config.hostname, host: config.hostname }));
  const logFile = path.join(dir, 'mihomo.log');

  const server = spawn('mihomo', ['-f', configFile, '-d', dir], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const chunks = [];
  server.stderr.on('data', (chunk) => chunks.push(chunk));

  try {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const curl = await run('curl', [
      '-sS',
      '--proxy',
      'http://127.0.0.1:17990',
      '--max-time',
      '20',
      config.testUrl,
      '-o',
      '/dev/null',
      '-w',
      'HTTP_CODE=%{http_code} TOTAL=%{time_total}\\n',
    ], { capture: true });

    await writeFile(logFile, Buffer.concat(chunks).toString('utf8'));
    const output = curl.stdout.trim();
    log('7/7', output);
    if (!output.includes('HTTP_CODE=204')) {
      throw new Error(`mihomo 测试没有返回 204：${output}`);
    }
    return output;
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('close', resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

function printResult() {
  console.log('\n完成。Clash/Mihomo 订阅地址：\n');
  console.log(`https://${config.hostname}/`);
  console.log('\n直接把这个地址导入 Clash Verge / Mihomo 即可。');
}

async function main() {
  ensureConfig();
  await ensureApiToken();
  const zone = await findZone();
  await deployWorker();
  await ensureDnsRecord(zone.id);
  await ensureWorkerRoute(zone.id);
  await confirmNameServersReady(zone);
  await waitForHttp();
  await testWithMihomo();
  printResult();
}

main().catch((error) => fail(error.message));
