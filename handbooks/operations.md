# 运维手册

> [!NOTE]
> 本文档由 AI 生成,可能存在错误或遗漏,使用前请 review 并实测。

本手册覆盖日常运维操作：用户管理、ACL 管理、邀请码管理、备份、监控。

---

## 用户管理

### 添加成员

```bash
# 1. 生成密码哈希
/opt/authelia/authelia crypto hash generate argon2 --password '新成员密码'
# → $argon2id$v=19$m=65536,t=3,p=4$...

# 2. 编辑用户库
vim /etc/authelia/users.yml
# 追加：
#   username:
#     displayname: Display Name
#     password: "$argon2id$v=19$m=65536,t=3,p=4$..."
#     groups:
#       - dsh-team           # 普通成员
#       # - dsh-admins       # 管理员额外加此组

# 3. 重启 Authelia（已配置 authentication_backend.file.watch: true，
#    保存后自动动态重载，通常无需重启；仅当 watch 失效时才需要）
systemctl restart authelia
```

> ⚠️ 属主/权限红线:`/etc/authelia/configuration.yml` 为 `authelia:authelia 0600`,
> `/etc/authelia/users.yml` 为 `authelia:authelia 644`。以 root 编辑后务必确认
> 属主未被改为 root(否则服务用户读不了配置,会陷入重启循环)。

### 邀请码注册（自助）

管理员生成邀请码，新成员通过 `/register` 自助注册：

1. 在设置 → 多租户卡片 → 「邀请码」区点击 **生成邀请码**
2. 明码仅显示一次，立即复制给新成员
3. 新成员访问 `https://dsh.example.com/register`，填写邀请码 + 用户名 + 密码
4. 注册成功后自动获得 `dsh-team` 组权限

批量签发邀请码：

```bash
curl -b cookie -X POST https://dsh.example.com/tenancy/invites \
  -H 'Content-Type: application/json' \
  -d '{"count":5}'
```

### 禁用成员

编辑 `/etc/authelia/users.yml`，注释掉该用户或移除 `dsh-team` 组，然后 `systemctl restart authelia`。

### 升级为管理员

在用户的 `groups` 列表中追加 `dsh-admins`，重启 Authelia。

---

## 双因素认证（无邮件环境）

Authelia 的二因素只有 TOTP / WebAuthn / Duo 三种，**没有一个靠邮件投递**：注册在
门户完成，密钥用 `storage.encryption_key` 加密后存进 SQLite。`notifier` 只负责通知，
本项目用 `filesystem` 后端兼容无 SMTP。所以 `policy: two_factor` 在无邮件服务器上照样可用。

### 成员自行注册（推荐）

1. 成员用浏览器打开 `https://<域名>/auth/`（经 nginx 的 TLS 入口）登录口令；
2. 首次访问受 `two_factor` 保护的资源时，门户会提示注册第二因素：
   - **验证器 App**（TOTP）：扫码或手动录入；issuer 取 `totp.issuer`；
   - **通行密钥/安全密钥**（WebAuthn）：Touch ID / Windows Hello / YubiKey 均可；
     必须经 HTTPS 真实域名访问，否则浏览器不弹认证器。
3. 注册完回到 `https://<域名>/` 即正常进入 dsh。

### 管理员代办 TOTP（成员不便自己注册时）

用 `storage user totp generate`（直接写进存储，不需要手改任何文件）：

```bash
/opt/authelia/authelia --config /etc/authelia/configuration.yml \
  storage user totp generate <username> --issuer 'dsh.example.com' --path /tmp/<username>-totp.png
```

输出会附一行的 `otpauth://` 链接与基32 密钥：把 PNG 或链接**带外**发给成员
（即时通讯/当面均可），成员扫完下次登录即需输验证码。已存在时加 `--force` 覆盖。
服务器时钟必须准确（`timedatectl show-timesync --property=NTPSynchronized` 为 true），
否则全员报“验证码无效”。

### 丢失二因素 / 导入导出

```bash
# 删除某用户的 TOTP 记录（下次登录重新注册）
/opt/authelia/authelia --config /etc/authelia/configuration.yml storage user totp delete <username>
# 备份/迁移（必须带 --config，否则拿不到 encryption_key）
/opt/authelia/authelia --config /etc/authelia/configuration.yml storage user totp export --format csv
# WebAuthn 凭据查看/删除
/opt/authelia/authelia --config /etc/authelia/configuration.yml storage user webauthn list <username>
```

> 无邮件环境的真实痛点是**密码重置**（依赖 `reset_password.jwt_secret` + 邮件链接），
> 与二因素无关。密码重置靠管理员手改：`/opt/authelia/authelia crypto hash generate argon2
> --password '<新密码>'` 后替换 `users.yml` 里该用户的 `password:` 字段（已开 `watch`，保存即热重载）。

---

## 会话 ACL 管理

> **直连 loopback 的 curl 需要先备好共享密钥**：`sharedSecret` 非空后，不带
> `X-Dsh-Tenancy-Key` 的请求一律 401（不再回落 local 管理员）。本章以及「清理空
> 会话」里的 `127.0.0.1:3088` 示例统一假定已在当前 shell 执行过：
>
> ```bash
> KEY=$(grep -oP '(?<=DSH_TENANCY_SECRET=).*' /etc/caddy/dsh.env)
> alias tcurl="curl -H \"x-dsh-tenancy-key: $KEY\""   # 本机 root 操作视为 local admin
> ```

### 查看 ACL

```bash
# 全部会话 ACL
curl -b cookie https://dsh.example.com/tenancy/sessions

# 单个会话 ACL
curl -b cookie https://dsh.example.com/tenancy/sessions/<sessionId>/acl
```

### 修改 ACL

```bash
curl -b cookie -X POST https://dsh.example.com/tenancy/sessions/<sessionId>/acl \
  -H 'Content-Type: application/json' \
  -d '{
    "owner": "choi",
    "mode": "team-read",
    "readers": ["testmember"],
    "writers": []
  }'
```

**mode 取值**：
- `private` — 仅 owner 可见
- `team-read` — 团队成员可读
- `team-rw` — 团队成员可读写

> **延迟登记**：`session.create` 时不写 ACL，首次 `session.prompt`（真实对话）
> 才落盘。因此新创建但未发消息的会话，在 `GET /tenancy/sessions` 中不可见（无 ACL
> 记录），属正常行为。发首条消息后自动出现。

### 批量 claim 存量会话

首次部署时，存量会话无 ACL 记录。管理员可批量 claim：

```bash
curl -b cookie -X POST https://dsh.example.com/tenancy/claim \
  -H 'Content-Type: application/json' \
  -d '{"sessionIds": ["id1", "id2"], "owner": "admin"}'
```

---

## 清理空会话

  > **自动清理已生效**：插件每 6 小时自动扫描 `$DSH_HOME/sessions/`，
  > 删除 **1 天前 + 无对话**（`session.jsonl.zstd` 或历史 `session.jsonl`
  > 仅有 header 行）的会话文件夹。清理后自动清除 ACL 中的孤儿记录。
  > 日常运维无需手动执行本章节；以下手动流程仅作补充或紧急修复使用。

dsh 没有会话删除 API（只有归档 `workspace.archiveSession`）。清理「空会话」
（`blank: true`、无任何消息）需三步：删目录 → 清 ACL → 清 workspace 索引。

### 1. 找出空会话

```bash
# blank:true = 从未使用过的会话（无标题、无消息）；$KEY 见章首「会话 ACL 管理」说明
curl -s -X POST http://127.0.0.1:3088/api/session.list \
  -H "x-dsh-tenancy-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"t1","method":"session.list","payload":{}}' \
  | jq -r '.result.value.items[] | select(.blank==true) | .sessionId' > /tmp/blank-ids.txt
```

### 2. 删除会话目录（带保护）

```bash
while read -r id; do
  [ -z "$id" ] && continue
  d=$(find /root/.dsh/sessions -maxdepth 2 -type d -name "$id" | head -1)
  [ -z "$d" ] && { echo "GHOST(无目录): $id"; continue; }
  sz=$(du -sb "$d" | cut -f1)
  [ "$sz" -gt 1024 ] && { echo "SKIP(疑似有内容 $sz B): $id"; continue; }   # 防御
  rm -rf "$d" && echo "已删除: $id"
done < /tmp/blank-ids.txt
```

> **⚠ 当前会话保护**：`session-ed8ca9ae-…` 之类的活跃会话绝不在空清单里；删除前
> 用上面的 1KB 阈值做二次防御即可。

### 3. 清理 ACL 旁车记录

删除的会话若在 `$DSH_HOME/tenancy/acl.json` 有记录，会成为「我的会话」里的
幽灵条目（无标题、无文件）：

```bash
node -e '
const fs=require("fs"),path=require("path");
const deleted=new Set(fs.readFileSync("/tmp/blank-ids.txt","utf8").trim().split("\n").filter(Boolean));
const file="/root/.dsh/tenancy/acl.json";
const db=JSON.parse(fs.readFileSync(file,"utf8"));
for(const id of deleted) delete db.sessions[id];
fs.writeFileSync(file+".tmp",JSON.stringify(db,null,2),{mode:0o600});
fs.renameSync(file+".tmp",file);
'
```

### 4. 清理 workspace 索引

`/root/.dsh/storages/workspace.json`（dsh 核心存储）若仍引用已删会话，
`session.list` 会残留该 id（即使目录已删）。同样按 id 剔除 `sessionIds` /
`archivedSessionIds`，并重启 dsh 使注册表重建。

> **⚠ 目录名不全是 `session-` 前缀**：旧版本/部分会话的目录名可能不带前缀
> （如 `41e0b9e2-…`），做「磁盘存在性」扫描时按目录存在判定，不要按前缀过滤，
> 否则会误删有内容会话的 ACL 记录。改完 ACL 后可用
> `node -e '…'` 对照磁盘目录校验每条记录都有对应目录。

### 5. 验证

```bash
# 重启后
curl -s -X POST http://127.0.0.1:3088/api/session.list \
  -H "x-dsh-tenancy-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"t1","method":"session.list","payload":{}}' \
  | jq '.result.value.items | length'    # 应等于非空会话数
```

> 注意：某些插件（如 remote-web-ui）会在自己的工作区周期性自动创建空会话，
> 属正常行为；如不需要可在插件配置里关闭。

---

## 邀请码管理

### 查看邀请码列表

```bash
curl -b cookie https://dsh.example.com/tenancy/invites
```

### 撤销邀请码

```bash
curl -b cookie -X POST https://dsh.example.com/tenancy/invites/revoke \
  -H 'Content-Type: application/json' \
  -d '{"id": "<inviteId>"}'
```

---

## 系统用户（P12）：注册 1:1 建同名 Linux 账号

功能开启（`systemUserEnabled: true`）后，新成员注册成功即自动创建**同名系统用户**：

- `useradd --no-create-home --home-dir /root/dsh/<user> --shell /usr/sbin/nologin`
- **无密码**（shadow 固有 `!` 锁定）、不进任何管理组、shell 为 nologin
  ⇒ **不可登录服务器**（密码登录/SSH/su 均不可用）
- 该账号**唯一**的文件权限是个人工作区 `/root/dsh/<user>`：递归 chown + 目录 0700

### 查看与验证

```bash
# home 应为 /root/dsh/<user>,shell 应为 nologin;密码列应为 !(锁定)
getent passwd alice
grep '^alice:' /etc/shadow

# 个人目录归属(应为 alice:alice,0700)
ls -ld /root/dsh/alice

# 注册相关审计
grep 'sysuser' $DSH_HOME/tenancy/audit.log | jq .
```

### 为存量成员补建（幂等,可重放）

功能启用前注册的成员、或当年注册时建号失败的,由管理员补建:

```bash
# SSH 隧道直连 3088 即 local admin(或带管理员 cookie 经域名访问)
curl -s -X POST http://127.0.0.1:3088/tenancy/sysuser \
  -H 'Content-Type: application/json' -d '{"username":"alice"}' | jq .
# → {"ok":true,"username":"alice","account":{"status":"created|exists",...},"workspace":{...}}
# 冲突(同名既有账号 home/shell 不符)返回 409,插件不接管、不动文件
```

### 注意事项

- **/root 穿越**:个人目录在 `/root` 之下,而 `/root` 常为 0750(缺 other-x),
  系统用户即使拥有 `/root/dsh/<user>` 也到不了——插件只在日志提醒一次
  (每进程一次),是否放开由运维裁决:
  `chmod o+x /root`(仅允许穿越、不可列目录)或 `setfacl -m u:<user>:x /root`。
  插件**不会**擅改 /root 权限。
- **归属维护**:之后由 root(dsh)在个人目录内新建的文件不会自动跟随归属;
  重放补建端点即可全树重新 chown(`sysuser.chown-partial` 表示有部分失败,同样重放)。
- **不做的**:不设/不重置系统口令、不加 sudo/wheel、不删号(移除成员请运维手工
  `userdel -r` 并同步删 users.yml 条目)。

---

## 审计日志

审计日志位于 `$DSH_HOME/tenancy/audit.log`（JSONL 格式，5MB 自动轮转）。

### 记录的事件

| action | 含义 |
|---|---|
| `gate.deny` | 门控拒绝（密钥错误 / admin-only / 不可读 / 不可写） |
| `acl.register` | 首次 `session.prompt` 时登记 ACL |
| `acl.pending` | `session.create`/`session.fork` 成功，暂存到内存等待首 prompt |
| `acl.set` | 手动修改 ACL |
| `acl.claim` | 批量 claim 存量会话 |
| `acl.deny` | ACL 操作被拒绝 |
| `invite.create` | 生成邀请码 |
| `invite.revoke` | 撤销邀请码 |
| `respond.deny` | respond 硬化拒绝 |
| `session.cleanup` | 自动扫盘删除无对话会话文件夹 |
| `register.success` / `register.fail` | 邀请码注册成功/失败 |
| `sysuser.created` / `sysuser.exists` | P12 系统用户新建成功 / 已存在复用 |
| `sysuser.conflict` | P12 同名既有系统账号 home/shell 不符,未接管 |
| `sysuser.fail` | P12 useradd 失败(非 root/命令失败) |
| `sysuser.chown` / `sysuser.chown-partial` / `sysuser.chown-fail` | P12 个人目录归属变更(全部/部分/失败) |
| `sysuser.ensure` | P12 管理端手动补建 |
| `workspace.create` | 注册后自动创建个人工作区 |

### 查看日志

```bash
# 实时跟踪
tail -f $DSH_HOME/tenancy/audit.log

# 搜索特定用户
grep '"actor":"testmember"' $DSH_HOME/tenancy/audit.log

# 搜索拒绝事件
grep 'gate.deny' $DSH_HOME/tenancy/audit.log | jq .
```

---

## 备份

### 关键文件

| 文件 | 说明 |
|---|---|
| `$DSH_HOME/tenancy/acl.json` | 会话 ACL |
| `$DSH_HOME/tenancy/invites.json` | 邀请码库 |
| `$DSH_HOME/tenancy/audit.log` | 审计日志 |
| `/etc/authelia/users.yml` | Authelia 用户库 |
| `/etc/authelia/configuration.yml` | Authelia 配置 |
| `/etc/caddy/Caddyfile` | Caddy 配置 |
| `/etc/caddy/dsh.env` | 共享密钥 |

### 备份脚本

```bash
#!/bin/bash
BACKUP_DIR=/backup/dsh-tenancy/$(date +%Y%m%d)
mkdir -p $BACKUP_DIR

# tenancy 数据
cp $DSH_HOME/tenancy/acl.json $BACKUP_DIR/
cp $DSH_HOME/tenancy/invites.json $BACKUP_DIR/
cp $DSH_HOME/tenancy/audit.log $BACKUP_DIR/

# Authelia
cp /etc/authelia/users.yml $BACKUP_DIR/
cp /etc/authelia/configuration.yml $BACKUP_DIR/

# Caddy
cp /etc/caddy/Caddyfile $BACKUP_DIR/
cp /etc/caddy/dsh.env $BACKUP_DIR/

echo "备份完成: $BACKUP_DIR"
```

---

## 公开站点（P11）：pub.example.com/\<user\>/\<projectName\>

tenancy 在独立端口（默认 `127.0.0.1:3089`）提供**匿名只读**静态发布：把公开域名
转发到该端口后，`pub.example.com/<user>/<projectName>` 就公开服务成员个人工作区
`~/dsh/<user>/<projectName>/dist`（`dist` 可配为 `publicBuildDir`）里的**构建产物**。

### 成员怎么发布

不需要任何标记步骤：只要项目目录下有构建输出（如 `npm run build` 产出
`~/dsh/<user>/<projectName>/dist/index.html`），即可访问：

```text
https://pub.example.com/alice/myapp/            # 页面(index.html)
https://pub.example.com/alice/myapp/assets/app.js   # 静态资源
```

- 无尾斜杠的根 URL 会 301 到带尾斜杠（页面内相对资源依赖尾斜杠）；
- SPA 客户端路由（`/alice/myapp/some/route`）默认回落 `index.html`（
  `publicSpaFallback`）；
- 未构建（无 `dist` 目录）→ 404「未发布」。

#### DSH agent 怎么写应用（`publish-web-app` skill）

插件启动时会向 DSH 注册 `publish-web-app` skill（`skills/publish-web-app.md`，
经 `ctx.skills` 运行时注入，零安装步骤）。agent 编写/构建 Web 应用时自动遵循：

- 项目建在个人工作区 `~/dsh/<user>/<projectName>/`，**构建产物必须放进
  `<项目>/dist/`**（`publicBuildDir` 默认 `dist`）——URL 只映射 dist，项目根目录的
  `index.html` 不会被发布（404）；
- 页面资源必须**相对引用**（`./assets/x.js`、`<base href="./">`），禁止绝对路径
  `/assets/...`（子路径部署下会 404）；Vite 需 `base: './'`；
- **依赖隔离在项目内**：Python 在项目根建 `.venv`（`python3 -m venv .venv`，之后
  一律用 `.venv/bin/python`、`.venv/bin/pip`——DSH 每条 bash 命令是全新 shell，
  `source activate` 不跨命令生效）；Node 依赖装进项目内 `node_modules`，禁止
  `npm install -g`。`.venv`/`node_modules` 是隐藏/依赖目录，公开站点不会服务，
  留在项目内即可，别弄进 `dist`；
- **最简单免构建单页**：无需任何工具，直接把 `index.html` 写进
  `~/dsh/<user>/<projectName>/dist/` 即可访问（CSS/JS 可内联或相对引用）；
- 构建后验证 `dist/index.html` 存在，再告知用户
  `https://<公开域名>/<user>/<projectName>/`。

手动把该 skill 文件拷入 `~/.dsh/skills/` 也能被 dsh-skill-filesystem 发现
（文件带 frontmatter，两种方式同源）。

### 部署（一次性）

1. **插件配置**（`cordis.patch.yml` / install.sh 模板已含）：
   - `publicSitesEnabled: true`（schema 默认即 true）
   - `publicSitesHost: '127.0.0.1'`、`publicSitesPort: 3089`（保持回环绑定！）
   - `publicSitesHosts: ['pub.example.com']`（生产建议；空=接受任意 Host）
2. **nginx**：在 `examples/nginx/dsh.example.com.conf` 末尾新增公开站点 server 块
   （`server_name pub.example.com` 换成你的公开域名，转发到 `127.0.0.1:3089`，
   无鉴权、不走 Caddy/Authelia）。若你的拓扑要求全流量走 Caddy，
   见 `examples/Caddyfile` 末尾的可选块。
3. 重启 dsh-web：`pm2 restart dsh-web`。

### 验证

```bash
# 插件侧:公开站点监听日志
pm2 logs dsh-web --lines 50 | grep 公开站点

# 直连端口(本机)
curl -sI http://127.0.0.1:3089/alice/myapp/ | head -3
# → HTTP/1.1 200 OK  +  content-type: text/html; charset=utf-8

# 经域名
curl -sI https://pub.example.com/alice/myapp/ | head -3
```

### 安全要点（务必读）

- **公开 = 无鉴权**：任何能访问该域名的人都能读任何用户**已构建**项目的内容。
  只服务 `<project>/dist` 构建产物——源码、`.env`、`node_modules`、隐藏文件、
  符号链接逃逸（`dist → /etc`、`dist → 兄弟项目`）一律 404；
- **绑定保持回环**：`publicSitesHost` 不要改成 `0.0.0.0`（插件会打 WARN）；
  公网入口只能是 nginx/Caddy 的转发；
- **Host 白名单**：`publicSitesHosts` 建议显式列出公开域名，防代理侧 Host 错配；
- 端口冲突（3089 被占用）只会让公开站点启动失败并打 error 日志，不影响主站。

### 项目根目录有 index.html 但没有 dist，能访问吗？

**不能**——访问 `https://<公开域名>/<user>/<projectName>/` 返回 404。URL 固定映射到
`~/dsh/<user>/<projectName>/<publicBuildDir>`（默认 `dist`），该目录不存在即视为
「未发布」，项目根目录的文件（包括 `index.html`）不会被服务。这是有意的安全边界：
只公开构建产物，避免把源码/依赖一起暴露。

处理方式（任选其一）：

```bash
# 1) 把静态文件放进 dist(最简单,免构建单页也适用)
mkdir -p ~/dsh/<user>/<projectName>/dist
cp ~/dsh/<user>/<projectName>/index.html ~/dsh/<user>/<projectName>/dist/

# 2) 让构建工具直接输出到 dist(框架项目:Vite 默认即 dist;webpack 设 output.path 等)
```

让 DSH agent 来做的话更省事：`publish-web-app` skill 已写明「产物放 dist、资源相对
引用」的完整约定（见上方「DSH agent 怎么写应用」）。

---

## 服务状态检查

```bash
# Authelia
systemctl status authelia
curl -s http://127.0.0.1:9091/auth/api/health

# Caddy
systemctl status caddy-dsh
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile

# dsh
pm2 status dsh-web
pm2 logs dsh-web --lines 50

# tenancy 插件
curl -b cookie https://dsh.example.com/tenancy/whoami

# 公开站点(P11,独立端口 3089)
curl -sI http://127.0.0.1:3089/ | head -1   # 404 属正常(根无内容);监听失败=端口被占/配置未生效
```

---

## 故障排查与提示

### 页面能渲染,但一直「连接异常」/ 会话模型无法加载

**现象**:登录后 UI 能显示(Signed in as 正常),但连接指示灯异常、会话列表/模型
目录等加载不出来。浏览器 DevTools 可见 `wss://…/api/remote.mux` 握手失败。

**根因**(dsh ≥ 0.1.2):api-gateway 的主 RPC 改为 WebSocket `/api/remote.mux`
多路复用,会话/模型/对话全走这条连接。若 nginx 只给 `/api/events.mux`、
`/api/events.host`、`/sidebar/ws/` 配了升级头,`/api/remote.mux` 会落进普通
`location ^~ /api/`,Upgrade 头被剥掉 → 握手必失败。

**修复**:在 dsh vhost 补 `/api/remote.mux` 升级 location(与 events.mux 同款,
示例见 `examples/nginx/dsh.example.com.conf` 与 deployment.md「接入 nginx」),
然后 `nginx -t && nginx -s reload`,浏览器刷新:

```nginx
location /api/remote.mux { proxy_pass http://127.0.0.1:9443; proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
  proxy_set_header Host $host; proxy_read_timeout 86400s; }
```

### 登录(公网域名)后报 `Failed to load plugins` / `bundle script /plugins/??… failed to load`

**现象**:SSH 隧道直连(`?token=`)一切正常;公网域名登录后首屏报
`Failed to load plugins`、`failed to import loader entry … client-modules:
bundle script /plugins/??@deepseek-ai/…client.js,…&rev=… failed to load`。

**根因**(dsh ≥ 0.1.2 + Caddy forward_auth + Authelia 默认缓冲,与插件本身无关):
0.1.2 的 client-modules 把启动期插件打成「组合 bundle」单批地址
`/plugins/??<模块列表>&rev=<rev>`(全部 client 模块并列,单批 URL 可达 ~2.2KB,
且 query 自身以 `?` 开头,属 dsh 设计格式)。Caddy `forward_auth` 的
`uri /auth/api/authz/forward-auth` 子指令会把原请求 query 原样附加到鉴权
子请求(请求头 `X-Forwarded-URI` 也携带全长 URL),于是 Authelia 收到的请求行
变成 `/auth/api/authz/forward-auth??@deepseek-ai/…&rev=…`(2.2KB+),请求行+请求头
超过 Authelia 默认 4096B 读缓冲 → **431 Request Header Fields Too Large**
(`journalctl -u authelia` 可见 `small read buffer`)。隧道直连不经 Authelia,
所以不受影响。

**定位**:
```bash
journalctl -u authelia --since today | grep -E '431|read buffer'
# → "Request from client exceeded the server read buffer … Buffer size=4096 …
#    GET /auth/api/authz/forward-auth??@deepseek-ai/dsh-typert-registry/client.js,… 431"
```

**修复**(无需改 nginx / Caddy / dsh,模板 `examples/authelia/configuration.yml` 已含):
```bash
# /etc/authelia/configuration.yml
# server:
#   address: 'tcp://127.0.0.1:9091/auth'
#   buffers:
#     read: 16384          # ← 新增;请求行+头 ~5-6KB,16384 留足余量
/opt/authelia/authelia validate-config --config /etc/authelia/configuration.yml
systemctl restart authelia     # 本文件不热重载,必须重启
```
改完硬刷新页面即可;若旧 431 已把组合 bundle 标成失败,重启 dsh 会话或强刷一次。

### `settings are unavailable in this browser`

dsh 配置面（模型/插件/凭证设置）默认仅限**回环浏览器**（hostname 为
localhost/[::1]/127.x）。经域名访问时：

- 非 admin：维持该提示（fail-closed，设计如此）
- admin：需已应用补丁（`bash scripts/apply-patches.sh`）并硬刷新，
  才会发起 `/tenancy/whoami` 解锁配置面

### 设置→插件里看不到「多租户」卡片

可配置 tab 按「settings.describe 命名空间 ∩ 卡片 key」派发卡片。多租户卡片
`key: 'tenancy'` 依赖宿主注册的 `tenancy` settings 命名空间（`lib/index.js`
的 `TENANCY_NS`）。若命名空间未注册（老版本/未重启），卡片不显示。
验证：

```bash
curl -s -X POST http://127.0.0.1:3088/api/settings.describe \
  -H "x-dsh-tenancy-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"t1","method":"settings.describe","payload":{}}' \
  | jq -r '.result.value.namespaces[].ns' | grep -x tenancy
```

### `remote-web-ui: CRITICAL — the /api fence is OPEN for […]`

`@linxin666/dsh-remote-web-ui` 插件的一次性姿态提示：`--trusted-host` 使该 Host
能直通 /api。对本部署（dsh 仅绑 127.0.0.1、全部流量经 nginx→Caddy→Authelia
认证）是预期信任模型，每进程只打一次，无害。

> 但 tenancy 自己的影子路由不走核心那道围栏，所以它自己的 `sharedSecret` 是
> 真正的硬边界：**必须配置且与 Caddy 注入值一致**，否则本机任意进程不带任何头
> 即为 local admin（插件启动时的 WARN 日志就是在提醒这件事）。

### 控制台 `GET /api/update/status → 403`

remote-web-ui 的更新检查端点，其自身设备配对围栏拒绝域名来源。仅影响更新提示
显示，无害。

### 控制台 `404 (acl)`

tenancy 对无 ACL 记录的存量会话返回 404（`no-acl-record`）。owner 徽章因此隐藏、
共享框显示「该会话还没有共享记录」——正常行为；管理员可 `POST /tenancy/claim`
补记录。（修复 pending 读穿后,未发首条消息的新会话也能读回其 pending 记录。）

### 新会话卡「正在刷新模型列表…」/`session.history → 403`（已修复）

成员（非 admin）点 new session 后:模型选择器永卡 `Refreshing model list…`、
历史面板报 `Failed to load history: transport failure for /api/session.history:
HTTP 403`,发一条消息或刷新页面才恢复。

根因是 P7 延迟 ACL 登记的读穿缺口:`session.create`/`fork` 成功后记录先进内存
`pendingSessions`、首条 `session.prompt` 才落盘 `acl.json`,而门控
`readable()/writable()` 与 WS 帧过滤当时只查落盘库——pending 窗口里创建者对
**自己的**新会话也被 403。客户端表现分两头:`session.models` 的 transport 异常
抛在错误态赋值之前,UI 停在 loading（卡「正在刷新」）；history 失败态驻留到
重挂载,所以「刷新才好」其实只是重新拉取,真正恢复权限的是那条 prompt。

已修复（pending 读穿兜底,见 CHANGELOG 2026-08-29）;老版本命中此症状只能升级。
升级后仅剩一个窄窗口:插件**重启**会丢掉 pending——重启前建了但从未发消息的会话
对创建者不可见,fail-closed 兜底（管理员 `POST /tenancy/claim` 可救），且这类
会话本就由扫盘清理任务在 24 小时后删除。

### 确认 dsh 进程用户（改权限前必做）

邀请码注册是 dsh 进程自己 `O_APPEND` 写 `/etc/authelia/users.yml`，所以收权前必须
先搞清那个进程的身份。判靠**端口反查 pid**（pm2 元数据、`ps` 里的名字都不可靠）：

```bash
pid=$(ss -tlnp | grep -oP ':3088\s.*pid=\K[0-9]+' | head -1)   # 换成你的实际端口
grep -E '^(Uid|Gid|Groups)' /proc/$pid/status                    # Uid 全 0 = root，恒可写
ps -o pid,user,uid,group,gid,supg -p $pid
tr '\0' '\n' < /proc/$pid/environ | grep -E '^(HOME|USER|DSH_HOME)='  # 确认旁车文件落在哪
```

- **root**（常见于开发机、`sudo` 拉起）：`chmod o-r` 不影响写入，直接收权即可。
- **非 root 专用用户**：先 `chmod g+w /etc/authelia/users.yml`（644→660）并
  `usermod -aG authelia <dsh用户>`，再收权；随后**重启 dsh 服务**（补充组只在进程
  启动时读取）。
- 多实例时每个端口都要查一遗（如 `web :3088` 与 `web-dev :3080` 是两个不同用户/
  不同 `DSH_HOME` 的进程）；`/etc/authelia` 目录保持 755 即可，追加写不需要目录写权限。

### 控制台 `403 — tenancy: workspace not owned by you`

成员在不属于自己的工作区（旁车 `acl.json` 里没有 owner 记录，或 owner 是别人）
里新建会话被拒。围栏会把会话 cwd 对齐到目标工作区 path，因此这类工作区必须
先由管理员 `POST /tenancy/claim` 思路处理（工作区维度目前无 claim 端点）或
由 owner 本人用 `workspace.create` 重新登记。若团队确实需要共享工作区，优先
改成会话级共享（`POST /tenancy/sessions/<id>/acl` 的 `team-read/team-rw`）。

---

## 配置调优

### 修改工作空间围栏根

编辑 `cordis.patch.yml`：

```yaml
- id: tenancy
  config:
    memberWorkspaceRoot: '~/workspace'   # 改为其他目录
```

重启 dsh 生效。

### 修改默认访问权限

```yaml
- id: tenancy
  config:
    defaultAccess: team-read   # private | team-read | team-rw
```

新创建的会话将使用此默认权限。

### 隐藏空工作区

```yaml
- id: tenancy
  config:
    hideEmptyWorkspaces: true   # 成员不可见的工作区从列表中隐藏
```

---

## 多实例注意事项

同时跑多个 dsh 实例（如生产 `web :3088` + 调试 `web-dev :3080`）时，**每个启用 tenancy 的 profile 必须配置独立的路径**：

```yaml
# web profile
- id: tenancy
  config:
    dbPath: ''          # → $DSH_HOME/tenancy/acl.json
    auditPath: ''       # → $DSH_HOME/tenancy/audit.log
    invitesPath: ''     # → $DSH_HOME/tenancy/invites.json

# web-dev profile
- id: tenancy
  config:
    dbPath: '$DSH_HOME/tenancy-dev/acl.json'
    auditPath: '$DSH_HOME/tenancy-dev/audit.log'
    invitesPath: '$DSH_HOME/tenancy-dev/invites.json'
```

否则两进程各自缓存整份 JSON、整文件原子替换，后写者会清掉前者的记录。拿不准就只在生产 profile 启用 tenancy。
