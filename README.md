# auto_build_edgetunnel

基于 [cmliu/edgetunnel 2.1](https://github.com/cmliu/edgetunnel) 内核 + Cloudflare API 自动部署脚本的二创项目。
**用户只需提供 Cloudflare 账号 ID 和浏览器登录态（`vses2` / 完整 Cookie），一条命令一键部署**，产出 v2rayN 可用的
500 节点 VLESS 订阅（每 2 小时自动刷新，无需进面板）。

```bash
git clone https://github.com/alwaysalone1/auto_build_edgetunnel.git
cd auto_build_edgetunnel
node deploy-edgetunnel.mjs --account-id '你的账号ID' --vses2 'vses2=...' --zone '你的根域名'
```

> 详细文档（全部参数、逐项调校理由、v2rayN 用法、常见问题）：[README-edgetunnel.md](./README-edgetunnel.md)

## 隐私与安全（仓库已脱敏）

- 仓库内**不含任何真实凭据**：账号 ID、vses2/cf_clearance、ADMIN/KEY、UUID、订阅 Token 均为示例或占位值；
- 部署/重配时脚本在本地生成 3 个文件，已被 `.gitignore` 排除，**请勿提交到任何仓库**：
  - `edgetunnel-credentials.json` —— 订阅地址、ADMIN/KEY/UUID（明文）
  - `edgetunnel-deploy.state.json` —— 账号 ID、Worker/KV/订阅信息
  - `edgetunnel.config.json` —— 写入 KV 的完整配置
- 配置结构模板见 [edgetunnel.config.example.json](./edgetunnel.config.example.json)（占位值，可直接审阅）。

---

# Cloudflare Worker 自动部署

> **本目录现在有两套方案，请先看 [README-edgetunnel.md](./README-edgetunnel.md)。**
>
> - **新方案（推荐）**：`deploy-edgetunnel.mjs` + `_et/_worker.js` —— 内核换成 [cmliu/edgetunnel 2.1](https://github.com/cmliu/edgetunnel)。
>   支持 **v2rayN 原生订阅格式**、优选节点数可开到几百、带管理面板、支持 WS/gRPC/xHTTP。
> - **旧方案（保留可用）**：`deploy-cloudflare-vless.mjs` + `worker.fixed.js` —— 自研 16KB 精简内核。
>   **只输出 Clash/Mihomo YAML，v2rayN 打不开**（v2rayN 明确不支持 Clash YAML 订阅，见 [2dust/v2rayN#8482](https://github.com/2dust/v2rayN/issues/8482) closed as not planned）。

下面的旧方案文档原样保留，供仍要用精简内核的人参考。

---

# Cloudflare Worker 自动部署（旧：自研精简内核）

这套脚本面向刚创建、账号里还没有 Zone 的 Cloudflare 账号。

- `deploy-cloudflare-vless.mjs`：自动创建 Token、添加 Zone、部署 Worker、创建 DNS 和 Worker Route。
- `worker.fixed.js`：Worker 源码，部署时会替换成随机 UUID；普通访问会返回 Clash/Mihomo 订阅。

## 最短用法

只需要账号 ID、`vses2` 和真实根域名。Token 创建不需要域名，但添加 Zone/DNS/Route 必须知道要接入哪个域名。

```bash
node deploy-cloudflare-vless.mjs \
  --account-id '你的 Cloudflare 账号 ID' \
  --vses2 '你的 vses2 cookie 值' \
  --zone akkka.ccwu.cc
```

默认会随机生成：

- Worker 名称
- 绑定的子域名
- VLESS UUID
- 本机测试用的 Clash/Mihomo 节点名

API Token 创建前会先调用 `/user/tokens/permission_groups`，把脚本内置的权限名解析成当前账号可用的权限组 ID。默认权限覆盖：

- 账号级：`Account Settings Read`、`Workers Scripts Read`、`Workers Scripts Write`
- Zone 级：`Zone Read`、`Zone Write`、`DNS Read`、`DNS Write`、`Workers Routes Read`、`Workers Routes Write`

如果 Cloudflare 安全页拦住了 dashboard session，再传完整浏览器 Cookie，必要时再传 `x-atok`：

```bash
node deploy-cloudflare-vless.mjs \
  --account-id '你的 Cloudflare 账号 ID' \
  --cookie '浏览器请求里的完整 Cookie 字符串' \
  --atok '浏览器请求里的 x-atok 值' \
  --zone akkka.ccwu.cc
```

如果 Cloudflare 仍然提示没有 `zone.create` 权限，可以先在 Cloudflare 后台手动添加根域名，再用最短命令继续。

创建 DNS 和 Worker Route 后，脚本会先让你确认域名服务商里的 NS 已经改成 Cloudflare 分配的两条，再开始 HTTPS 检查。确认后输入 `y` 继续。已经确认过时，可以加 `--assume-ns-ready` 跳过这一步。

部署完成后，直接打开 `https://生成的子域名/` 会返回 Clash/Mihomo 订阅 YAML，可以直接导入 Clash Verge。WebSocket 请求仍然走代理，不受订阅页面影响。

脚本会直接调用 Cloudflare API，不再依赖浏览器控制台脚本或 `wrangler`。

## 可选参数

```bash
node deploy-cloudflare-vless.mjs \
  --account-id '你的 Cloudflare 账号 ID' \
  --vses2 '你的 vses2 cookie 值' \
  --zone akkka.ccwu.cc \
  --hostname abc123.akkka.ccwu.cc \
  --worker-name svc-abc123 \
  --uuid '固定 UUID' \
  --proxy-name '固定节点名' \
  --assume-ns-ready \
  --skip-test
```

`vses2` 是登录态，不要写进仓库或发到聊天记录里。用完后可以在 Cloudflare 里撤销这个临时 Token。

## 已知缺陷（旧内核，未修）

留档，避免有人以为它和新方案等价：

1. **订阅端点无鉴权**：任何非 WebSocket 请求都直接返回含 UUID 的 YAML，扫到域名就等于拿到凭据。
2. **Trojan 口令永不轮换**：部署脚本只替换 `uuid`，`passWordSha224` 全模板共用口令 `666`。
3. **`parseShadow` 是无凭据兜底分支**：首字节 ∈ {1,3,4} 即可开一条不经鉴权的 TCP 隧道。
4. **建链竞态**：`messageHandler` 在 `await establishTcpConnection()` 之后才赋值，建链期间到达的后续包会被当作首包重新解析。
5. **内置 5 个优选入口实测只有 2 个可用**（2026-09 实测，见新 README 的探测数据）。
