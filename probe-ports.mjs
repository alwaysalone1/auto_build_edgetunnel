#!/usr/bin/env node
// CF 边缘 HTTPS 端口开放度实测：决定“一个入口能拆成几个节点”
import { Socket } from 'node:net';
import { lookup } from 'node:dns/promises';

const HOSTS = ['162.159.192.134', '172.64.145.158', '162.159.135.234', '104.18.42.98', '172.67.161.104', 'saas.sin.fan', 'cf.090227.xyz', 'icook.hk'];
const PORTS = [443, 8443, 2053, 2083, 2087, 2096, 80, 8080, 2052, 2082, 2086, 2095];

const tcp = (host, port, timeout = 5000) => new Promise((resolve) => {
  const t0 = Date.now();
  const s = new Socket();
  s.setTimeout(timeout);
  const fin = (r) => { s.destroy(); resolve(r); };
  s.on('connect', () => fin({ ok: true, ms: Date.now() - t0 }));
  s.on('error', (e) => fin({ ok: false, err: e.code }));
  s.on('timeout', () => fin({ ok: false, err: 'TIMEOUT' }));
  s.connect(port, host);
});

const head = ['target'.padEnd(20), ...PORTS.map((p) => String(p).padStart(6))].join('');
console.log('端口: ' + head);
for (const h of HOSTS) {
  let ip = h;
  if (!/^\d+\./.test(h)) { try { ip = (await lookup(h)).address } catch { console.log(`${h.padEnd(20)} DNS-FAIL`); continue } }
  const cells = [];
  for (const p of PORTS) {
    const r = await tcp(ip, p);
    cells.push((r.ok ? 'OK' : (r.err === 'ECONNREFUSED' ? 'ref' : r.err === 'TIMEOUT' ? 'to' : 'x')).padStart(6));
  }
  console.log(`${h.padEnd(20)}${cells.join('')}  (${ip})`);
}
console.log('\nOK=可建连 ref=拒绝 to=超时 x=其他');
