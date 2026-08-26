# @choi-p/dsh-tenancy

DSH 单实例多租户插件 —— 配套 **Caddy + Authelia** 认证前端使用。

所有用户共享全局模型 `API_KEY` 与插件运行环境，适用于成员间信任度较高的内部团队、小型工作组或亲友共享场景，不适用于需要严格资源隔离的环境。

本 README 同时是整套认证前端的**部署手册**。

```
浏览器 ── TLS ──▶ nginx :443
                    │  dsh.example.com ──▶ Caddy 127.0.0.1:9443(HTTP)
                    │  /auth/* ─────────▶ Authelia 127.0.0.1:9091(门户)
                    ▼
        Caddy:forward_auth 问 Authelia → 注入 Remote-User/Groups
               普通路径: Host 固定为公网域名
               特权方法路径(/api/settings.* 等15个): Host→localhost + 剥 Origin
                    ▼
        dsh 127.0.0.1:3088 + 本插件(exact 影子路由做会话级 owner/access ACL)
```

**效果**:一次登录；普通成员只能看自己的会话；管理员在同一 URL 下 settings/credentials/模型目录全部可用。

---

## 快速部署

```bash
sudo bash install.sh --domain dsh.example.com
# 可选: --admin-user <name>  --admin-password <pass>  --github-proxy https://ghproxy.net/
```

脚本自动完成全部步骤：下载二进制、生成密钥、创建管理员账号并保存凭据至 `/root/dsh-p0-credentials/admin.txt`。

### 前置条件

| 项 | 要求 |
|---|---|
| 已有 | nginx 占 443 且有可用证书的站点 |
| 端口空闲 | `127.0.0.1:9091`(Authelia)、`127.0.0.1:9443`(Caddy)，均只绑回环 |
| DNS/证书 | 不需要新增，复用现有域名与证书 |

> 版本参考：Authelia v4.39.20、Caddy v2.11.4。

---

## 手动部署要点

`install.sh` 会自动完成以下全部步骤。手动部署时参照 [`examples/`](examples/) 目录：

1. **安装二进制** — Authelia → `/opt/authelia/`，Caddy → `/usr/local/bin/`，创建各自服务账号
2. **部署 Authelia** — 复制 [`configuration.yml`](examples/authelia/configuration.yml) 和 [`users.yml`](examples/authelia/users.yml) 到 `/etc/authelia/`，填入随机密钥和口令哈希
3. **部署 Caddy** — 复制 [`Caddyfile`](examples/Caddyfile) 到 `/etc/caddy/`，生成共享密钥 `DSH_TENANCY_SECRET`
4. **接入 nginx** — 参照 [`dsh.example.com.conf`](examples/nginx/dsh.example.com.conf) 修改 vhost

### Authelia 关键点 (v4.39)

- 访问控制规则**顺序敏感**：admins 放行 → 同路径显式 deny → team 放行其余。缺少 deny 规则会导致非管理员穿透

---

## 验收清单

```bash
# ① 未认证 → 302 跳门户
curl -s -o /dev/null -w "%{http_code}\n" https://dsh.example.com/api/host.describe

# ② 登录拿 cookie
curl -s -c /tmp/jar -X POST https://dsh.example.com/auth/api/firstfactor \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"***","targetURL":"","requestMethod":"POST"}'

# ③ 基础 RPC → 200
curl -s -o /dev/null -w "%{http_code}\n" -b /tmp/jar -X POST https://dsh.example.com/api/host.describe \
  -H 'Content-Type: application/json' -H "Origin: https://dsh.example.com" \
  -d '{"type":"client-request","rpcId":"1","method":"host.describe","payload":{}}'

# ④ 特权方法 → 管理员 200 / 成员 403
curl -s -o /dev/null -w "%{http_code}\n" -b /tmp/jar -X POST https://dsh.example.com/api/settings.describe \
  -H 'Content-Type: application/json' -H "Origin: https://dsh.example.com" \
  -d '{"type":"client-request","rpcId":"2","method":"settings.describe","payload":{}}'
```

---

## 插件职责

1. **身份提取** — 读 Caddy 注入的 `Remote-User` / `Remote-Groups`；SSH 隧道直连按 `localPrincipal`（等同 admin）
2. **会话 ACL** — exact 影子路由接管会话类 RPC，按旁车存储 `$DSH_HOME/tenancy/acl.json` 的 `owner/access` 判定；`session.list/search/workspace.list` 响应按可见性过滤
3. **管理面** — `GET/POST /tenancy/*`（whoami / sessions / claim / acl / invites）
4. **事件流隔离 (P2)** — 暴露同步钩子 `globalThis.__dshTenancy`，配合 [`patches/`](patches/) 在 WS downlink pump 处逐帧过滤——未授权会话**零帧**泄漏
5. **Client UI (P3)** — 会话头「共享」按钮 + owner 徽章 + 设置页多租户卡片（[`lib/client.js`](lib/client.js)）
6. **respond 硬化 (P3)** — 影子接管 `/api/respond`：rpcId 须命中事件帧索引且会话可写，否则 403
7. **审计日志 (P3)** — `$DSH_HOME/tenancy/audit.log`（JSONL，5MB 轮转）：门控拒绝、ACL 变更、claim、respond 拒绝
8. **成员工作空间围栏 (P4)** — 非 `dsh-admins` 成员的目录浏览(`host.listDirectory`)、建目录(`host.createDirectory`)、新建工作区(`workspace.create`)、显式会话 cwd(`session.create.cwd`) 全部围在 `memberWorkspaceRoot`（默认 `~/dsh`）内：浏览越界/缺省**静默钳制到根**（看不到根外任何内容），写入越界直接 403
9. **邀请码注册 (P4)** — `/register` 公开页（Caddy 放行匿名访问）+ 一次性邀请码（SHA-256 存储、持文件锁消费），经 authelia CLI 生成 argon2id 哈希后追加写入 `/etc/authelia/users.yml`
10. **登出 (P4)** — 设置页多租户卡片的「登出」按钮：POST `/auth/api/logout` 销毁 Authelia 会话后跳回登录页

---

## ⚠️ 多实例共享 $DSH_HOME 的红线

同时跑多个 dsh 实例(如生产 web :3088 + 调试 web-dev :3080)时,**每个启用 tenancy 的 profile 必须配置独立的 `dbPath` / `auditPath` / `invitesPath`**,否则两进程各自缓存整份 JSON、整文件原子替换,后写者会清掉前者的 ACL/邀请码记录。拿不准就只在生产 profile 启用 tenancy。

---

## P4:工作空间围栏 · 登出 · 邀请码注册

### 成员工作空间围栏

非 `dsh-admins` 成员在「新建工作区」时:

- **目录浏览只见 `~/dsh`(可配)** —— 浏览起点、手工输入越界路径都被静默钳制回围栏根;根外内容零可见
- **可以在围栏内新建** —— 建目录、采纳已有目录为新工作区、以显式 cwd 建会话都放行,但目标必须落在围栏根内(词法 + 符号链接双重校验),越界 403
- 管理员不受限;`memberWorkspaceRoot` 置空则回落旧行为(这些方法 admin-only)
- 已有会话的读取/续聊不受影响——围栏只约束"新建"

### 登出

设置 → 插件 → 多租户卡片,whoami 行右侧「登出」按钮:POST `/auth/api/logout` 销毁 Authelia 服务端会话 → 跳转 `/auth/?rd=%2F` 登录页。

### 邀请码注册(一次性)

1. 管理员在多租户卡片的「邀请码」区点 **生成邀请码**(明码仅显示一次,请立即复制;也可 `curl -b cookie -X POST .../tenancy/invites -d '{"count":5}'` 批量签发)
2. 新成员打开登录页右下角 **「邀请码注册」**(nginx sub_filter 注入)或直接访问 `/register`,填邀请码 + 用户名 + 密码
3. 插件校验:邀请码未用未撤(SHA-256 比对,持文件锁消费,**严格一次性**)→ authelia CLI 生成 argon2id → 追加写入 `/etc/authelia/users.yml`(O_APPEND 单次写,inode 不变,Authelia 文件监听自动重载)→ 标记邀请码已用
4. 注册成功后到登录页登录,自动获得 `dsh-team` 组权限(`registerGroup` 可配,绝不写 admin 组)

防护:每 IP 每 10 分钟 10 次 POST 限流;用户名唯一性在锁内复查;全部动作进审计日志。

> Authelia 若未自动重载用户库(v4.39 一般秒级生效),`systemctl restart authelia` 兜底。

---

## 插件安装与配置

```bash
# 安装
dsh plugin --profile web add github:choi-peng/dsh-tenancy

# 事件帧过滤补丁（幂等；dsh 升级后重跑）
bash scripts/apply-p2-patch.sh && pm2 restart dsh-web

# 验收探测
node scripts/ws-probe.mjs testmember      # 无授权 → 应为 0 帧
node scripts/ws-probe.mjs choi            # admin → 全量
node scripts/ws-probe.mjs local           # SSH 隧道语义 → admin
```

> `sharedSecret` 必须与 `/etc/caddy/dsh.env` 的 `DSH_TENANCY_SECRET` 一致。核对：`dsh --profile web --dump-config | less`

---

## 日常运维

```bash
# 生成密码哈希
/opt/authelia/authelia crypto hash generate argon2 --password '新成员密码'
# → $argon2id$v=19$m=65536,t=3,p=4$...

# 加成员：编辑 /etc/authelia/users.yml 追加用户（password: "$argon2id$..."；groups: dsh-team；管理员额外加 dsh-admins）
systemctl restart authelia
```

- 用户库改动后若无变化则需重启 Authelia
- 初始凭据由 `install.sh` 生成至 `/root/dsh-p0-credentials/`（chmod 700），登录后尽快改密

---

## 故障排查

| 症状 | 原因与解法 |
|---|---|
| forward_auth 全 400，Authelia 报 `insecure scheme` | Caddyfile 加 `servers { trusted_proxies static private_ranges }`，让 nginx 的 `X-Forwarded-Proto` 生效 |
| `wrong argument count ... after '-Remote-Name'` | `header_up -X` 一行只能删一个字段，多字段拆成多行 |
| Authelia 报 `missing host value` | forward_auth `uri` 忘了子路径前缀：应为 `/auth/api/authz/forward-auth` |
| 非管理员也能调 settings.* | 缺少显式 deny 规则；检查规则顺序 |
| 新用户登录失败 `does not exist` | `systemctl restart authelia` |
| 成员建工作区报 `path outside workspace root` | 目标目录不在 `memberWorkspaceRoot` 内;这是预期围栏行为 |
| `/register` 打不开(302 跳门户) | Caddyfile 未放行 `/register` 公开路由,或插件未升级到 P4 |
| 登录页没有「邀请码注册」按钮 | nginx `/auth/` location 未加 sub_filter(见 examples/nginx/);或 Authelia 返回了压缩 HTML |
| 注册报 `server-error` | 检查 dsh 进程对 `autheliaUsersPath` 可写、`autheliaBin` 存在可执行 |
| GitHub 下载超时 | 用镜像前缀 `https://ghproxy.net/` |

---

## 示例文件

| 文件 | 说明 |
|---|---|
| [`examples/Caddyfile`](examples/Caddyfile) | 含 @adminapi 特权路径重写 |
| [`examples/authelia/configuration.yml`](examples/authelia/configuration.yml) | 密钥已脱敏 |
| [`examples/authelia/users.yml`](examples/authelia/users.yml) | 用户库模板 |
| [`examples/nginx/dsh.example.com.conf`](examples/nginx/dsh.example.com.conf) | nginx vhost |
| [`examples/systemd/`](examples/systemd/) | Authelia / Caddy systemd 单元 |

---

## 开发路线图

- [x] P0 认证前端（Caddy + Authelia 同域部署）
- [x] P1 影子路由 + 旁车 ACL + claim 迁移 + sharedSecret + 管理面收紧
- [x] P2 client-connection 原地补丁事件帧过滤
- [x] P3 client 半 UI（共享对话框 / owner 徽章 / 设置卡片）、respond 硬化、审计日志
- [x] P4 成员工作空间围栏(`~/dsh`)、设置卡片登出按钮、一次性邀请码注册(`/register` + nginx 门户注入入口)
- 离线自测:`node scripts/selftest.mjs`(路径围栏/字段校验/注册全事务,argon2 用真实 authelia CLI)
