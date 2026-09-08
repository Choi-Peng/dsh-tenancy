# @choi-p/dsh-tenancy

> [!NOTE]
> 本文档由 AI 生成,可能存在错误或遗漏,使用前请 review 并实测。

DSH 单实例多租户插件 —— 配套 **Caddy + Authelia** 认证前端使用。

所有用户共享全局模型 `API_KEY` 与插件运行环境，适用于成员间信任度较高的内部团队、
小型工作组或亲友共享场景，不适用于需要严格资源隔离的环境。

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

---

## 快速部署

```bash
sudo bash install.sh --domain dsh.example.com
# 可选: --admin-user <name>  --admin-password <pass>  --github-proxy https://ghproxy.net/
```

脚本自动完成全部步骤：下载二进制、生成密钥、创建管理员账号并保存凭据至 
`/root/dsh-p0-credentials/admin.txt`。

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

1. **安装二进制** — Authelia → `/opt/authelia/`，Caddy → `/usr/local/bin/`，
    创建各自服务账号
2. **部署 Authelia** — 复制 [`configuration.yml`](examples/authelia/configuration.yml) 
    和 [`users.yml`](examples/authelia/users.yml) 到 `/etc/authelia/`，
    填入随机密钥和口令哈希
3. **部署 Caddy** — 复制 [`Caddyfile`](examples/Caddyfile) 到 `/etc/caddy/`，
    生成共享密钥 `DSH_TENANCY_SECRET`
4. **接入 nginx** — 参照 [`dsh.example.com.conf`](examples/nginx/dsh.example.com.conf) 
    修改 vhost

### Authelia 关键点 (v4.39)

- 访问控制规则**顺序敏感**：admins 放行 → 同路径显式 deny → team 放行其余。
  缺少 deny 规则会导致非管理员穿透

---

## 插件功能

1. **身份提取** — 读 Caddy 注入的 `Remote-User` / `Remote-Groups`；
    SSH 隧道直连按本地管理员处理
2. **会话 ACL** — 影子路由接管会话类 RPC，按 `owner/access` 判定可见性；
    `session.list/search/workspace.list` 响应自动过滤
3. **事件流隔离** — WebSocket 下行逐帧过滤，未授权会话**零帧**泄漏
4. **管理面** — `/tenancy/*` 提供 whoami / sessions / claim / acl / invites 接口
5. **Client UI** — 会话头「共享」按钮 + owner 徽章 + 设置页多租户卡片（含登出）
6. **工作空间围栏** — 非管理员的目录浏览、新建工作区、新建会话全部限制在 `~/dsh`（可配）内；
    浏览越界静默钳制到根，写入越界 403
7. **邀请码注册** — 管理员生成一次性邀请码，新成员通过 `/register` 自助注册
8. **审计日志** — `$DSH_HOME/tenancy/audit.log`（JSONL，5MB 轮转）记录门控拒绝、
    ACL 变更等
9. **公开站点（P11）** — 独立端口匿名静态发布：把公开域名（如 `pub.example.com`）
    经 nginx/Caddy 转发到 `127.0.0.1:3089`，则
    `pub.example.com/<user>/<projectName>` 直接公开个人工作区里构建好的项目
    （`~/dsh/<user>/<projectName>/dist`，构建输出目录名可配）。无鉴权、只读，
    只服务构建产物，不暴露源码/隐藏文件；详见 [docs/architecture.md](docs/architecture.md) 与
    [handbooks/operations.md](handbooks/operations.md)
10. **发布指引 skill** — 插件启动时经 `ctx.skills` 注册 `publish-web-app` skill
    （`skills/publish-web-app.md`）：DSH agent 编写/构建 Web 应用时自动遵循
    「产物放 `<项目>/dist/`、资源相对引用」的约定，含最简单免构建单
    `index.html` 的写法；该文件也可直接拷入 `~/.dsh/skills/` 使用
11. **系统用户开通（P12）** — 新成员注册成功即创建**同名 Linux 系统用户**：
    `nologin` shell + 无密码（shadow 固有锁定）+ 不进任何管理组 ⇒ **不可登录服务器**；
    其唯一文件权限是个人工作区 `~/dsh/<user>`（dsh 以 root 运行时即
    `/root/dsh/<user>`）：递归 chown + 目录 0700。幂等可重放；同名既有系统账号
    不符时判 conflict 不接管；存量成员可经 `POST /tenancy/sysuser` 补建

---

## ⚠️ 多实例共享 $DSH_HOME 的红线

同时跑多个 dsh 实例时，**每个启用 tenancy 的 profile 必须配置独立的 `dbPath` / 
`auditPath` / `invitesPath`**，否则后写者会清掉前者的 ACL/邀请码记录。
拿不准就只在生产 profile 启用 tenancy。

---

## 插件安装与配置

```bash
# 安装
dsh plugin --profile web add github:choi-peng/dsh-tenancy

# 应用全部补丁（dsh 升级后重跑）
bash scripts/apply-patches.sh && pm2 restart dsh-web
```

> `sharedSecret` 必须与 `/etc/caddy/dsh.env` 的 `DSH_TENANCY_SECRET` 一致。配好后，
> 未携带 `X-Dsh-Tenancy-Key` 的请求会被直接 401（不再回落为 local 管理员）；
> 留空则任何能直连 `127.0.0.1:3088` 的进程都是 admin，**不得用于生产**。
> 核对：`dsh --profile web --dump-config | less`

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
- 初始凭据由 `install.sh` 生成至 `/root/dsh-p0-credentials/`（chmod 700），
  登录后尽快改密

### 系统用户(P12)

注册成功时自动 `useradd -M -s /usr/sbin/nologin` 建同名账号(无密码、不进管理组
⇒ 不可登录),并把 `~/dsh/<user>` 递归 chown 给它、目录 0700。相关操作:

```bash
# 查看某成员的系统账号(home 应为 /root/dsh/<user>,shell 应为 nologin)
getent passwd alice

# 为存量成员(功能启用前注册)补建账号与目录归属(SSH 隧道直连 3088 即 local admin)
curl -s -X POST http://127.0.0.1:3088/tenancy/sysuser \
  -H 'content-type: application/json' -d '{"username":"alice"}'
```

- 该账号**唯一**的文件权限是其个人工作区;后续由 root(dsh)在区内新建的文件
  不会自动跟随归属,可重放上面的补建端点(幂等,全树重新 chown)
- `/root` 常为 0750,系统用户无法穿越抵达个人目录——插件会在日志提示一次;
  确需真实可访问时自行决策:`chmod o+x /root`(仅允许穿越、不可列目录)
  或 `setfacl -m u:<user>:x /root`。插件**不会**擅改 /root 权限

---

## 故障排查

| 症状 | 原因与解法 |
|---|---|
| forward_auth 全 400，Authelia 报 `insecure scheme` | Caddyfile 加 `servers { trusted_proxies static private_ranges }`，让 nginx 的 `X-Forwarded-Proto` 生效 |
| `wrong argument count ... after '-Remote-Name'` | `header_up -X` 一行只能删一个字段，多字段拆成多行 |
| Authelia 报 `missing host value` | forward_auth `uri` 忘了子路径前缀：应为 `/auth/api/authz/forward-auth` |
| 非管理员也能调 settings.* | 缺少显式 deny 规则；检查规则顺序 |
| 新用户登录失败 `does not exist` | `systemctl restart authelia` |
| 成员建工作区报 `path outside workspace root` | 目标目录不在围栏根内，预期行为 |
| `/register` 打不开(302 跳门户) | Caddyfile 未放行 `/register` 公开路由 |
| 登录页没有「邀请码注册」按钮 | nginx `/auth/` location 未加 sub_filter |
| 注册报 `server-error` | 检查 dsh 进程对 `autheliaUsersPath` 可写、`autheliaBin` 存在可执行 |
| 注册成功但没有系统账号 | `systemUserEnabled` 未开/进程非 root/找不到 nologin shell → 看启动 WARN;存量成员经 `POST /tenancy/sysuser` 补建 |
| 审计出现 `sysuser.conflict` | 同名既有系统账号 home/shell 与约定不符,插件不接管不动文件;人工裁决 |
| 审计出现 `sysuser.chown-partial` | 个人目录部分条目 chown 失败(见审计 detail);重放 `POST /tenancy/sysuser` |
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
