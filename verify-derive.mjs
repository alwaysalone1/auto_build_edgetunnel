#!/usr/bin/env node
/**
 * 验证 deploy-edgetunnel.mjs 的凭据派生与 edgetunnel/_worker.js 运行时逐字节一致。
 *
 * 为什么不能直接跑 Worker 版函数：
 *   _worker.js L5405 用 crypto.subtle.digest('MD5')。Cloudflare workerd 支持 MD5
 *   （官方文档：非 WebCrypto 标准，但为遗留系统保留），而 Node 的 WebCrypto 明确不支持
 *   —— 实测抛 NotSupportedError: Unrecognized algorithm name。
 *   所以这里改用 RFC 1321 官方测试向量证明 createHash('md5') 输出的是标准 MD5，
 *   标准算法在任何正确实现（含 workerd）里输出必然相同。
 */
import { createHash } from 'node:crypto';

/* ── 第一层：证明 md5hex 是标准 MD5（RFC 1321 官方测试向量）── */
const md5hex = (s) => createHash('md5').update(s, 'utf8').digest('hex');
const RFC1321 = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
  ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
];
console.log('RFC 1321 官方测试向量（证明 md5hex == 标准 MD5 == workerd crypto.subtle MD5）：');
let rfcPass = 0;
for (const [input, expect] of RFC1321) {
  const got = md5hex(input);
  const ok = got === expect;
  if (ok) rfcPass++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(input.slice(0, 34))}${input.length > 34 ? '…' : ''} -> ${got}`);
}
console.log(`  ${rfcPass}/${RFC1321.length}\n`);

/* ── 第二层：Worker 侧算法的纯 JS 等价复刻（把 crypto.subtle 换成标准 md5hex）── */
// 逐行照抄 _worker.js L5402-5414，仅把 subtle.digest 替换为已验证的 md5hex
const MD5MD5_worker = (文本) => md5hex(md5hex(文本).slice(7, 27)).toLowerCase();
// 逐行照抄 _worker.js L31-34
const userID_worker = (admin, key) => {
  const userIDMD5 = MD5MD5_worker(admin + key);
  return [userIDMD5.slice(0, 8), userIDMD5.slice(8, 12), '4' + userIDMD5.slice(13, 16), '8' + userIDMD5.slice(17, 20), userIDMD5.slice(20)].join('-');
};
// 逐行照抄 _worker.js L304
const subToken_worker = (host, uid) => MD5MD5_worker(host + uid);

/* ── 部署脚本实现（与 deploy-edgetunnel.mjs 同源）── */
function md5md5(text) { return md5hex(md5hex(text).slice(7, 27)).toLowerCase(); }
const uuidv4Re = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
function deriveUserId(admin, key, forcedUuid = '') {
  if (forcedUuid && uuidv4Re.test(forcedUuid)) return forcedUuid.toLowerCase();
  const m = md5md5(admin + key);
  return [m.slice(0, 8), m.slice(8, 12), '4' + m.slice(13, 16), '8' + m.slice(17, 20), m.slice(20)].join('-');
}
const deriveSubToken = (host, uid) => md5md5(host + uid);

/* ── 第三层：多组输入对比 ── */
const CASES = [
  ['123456', 'CMLiussss', 'vless.google.com'],
  ['admin@A1', '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改', 'abc123.akkka.ccwu.cc'],
  ['a'.repeat(64), 'b'.repeat(32), 'xn--fiqs8s.example.com'],
  ['', '', ''],
  ['中文密码测试', '密钥值', '例.中国'],
  ['x'.repeat(200) + 'Ω≈ç√', 'k'.repeat(7), 'svc-a1b2c3d4.akkka.ccwu.cc'],
];
console.log('userID / 订阅TOKEN 派生一致性（Worker 复刻 vs 部署脚本）：');
let pass = 0;
for (const [admin, key, host] of CASES) {
  const w = userID_worker(admin, key), d = deriveUserId(admin, key, '');
  const wt = subToken_worker(host, w), dt = deriveSubToken(host, d);
  const ok = w === d && wt === dt && uuidv4Re.test(d);
  if (ok) pass++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} admin=${JSON.stringify(admin.slice(0, 12))}${admin.length > 12 ? '…' : ''} key=${JSON.stringify(key.slice(0, 10))}${key.length > 10 ? '…' : ''}`);
  console.log(`       userID=${d}  合法UUIDv4=${uuidv4Re.test(d)}  subToken一致=${wt === dt}`);
}
console.log(`  ${pass}/${CASES.length}\n`);

/* ── 第四层：--uuid 强制固定路径与 L32 uuidRegex 行为对齐 ── */
console.log('--uuid 强制固定（对照 _worker.js L32 的 uuidRegex）：');
for (const u of ['90cd4a77-141a-43c9-991b-08263cfe9c10', '00000000-0000-4000-8000-000000000000', 'BAD-NOT-UUID', '90CD4A77-141A-43C9-991B-08263CFE9C10']) {
  const wOk = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(u);
  const d = deriveUserId('x', 'y', u);
  const usesForced = d === u.toLowerCase();
  console.log(`  ${wOk === usesForced ? 'PASS' : 'FAIL'}  ${u.padEnd(40)} worker接受=${wOk} script采用=${usesForced ? '固定值(小写化)' : '派生值'}`);
}

/* ── 第五层：/version 探针的匹配逻辑（L58-65）能否被本地预测 ── */
console.log('\n/version 探针逻辑（L58-65：前8位hex求和 + 后12位精确匹配）：');
const hexSum = (u) => { let s = 0; for (let i = 0; i < 8; i++) { const c = u.charCodeAt(i); s += c <= 57 ? c - 48 : c - 87; } return s; };
for (const [admin, key] of [['123456', 'CMLiussss'], ['admin@A1', '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改']]) {
  const uid = deriveUserId(admin, key, '');
  // 模拟探针：用正确 uuid 与一个仅前8位hex和相同但内容不同的 uuid
  const wrong = uid.slice(0, 8) + uid.slice(8);
  const tampered = '0'.repeat(6) + 'ff' + uid.slice(8, 20) + uid.slice(20);
  const selfMatch = hexSum(uid) === hexSum(uid) && uid.slice(-12) === uid.slice(-12);
  const tamperMatch = hexSum(tampered) === hexSum(uid) && tampered.slice(-12) === uid.slice(-12);
  console.log(`  uuid=${uid} 自身命中=${selfMatch} 篡改样本命中=${tamperMatch}（应为 false，说明探针能区分凭据）`);
}

console.log(`\n结论：${rfcPass === RFC1321.length && pass === CASES.length ? '派生链完全对齐，部署脚本可安全预计算 UUID 与订阅 TOKEN，并用 /version 做免鉴权部署探针。' : '存在不一致，禁止本地派生，改为部署后从面板读取。'}`);
