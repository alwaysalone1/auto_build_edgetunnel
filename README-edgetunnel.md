# edgetunnel 自动部署（v2rayN 原生订阅 + 大批量优选节点）

把 [cmliu/edgetunnel 2.1](https://github.com/cmliu/edgetunnel) 一键部署到 Cloudflare Workers，
并把它的 `config.json` 按 **v2rayN + 大批量优选节点** 场景调好、直接写进 KV，**不依赖管理面板**。

相对旧方案（`deploy-cloudflare-vless.mjs` + `worker.fixed.js`）解决了两件事：

| | 旧内核 | 本方案 |
|---|---|---|
| 订阅格式 | 只有 Clash/Mihomo YAML，**v2rayN 打不开** | **v2rayN 原生 base64 链接列表**（本地生成，不经第三方）+ clash/sing-box/surge/loon/quanx |
| 节点数 | 手写 5 个优选域名（实测仅 2 个可用） | CF 官方 CIDR 按访客运营商自动生成，默认 **500**，可调到 2000 |

---

## 0. 前置：拉取 edgetunnel 源码并锁版本

本目录 `_et/_worker.js` 已留存一份，**不要**让部署脚本去 hotlink upstream：

```bash
# 已留存，校验用（当前留存版本）
# Version 常量 = 2026-09-04 16:24:13   大小 321534 字节   6642 行
# GitHub blob sha = aab308838ca7e9ca83eb1b5b330b952804be4819
sha256sum _et/_worker.js
```

要更新版本就重新下载并**先跑一遍第 6 节的两个校验脚本**，确认键路径仍然对齐。

---

## 1. 最短用法

```bash
node deploy-edgetunnel.mjs \
  --account-id '你的 Cloudflare 账号 ID' \
  --vses2 '你的 vses2 cookie 值' \
  --zone akkka.ccwu.cc
```

已经有 API Token（需含 Workers Scripts Write + Workers KV Storage Edit）：

```bash
node deploy-edgetunnel.mjs \
  --account-id '你的 Cloudflare 账号 ID' \
  --api-token '你的 CF API Token' \
  --zone akkka.ccwu.cc --nodes 500
```

先看计划、不碰云端：

```bash
node deploy-edgetunnel.mjs --dry-run --zone akkka.ccwu.cc --nodes 500 --print-config
```

跑完屏幕上直接给出 v2rayN 订阅地址，同时落盘：

- `edgetunnel-credentials.json` —— 订阅地址、ADMIN、KEY、UUID（**含凭据，别提交**）
- `edgetunnel-deploy.state.json` —— 资源清单，供 `--reconfigure` / `--destroy` 复用
- `edgetunnel.config.json` —— 仅 `--print-config` 时导出，便于审阅

---

## 2. v2rayN 怎么用

部署完输出的形如：

```
https://<你的域名>/<KEY>
```

v2rayN：**订阅设置 → 添加订阅 → 粘贴地址 → 确定 → 右键该订阅 → 更新订阅**。

### 每 2 小时自动刷新（不用进面板）

服务端已把 `SUBUpdateTime` 设为 2，每次拉订阅的响应头都带 `Profile-Update-Interval: 2`。
v2rayN 客户端里**一次性**设置即可永久自动刷新：

1. v2rayN 主界面 → **订阅分组设置**（或右键订阅 → 编辑）；
2. 把「**自动更新间隔(小时)**」设为 `2`；
3. 确保 v2rayN 托盘菜单/参数设置里的「**自动更新订阅**」已勾选。

之后 v2rayN 每 2 小时自动拉一次订阅，节点自动重建，无需打开 `/admin` 面板。
注意：随机 IP 模式下每次刷新 500 个节点的 IP 会全部更换（节点名不变）；想要长期稳定的节点池，
把实测低延迟的 IP 写进 KV 的 `ADD.txt` 并把 `随机IP` 设为 `false` 即可（见「三件事」第 2 条）。


原理（对齐 `_worker.js` 行号）：

- `/<KEY>` 命中 L86，302 跳到 `/sub?token=MD5MD5(host+UUID)`（L88-89）
- L332-346 判定格式：UA 不含 `clash|singbox|surge|loon|quantumult` → `mixed`
- L351-455 **在 Worker 本地**拼 `vless://...` 链接（用占位 UUID 和 `example.com`）
- L469-483 替换占位符为真 UUID，`example.com` 从 `HOSTS` 池打乱轮换
- L485 非浏览器 UA → `btoa()` 输出 base64 链接列表

**这条链路不经过任何第三方服务器。** 只有 clash/sing-box/surge 格式才会走 L457-459 的 SUBAPI 转换后端。

浏览器直接打开同一地址会返回**明文**链接（L485 的反向分支），方便肉眼核对。

---

## 3. 节点数怎么调（以及为什么不是越大越好）

```bash
# 只改配置，不重新部署 Worker / 不动 DNS 和 Route
node deploy-edgetunnel.mjs --reconfigure --nodes 300
```

机制在 `_worker.js` L5875-5906 `生成随机IP()`：

1. L5845-5873 `识别运营商(request)` 按**访客** `cf.asn` / `cf.asOrganization` 判定 `ct|cu|cmcc|cf`
2. L5885 选对应 CIDR 文件（`CF-CIDR.txt` 或 `CF-CIDR/{ct,cu,cmcc}.txt`）
3. L5891-5897 从 CIDR 内随机取 IP，L5887 从 `[443,2053,2083,2087,2096,8443]` 随机取端口
4. L5903 备注名 `CF电信优选1..N` / `CF联通优选N` / `CF移动优选N` / `CF官方优选N`

### 实测数据（2026-09，本机 = Akamai Cloud 洛杉矶 AS63949）

复刻 L5887-5904 生成 500 个 `IP:port` 后逐个测 TCP：

| 池 | CIDR 条数 | 生成 | TCP 可达 | 可用率 | 中位延迟 |
|---|---|---|---|---|---|
| `cf` 官方全量 | 25 | 498 | 498 | **100%** | 120ms |
| `ct` 电信优选 | 5 | 488 | 488 | **100%** | 212ms |
| `cu` 联通优选 | 2 | 497 | 497 | **100%** | 353ms |
| `cmcc` 移动优选 | 17 | 500 | 500 | **100%** | 579ms |

> **100% 可达**：CF 是 anycast，段内 IP 基本全部应答，所以"随机 IP 会不会是死 IP"这个担心不成立。
> **延迟那一列对本机无意义**：本机在海外，`ct/cu/cmcc` 是给中国大陆线路优化的池。
> 你在国内直连拉订阅时，L5845 会自动帮你选中对应的池，**不需要手动指定**。

### 订阅体积与 CPU（`bench-sub.mjs` 实测）

| 节点数 | 明文 | base64 | 生成+替换+编码 |
|---|---|---|---|
| 16 | 3.6 KB | 4.8 KB | 0.07 ms |
| 100 | 22.5 KB | 30.0 KB | 0.23 ms |
| 300 | 67.7 KB | 90.3 KB | 0.61 ms |
| **500** | **112.9 KB** | **150.6 KB** | **0.74 ms** |
| 800 | 180.8 KB | 241.0 KB | 1.79 ms |

CF Workers Free 每请求 CPU 上限 10ms —— **500 节点只用 0.74ms，完全不是瓶颈**。瓶颈在别处，见下。

### 500 节点必须知道的三件事

1. **别用"测试真延迟"全量测速。** 500 个节点逐个建连 = 500 个 Worker 请求 + 几分钟等待。用「测试可用TTFB」或只测选中分组。
2. **随机 IP 每次拉订阅都重新生成。** 节点名不变（`CF电信优选1..500`）但 IP 全换，所以测速结果无法复用。
   想要稳定节点池：把实测低延迟的 IP 用部署器写入 KV `ADD.txt` 并关闭随机 IP（一条命令，见 §7.9）。
3. **必须在【完全直连、没挂任何代理】的状态下拉订阅。** 挂了梯子刷新会让 `cf.country != CN`（L5869）退化成 `cf` 全量池，拿不到运营商优化线路。

### 配额红线

| 项目 | 免费额度 | 500 节点的影响 |
|---|---|---|
| Workers 请求数 | 100,000 / 天 | 全量测速一轮 500 次，够用 |
| Workers CPU | 10 ms / 请求 | 订阅生成 0.74ms，安全 |
| **KV 写入** | **1,000 / 天** | **请求日志每次订阅写一条 → 会打爆。本部署器已默认注入 `OFF_LOG=1`** |
| KV 读取 | 100,000 / 天 | 每请求读 `config.json`，安全 |

---

## 4. 已做的调校（`buildOptimalConfig()`）

针对 v2rayN + 大批量节点，逐项理由：

| 配置 | 值 | 理由 |
|---|---|---|
| `协议类型` | `vless` | v2rayN 对 VLESS+WS+TLS 支持最成熟；Trojan 走 CF 兼容性差，SS 需 v2ray-plugin |
| `传输协议` | `ws` | gRPC/xHTTP 要较新的 Xray/v2rayN；500 节点下 WS 最稳 |
| `随机路径` | **`true`** | **白拿的抗封锁**：Worker 的 WS 入站只判 `Upgrade` 头、**不校验 path**（L67），所以客户端与 Worker 无需路径一致 |
| `本地IP库.随机数量` | `500` | 你要的规模 |
| `本地IP库.指定端口` | `-1` | 分散到 6 个 TLS 端口，避免单端口被一锅端 |
| `SUBUpdateTime` | `2` | **订阅自动刷新间隔（小时）**。服务端随响应下发 `Profile-Update-Interval: 2`，v2rayN 在「订阅分组设置 → 自动更新间隔」里设 2 小时即可定时拉取，**不用进面板手动刷新**。代价：随机 IP 模式下每次刷新 500 个节点 IP 全换（要稳定池见上「三件事」第 2 条，改用 `ADD.txt` + `随机IP=false`） |
| `Fingerprint` | `chrome` | UTLS 指纹伪装 |
| `TLS分片` | `null` | `fragment` 是 Xray 节点级参数，订阅 URL 参数对 v2rayN 不生效 |
| `ECH` | `false` | v2rayN GUI 对 ECH 支持不完整，开了容易连不上 |
| `启用0RTT` | `false` | `?ed=2560` 主要服务 xHTTP/gRPC，WS 下 v2ray-core 不主动发 |
| `SUBLIST` | `true` | 只输出节点信息，不带机场规则 |
| env `OFF_LOG` | `1` | 保住 KV 写入配额 |
| env `PRELOAD_RACE_DIAL` | `1` | 预加载竞速拨号，降低首包延迟 |

**没有加 `compatibility_flags`**：upstream `wrangler.toml` 就没有。edgetunnel 不用 `cloudflare:sockets`，
而是走未文档化的 `request.fetcher.connect()`（L3329-3334），所以既不需要 `nodejs_compat` 也不需要 sockets 权限。

---

## 5. 命令速查

```bash
# 凭据
--admin <密码>       后台密码 / UUID 派生因子（默认随机 36 位）
--key <密钥>         订阅路径密钥，订阅地址即 https://<域名>/<key>（默认随机 16 位）
--uuid <UUIDv4>     强制固定 UUID，覆盖 ADMIN+KEY 派生

# 规模与协议
--nodes <n>          优选节点数，默认 500（1..2000）
--port <p>           固定端口；-1 = 6 个 TLS 端口随机
--sub-update-time <h> 订阅自动刷新间隔小时数，默认 2（v2rayN 按响应头/客户端设置自动更新）
--protocol <p>       vless | trojan | ss
--transport <t>      ws | grpc | xhttp
--path </p>          节点基础路径
--sub-name <名>      订阅显示名

# 节点池
--add-ips <列表>      稳定节点池：ip:port[,ip:port] 或 file:路径（每行一条，可带 #名称）。
                      会写入 KV ADD.txt 并关闭随机IP —— 2 小时自动刷新不再换 IP（见 §7）
--random-ips          恢复随机 IP 模式（与 --add-ips 互斥）

# 伪装页
--fake-page <域名>    env.URL：nginx=内置默认页 / 1101=内置HTML / 站点域名=反代该站当伪装

# 通知 / 用量统计（写 KV tg.json / cf.json，Worker 覆盖读取）
--tg-bot <token> --tg-chat <id>   订阅访问 TG 通知
--cf-email <邮箱> --cf-key <GAK>   CF 用量统计（Global API Key）
--cf-token <token>                或改用 API Token（与上面二选一）

# 反代
--proxyip <h:port>   反代出口；默认 auto 走 {colo}.proxyip.cmliussss.net
--go2socks5 <列表>   SOCKS5 域名白名单 —— 见下方「坑」

# 资源
--kv-title <名>      KV 命名空间名（默认 edgetunnel-kv，会自动创建）
--kv-id <id>         复用已有 KV
--worker-name <n>    Worker 名
--worker-source <f>  Worker 源码路径

# 运维
--reconfigure        只重写 KV 配置（改节点数用这个，别重新部署）
--destroy            删除 Route/DNS/Worker，默认保留 KV（EDT_DROP_KV=1 连 KV 一起删）
--revoke-token       撤销本次自动创建的 API Token
--print-config       额外导出 edgetunnel.config.json 便于审阅
--dry-run            只打印计划，零云端/本地写入
--skip-kv-config     不写 config.json（改用面板配置）
--assume-ns-ready    跳过 NS 交互确认
```

环境变量：`CF_API_TOKEN` `CF_ACCOUNT_ID` `CF_ZONE_NAME` `CF_HOSTNAME` `EDT_ADMIN` `EDT_KEY` `EDT_NODES` `EDT_PROXYIP` `EDT_TRANSPORT` `EDT_PROTOCOL` `EDT_DROP_KV`

---

## 6. 自带校验脚本（改动后务必重跑）

```bash
node --check deploy-edgetunnel.mjs
node verify-derive.mjs          # 派生链：RFC 1321 向量 + Worker 复刻对比 + /version 探针逻辑
node verify-config-keys.mjs     # config.json 键路径 vs Worker 源码实际访问
node bench-sub.mjs              # 订阅体积与 CPU 开销
node probe-random-ip.mjs 500    # 随机优选 IP 真实可用率
node probe-entrances.mjs        # 优选域名存活（双 SNI 对照）
node probe-ports.mjs            # CF 边缘端口开放度
```

当前状态：

- `verify-derive.mjs` → RFC 1321 向量 **7/7**、派生一致性 **6/6**、`--uuid` 路径 **4/4** 全 PASS
- `verify-config-keys.mjs` → 关键项 **28/29** PASS，唯一 FAIL 是 edgetunnel 自身缺陷（见下）

---

## 7. 坑清单（全部实测或读源码确认）

### 7.1 `反代.SOCKS5.白名单` 在 config.json 里无效 ← 面板骗人

`_worker.js` L2432 判断白名单时读的是**模块级全局变量** `SOCKS5白名单`（L3 定义，L50-53 仅由 `env.GO2SOCKS5` 追加）。
L5653 只是把同名数组塞进默认 `config.json`，**从不回读**。

⇒ 改白名单**只能走环境变量**。本部署器提供 `--go2socks5`，会在 bindings 里注入 `GO2SOCKS5`。在面板或 KV 里改这个字段不会有任何效果。

### 7.2 KV 是订阅的硬依赖

`_worker.js` L84 `if (env.KV && typeof env.KV.get === 'function')` 把 `/sub`、`/admin`、`/<KEY>` 全包在里面。
没绑 KV → `/sub` 落到 L501 的 `noKV` 404 伪装页，**只剩代理功能**。本部署器自动创建并绑定 KV。

### 7.3 ADMIN 是总开关，KEY 不配等于裸奔

- L29 取不到 `ADMIN` → L83 返回 `noADMIN` 404 页，连 WS/gRPC/xHTTP 代理分发（L67/L71）都不走。
- L30 `加密秘钥 = env.KEY || '勿动此默认密钥…'`，L34 `UUID = MD5MD5(ADMIN+KEY)` 拼成的伪 UUIDv4。
  **用默认 KEY 时，只要 ADMIN 弱，订阅 token 就能被爆破。** 本部署器默认给 ADMIN 36 位、KEY 16 位随机 hex。

### 7.4 `request.fetcher.connect()` 是未文档化 API

L3329-3334 靠它开 TCP，缺失时 L3332 直接抛 `request.fetcher.connect unavailable`。
症状区分：**`/version` 和 `/sub` 正常但代理连不上** → 基本就是这个。部署器已把 `/version` 和 `/sub` 拆成两段探针（`verifySubscription`），正是为了把「Worker 活着」和「出站可用」分开定位。

### 7.5 外部依赖链（v2ray 格式只碰第 1 条）

| 依赖 | 用途 | 挂了会怎样 |
|---|---|---|
| `raw.githubusercontent.com/cmliu/cmliu` | `CF-CIDR.txt` 优选 IP 段 | **v2ray 节点池退化到 `104.16.0.0/13`**（L5889 有兜底） |
| `SUBAPI.cmliussss.net` | clash/sing-box/surge 转换 | 只影响这几种格式，**v2ray 不受影响** |
| `edt-pages.github.io` | login/admin 面板前端 HTML | 只影响面板，**订阅和代理不受影响** |
| `{colo}.proxyip.cmliussss.net` | 默认反代兜底 | 直连失败时无法回退到第三方出口 |

想彻底去掉第三方依赖（路线 C）：自建 subconverter 替换 `SUBAPI`、把 CIDR 和 `ADD.txt` 灌进 KV、`--proxyip` 用自己的。

### 7.6 反检测混淆 = upstream 有消失风险

L11-15 `特征码字典` 用 `Proxy.name`/`URL.name` 运行时拼出 `["PROXYIP","cmliu","090227"]`；
L16 塞了一大段中英法德"本文件非恶意代码"注释给扫描器看；L5606 写 `"v"+"le"+"ss"`；
L459/L5932 把 UA 伪装成 `Subconverter for...` / `v2rayN/edgetunnel`。

这是主动规避 GitHub 关键词扫描和 DMCA 的手法（该仓库历史上被删过）。
⇒ **必须本地留存源码 + 锁版本**，别 hotlink upstream。`_et/` 目录就是干这个的。

### 7.9 稳定节点池 + CIDR 的真相（--add-ips）

**CIDR 不是写死的**：`生成随机IP()`（L5875）每次生成订阅都**运行时从上游拉取**最新 `CF-CIDR.txt` /
`CF-CIDR/{ct,cu,cmcc}.txt`，拉取失败兜底 `104.16.0.0/13`（L5889）。`_et/` 里那 4 个 txt 只是上游文件的
本地存档副本，**部署和线上都不使用它们**，上游更新即生效，无需我们刷新。所以「定期刷新 CIDR」是个伪需求。

**稳定节点池（--add-ips）**：随机模式下 2 小时自动刷新会让 500 个 IP 全换。想要长期稳定的节点：

```bash
# 方式一：命令行直接给（可带 #名称）
node deploy-edgetunnel.mjs --reconfigure --add-ips '8.39.125.243:2053,1.1.1.1:443#稳定1'

# 方式二：本地文件，每行一条（推荐，方便用脚本探测后落盘）
node deploy-edgetunnel.mjs --reconfigure --add-ips 'file:./stable-ips.txt'

# 想恢复随机模式
node deploy-edgetunnel.mjs --reconfigure --random-ips
```

脚本会：写 KV `ADD.txt` + 把 config 的 `随机IP` 置 `false`（Worker L358 优先读 ADD.txt）。
此后每次刷新节点列表稳定不变。取 IP 的技巧：先用随机模式挑出真实延迟低的节点，把它的 IP:端口记下来，
或用 `probe-random-ip.mjs` / `probe-entrances.mjs` 批量探测后生成 stable-ips.txt。

**伪装页（--fake-page）**：默认 `nginx` 内置页；`--fake-page 1101` 用内置 HTML；`--fake-page example.com`
会把你的域名伪装成该站（反代其首页，替换其中的域名引用），配合 SNI 更像真实站点。

**TG 通知 / CF 用量统计**：`--tg-bot <token> --tg-chat <id>` 每次订阅访问发 TG 通知（注意：会有点吵）；
`--cf-email/--cf-key` 或 `--cf-token` 启用面板里的用量统计。凭据写入 KV `tg.json`/`cf.json`，Worker 覆盖读取
（L5797/L5812），config.json 里相应字段可留空。

### 7.10 凭据落盘

`edgetunnel-credentials.json` 里有 ADMIN 和 KEY 明文。这台机器的目录如果同步到网盘或提交进 git，等于凭据外泄。用完按需删除。

### 7.11 旧内核遗留问题（本方案已顺带解决）

旧 `worker.fixed.js` 的建链竞态（`messageHandler` 在 `await` 之后才赋值，建链期间到达的包被当首包重解析）——
edgetunnel 用 `处理WS入站数据` + 首包状态机（L1635）规避了，这也是换内核的隐性收益之一。

---

## 8. 部署后自检

```bash
H=<你的域名> ; U=<credentials 里的 VLESS_UUID> ; K=<credentials 里的 KEY>

# 订阅 TOKEN = MD5MD5(host + UUID)，与 Worker L304 同算法
T=$(node -e "const{createHash}=require('crypto');const m=s=>createHash('md5').update(s).digest('hex');const M=s=>m(m(s).slice(7,27)).toLowerCase();console.log(M(process.argv[1]+process.argv[2]))" "$H" "$U")

# 1) Worker 存活 + UUID 派生一致（不依赖 KV、不依赖鉴权）
curl -s "https://$H/version?uuid=$U"
#    期望 {"Version":20260904162413}

# 2) v2rayN 订阅节点数
curl -s -A 'v2rayN/7.10.1' "https://$H/sub?token=$T" | base64 -d | grep -c '^vless://'

# 3) 快速订阅路径（应 302 到 /sub?token=）
curl -sI "https://$H/$K" | head -3

# 4) 明文格式抽查
curl -s -A 'v2rayN/7.10.1' "https://$H/$K" -L | base64 -d | head -2
```

> 第 4 步若 `base64 -d` 报错，说明返回的已是明文（浏览器 UA 分支），直接 `head -2` 看即可。

第 4 步期望看到：

```
vless://<UUID>@<CF_IP>:<端口>?security=tls&type=ws&host=<域名>&fp=chrome&sni=<域名>&path=%2F...#CF...优选N
```
