#!/usr/bin/env node
// 估算 edgetunnel 订阅生成的 CPU 开销，对照 CF Workers Free 的 10ms/请求 CPU 上限
// 复刻 L403-455 生成 + L469-483 占位符替换 + L485 btoa
const CFPORT = [443, 2053, 2083, 2087, 2096, 8443];
const HOST = 'svc-a1b2c3d4.akkka.ccwu.cc';
const UUID = '9f3c1a7e-4b2d-4e8a-9c1f-2d6b8a4e0f13';
const WORDS = ['about', 'account', 'acg', 'api', 'article', 'blog', 'cdn', 'data', 'docs', 'game', 'img', 'news', 'post', 'video'];

const gen = (count, randomPath) => {
  const links = Array.from({ length: count }, (_, i) => {
    const ip = `${104 + (i % 60)}.${(i * 7) % 256}.${(i * 13) % 256}.${(i * 29) % 256}`;
    const port = CFPORT[i % CFPORT.length];
    const path = randomPath ? '/' + WORDS.sort(() => 0.5 - Math.random()).slice(0, Math.floor(Math.random() * 3) + 1).join('/') : '/';
    return `vless://00000000-0000-4000-8000-000000000000@${ip}:${port}?security=tls&type=ws&host=example.com&fp=chrome&sni=example.com&path=${encodeURIComponent(path)}&encryption=none&alpn=#CF%E8%81%94%E9%80%9A%E4%BC%98%E9%80%89${i + 1}`;
  }).join('\n');
  // L469-483：全局 UUID 替换 + example.com 逐个轮换
  const hosts = [HOST, HOST, HOST];
  let n = 0, cur = null;
  const filled = links
    .replace(/00000000-0000-4000-8000-000000000000/g, UUID)
    .replace(/example\.com/g, () => { if (n % 2 === 0) cur = hosts[Math.floor(n / 2) % hosts.length]; n++; return cur; });
  return { filled, b64: Buffer.from(filled).toString('base64') };
};

console.log('节点数   随机路径   明文KB   base64KB   生成+替换+编码(ms)   CF-Free 10ms CPU 判定');
for (const count of [16, 100, 200, 300, 500, 800]) {
  for (const rp of [false, true]) {
    gen(count, rp); // 预热
    const t0 = process.hrtime.bigint();
    const { filled, b64 } = gen(count, rp);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`${String(count).padStart(6)}   ${String(rp).padEnd(8)} ${(filled.length / 1024).toFixed(1).padStart(7)}   ${(b64.length / 1024).toFixed(1).padStart(9)}   ${ms.toFixed(2).padStart(18)}   ${ms < 8 ? 'PASS 有余量' : ms < 12 ? '临界' : 'OVER 会爆'}`);
  }
}
console.log('\n注：本机 V8 与 Workers V8 性能接近但不等价；此数据为量级参考，非精确值。');
console.log('另：CF Workers Free 每请求 CPU 上限 10ms；KV 写入免费额度 1000 次/天（请求日志会打爆它）。');
