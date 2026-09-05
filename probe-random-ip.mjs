#!/usr/bin/env node
// 实测 edgetunnel 的“随机 CF IP 优选”真实可用率
// 复刻 _worker.js L5887-5904 的生成逻辑，然后逐个测 TCP 连通
import { Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import path from 'node:path';

const ROOT = import.meta.dirname || path.dirname(new URL(import.meta.url).pathname);

const CFPORT = [443, 2053, 2083, 2087, 2096, 8443]; // L5887 原样
const COUNT = Number(process.argv[2] || 500);
const CONCURRENCY = 120;
const TIMEOUT = 3500;

const genFromCIDR = (cidr) => { // L5891-5897 原样复刻
  const [baseIP, prefixLength] = cidr.split('/');
  const prefix = parseInt(prefixLength), hostBits = 32 - prefix;
  const ipInt = baseIP.split('.').reduce((a, p, i) => a | (parseInt(p) << (24 - i * 8)), 0);
  const randomOffset = Math.floor(Math.random() * Math.pow(2, hostBits));
  const mask = (0xFFFFFFFF << hostBits) >>> 0, randomIP = (((ipInt & mask) >>> 0) + randomOffset) >>> 0;
  return [(randomIP >>> 24) & 0xFF, (randomIP >>> 16) & 0xFF, (randomIP >>> 8) & 0xFF, randomIP & 0xFF].join('.');
};

const tcp = (host, port) => new Promise((resolve) => {
  const t0 = Date.now();
  const s = new Socket();
  s.setTimeout(TIMEOUT);
  const fin = (r) => { s.destroy(); resolve({ ...r, ms: Date.now() - t0 }); };
  s.on('connect', () => fin({ ok: true }));
  s.on('error', (e) => fin({ ok: false, err: e.code }));
  s.on('timeout', () => fin({ ok: false, err: 'TIMEOUT' }));
  s.connect(port, host);
});

const load = (f) => readFileSync(f, 'utf8').replace(/[\t"' \r\n]+/g, ',').replace(/,+/g, ',').replace(/^,|,$/g, '').split(',').filter((x) => x.includes('/'));

const pools = {
  'cf(官方全量)': path.join(ROOT, '_et', 'CF-CIDR.txt'),
  'ct(电信优选)': path.join(ROOT, '_et', 'CIDR-ct.txt'),
  'cu(联通优选)': path.join(ROOT, '_et', 'CIDR-cu.txt'),
  'cmcc(移动优选)': path.join(ROOT, '_et', 'CIDR-cmcc.txt'),
};

try { const r = await fetch('https://speed.cloudflare.com/meta'); const j = await r.json(); console.log(`本机出口: ASN=${j.as} ${j.asOrganization} | ${j.city},${j.country} | colo=${j.colo}\n`); } catch { console.log('本机出口信息获取失败\n'); }

console.log(`池名              CIDR数  生成   TCP可达  可用率   443专项  中位延迟`);
for (const [name, file] of Object.entries(pools)) {
  let cidrs;
  try { cidrs = load(file) } catch { console.log(`${name.padEnd(17)} 文件缺失`); continue }
  const targets = Array.from({ length: COUNT }, () => ({ ip: genFromCIDR(cidrs[Math.floor(Math.random() * cidrs.length)]), port: CFPORT[Math.floor(Math.random() * CFPORT.length)] }));
  const uniq = [...new Map(targets.map((t) => [`${t.ip}:${t.port}`, t])).values()];
  const results = [];
  const queue = [...uniq];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (queue.length) { const t = queue.shift(); results.push({ ...t, ...(await tcp(t.ip, t.port)) }); } }));
  const ok = results.filter((r) => r.ok);
  const p443 = results.filter((r) => r.port === 443);
  const ok443 = p443.filter((r) => r.ok);
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const p443str = p443.length ? Math.round(ok443.length / p443.length * 100) + '%(' + ok443.length + '/' + p443.length + ')' : 'n/a';
  const line = name.padEnd(16) + ' ' + String(cidrs.length).padStart(5) + '  ' + String(uniq.length).padStart(5) + '  ' + String(ok.length).padStart(6) + '   ' + (ok.length / uniq.length * 100).toFixed(1).padStart(5) + '%   ' + p443str.padEnd(14) + '  ' + (lat.length ? lat[Math.floor(lat.length / 2)] + 'ms' : '-');
  console.log(line);
}
