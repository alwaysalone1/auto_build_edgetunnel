#!/usr/bin/env node
// 双 SNI 对照探测：
//   A) servername = 域名自身  -> 证明该域名在 Cloudflare 上有 Zone（优选入口的必要条件）
//   B) servername = www.cloudflare.com -> 对照组，证明 CF 边缘接受任意 SNI
import { connect } from 'node:tls';
import { Socket } from 'node:net';
import { lookup } from 'node:dns/promises';

const HOSTS = [
  ['jp.111000.cc.cd', '内置'], ['bestcf.030101.xyz', '内置'], ['saas.sin.fan', '内置'],
  ['freeyx.cloudflare88.eu.org', '内置'], ['cf.090227.xyz', '内置'],
  ['icook.hk', '候选'], ['cf-youtube.icu', '候选'], ['random.090227.xyz', '候选'],
  ['2023.090227.xyz', '候选'], ['www.visa.com', '候选'], ['zhihu.in', '候选'],
  ['discord.com', '候选'], ['speed.cloudflare.com', '候选'],
];
const IPS = ['162.159.192.134', '104.16.56.65', '172.64.145.158', '188.114.96.1', '104.21.90.210'];

const tlsProbe = (host, servername, timeout = 8000) => new Promise((resolve) => {
  const t0 = Date.now();
  const sock = connect({ host, port: 443, servername, rejectUnauthorized: false, timeout });
  const done = (r) => { sock.destroy(); resolve(r); };
  sock.on('secure', () => done({ ok: true, ms: Date.now() - t0, cert: sock.getPeerCertificate()?.issuer?.O || '?' }));
  sock.on('error', (e) => done({ ok: false, ms: Date.now() - t0, err: e.code || e.message }));
  sock.on('timeout', () => done({ ok: false, ms: Date.now() - t0, err: 'TIMEOUT' }));
});

const tcpProbe = (host, timeout = 8000) => new Promise((resolve) => {
  const t0 = Date.now();
  const sock = new Socket();
  sock.setTimeout(timeout);
  sock.on('connect', () => { sock.destroy(); resolve({ ok: true, ms: Date.now() - t0 }); });
  sock.on('error', (e) => { sock.destroy(); resolve({ ok: false, err: e.code }); });
  sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, err: 'TIMEOUT' }); });
  sock.connect(443, host);
});

console.log('host                            tag   DNS              TCP443        SNI=自身              SNI=cloudflare.com');
for (const [host, tag] of HOSTS) {
  let ip;
  try { ip = (await lookup(host)).address } catch { console.log(`${host.padEnd(32)} ${tag}   DNS-FAIL`); continue }
  const tcp = await tcpProbe(host);
  const a = await tlsProbe(ip, host);
  const b = await tlsProbe(ip, 'www.cloudflare.com');
  const f = (r) => r.ok ? `OK ${r.ms}ms/${r.cert}` : `${r.err} ${r.ms}ms`;
  console.log(`${host.padEnd(32)} ${tag.padEnd(5)} ${ip.padEnd(16)} ${(tcp.ok ? 'OK ' + tcp.ms + 'ms' : tcp.err).padEnd(13)} ${f(a).padEnd(21)} ${f(b)}`);
}
console.log('\n裸 CF IP（SNI=www.cloudflare.com 对照）');
for (const ip of IPS) {
  const b = await tlsProbe(ip, 'www.cloudflare.com');
  console.log(`${ip.padEnd(32)} ${b.ok ? 'OK ' + b.ms + 'ms/' + b.cert : b.err + ' ' + b.ms + 'ms'}`);
}
