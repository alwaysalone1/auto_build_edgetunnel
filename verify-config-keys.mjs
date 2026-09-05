#!/usr/bin/env node
/**
 * 校验导出的 edgetunnel.config.json 的键路径，与 _worker.js 里实际访问的 config_JSON.* 路径完全对齐。
 * 若脚本写了 Worker 不认的键，Worker 会静默走默认值 —— 这个检查就是防这个。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

// 相对脚本自身定位，避免硬编码绝对路径导致换机器就失效
const ROOT = import.meta.dirname || path.dirname(new URL(import.meta.url).pathname);
const worker = readFileSync(path.join(ROOT, '_et', '_worker.js'), 'utf8');
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'edgetunnel.config.json'), 'utf8'));

// 1) 从 Worker 源码提取所有 config 访问路径
//    支持三种写法：config_JSON.a.b / config_JSON?.a.b / 形参别名（配置.、cfg.、config.）
const ALIAS = ['config_JSON', '配置', 'cfg', 'config', 'config_JSON?.'];
const paths = new Set();
const accessRe = new RegExp(`(?:${ALIAS.map((a) => a.replace(/[$]/g, '\\$').replace('?', '\\?')).join('|')})((?:\\.\\.?[\\w\\u4e00-\\u9fa5$]+|\\[[^\\]]+\\])+)`, 'g');
for (const m of worker.matchAll(accessRe)) {
  let p = m[1];
  // 归一化：动态下标 ['字符串'] 折叠为点号，其余 [xxx] 折叠为 <DYN>
  p = p.replace(/\.\?/g, '.').replace(/\[\s*['"]([^'"]+)['"]\s*\]/g, '.$1').replace(/\[[^\]]*\]/g, '.<DYN>');
  paths.add(p.replace(/^\./, '').split('.').slice(0, 4).join('.'));
}

// 2) 展开本地 config 的键路径
const flatten = (o, pre = '') => {
  for (const k of Object.keys(o)) {
    const p = pre ? `${pre}.${k}` : k;
    out.add(p);
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) flatten(o[k], p);
  }
};
const out = new Set();
flatten(cfg);

const seg = (p) => p.split('.')[0];
const topCfg = new Set([...out].map(seg));
const topWorker = new Set([...paths].map(seg));

console.log('=== Worker 访问但本地 config 缺失的顶层键（会被静默忽略/走默认）===');
const missing = [...topWorker].filter((k) => k !== '<DYN>' && !topCfg.has(k));
console.log(missing.length ? '  ' + missing.join('\n  ') : '  (无)');

console.log('\n=== 本地 config 有但 Worker 从不读取的顶层键（冗余，无害）===');
const extra = [...topCfg].filter((k) => !topWorker.has(k));
console.log(extra.length ? '  ' + extra.join('\n  ') : '  (无)');

// 3) 重点：逐项确认我们真正调过的关键参数，Worker 是否按同名读取
const CRITICAL = [
  '协议类型', '传输协议', 'gRPC模式', 'PATH', 'ALPN', 'Fingerprint', '随机路径', 'ECH',
  'TLS分片', '启用0RTT', '跳过证书验证', 'HOSTS', 'UUID',
  '优选订阅生成.local', '优选订阅生成.本地IP库.随机IP', '优选订阅生成.本地IP库.随机数量',
  '优选订阅生成.本地IP库.指定端口', '优选订阅生成.SUBUpdateTime', '优选订阅生成.SUBNAME',
  '订阅转换配置.SUBAPI', '订阅转换配置.SUBCONFIG', '订阅转换配置.SUBLIST',
  '反代.SOCKS5.启用', '反代.SOCKS5.全局', '反代.SOCKS5.账号', '反代.SOCKS5.白名单',
  '反代.路径模板', 'TG.启用', 'CF.Usage',
];
console.log('\n=== 关键调校项：本地存在 且 Worker 源码确有读取（双向对齐）===');
// 兜底：正则对嵌套方括号（如 路径模板[config_JSON.反代.SOCKS5.启用?.toUpperCase()]）有盲区，
// 会吞掉内层访问。所以对每个关键路径额外做一次"字面链出现在源码中"的硬检查。
const literalRead = (p) => {
  const chain = '.' + p.split('.').join('.');
  if (worker.includes(chain)) return true;
  // 逐级后缀：.SOCKS5.启用 之类在源码里可能挂在别的根上
  const parts = p.split('.');
  for (let i = 1; i < parts.length; i++) {
    const suffix = '.' + parts.slice(i).join('.');
    if (worker.includes(suffix) && new RegExp(`[\\w\\u4e00-\\u9fa5\\]]\\${suffix}[\\s?.,;)\\]]`).test(worker)) return true;
  }
  return false;
};
let bad = 0;
const realIssues = [];
for (const p of CRITICAL) {
  const exists = out.has(p);
  const byPath = [...paths].some((w) => w === p || w.startsWith(p + '.') || p.startsWith(w + '.'));
  const byLiteral = literalRead(p);
  const readByWorker = byPath || byLiteral;
  const ok = exists && readByWorker;
  if (!ok) { bad++; realIssues.push(p); }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${p.padEnd(38)} 本地=${exists} 路径推导=${byPath} 字面命中=${byLiteral}`);
}

// 4) 反代.PROXYIP 是动态键（_p = 特征码字典[0] = 'PROXYIP'），单独验证
const pAuto = /config_JSON\.反代\[(_p|特征码字典)/.test(worker);
console.log(`\n=== 动态键验证 ===`);
console.log(`  反代.PROXYIP：Worker 用 config_JSON.反代[_p] 访问（_p="PROXYIP"），源码确认=${pAuto}，本地键存在=${out.has('反代.PROXYIP')}`);
console.log(`  反代.路径模板.PROXYIP：Worker 用 路径模板[_p] 访问，本地键存在=${out.has('反代.路径模板.PROXYIP')}`);

console.log(`\n结论：${bad === 0 ? '关键项全部双向对齐，config.json 会被 Worker 正确识别。' : `有 ${bad} 项未对齐：${realIssues.join(', ')}`}`);
if (realIssues.includes('反代.SOCKS5.白名单')) {
  console.log('  ↑ 这是 edgetunnel 的设计缺陷，非本部署器问题：');
  console.log('    _worker.js L2432 判断白名单时读的是模块级全局 SOCKS5白名单（L3 定义，L50-53 仅由 env.GO2SOCKS5 追加），');
  console.log('    而 L5653 只是把同名数组塞进默认 config.json 而已，从不回读。');
  console.log('    ⇒ 白名单必须用环境变量 GO2SOCKS5 配置（本部署器已提供 --go2socks5），在面板/KV 里改无效。');
}
