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

## 会话 ACL 管理

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

### 批量 claim 存量会话

首次部署时，存量会话无 ACL 记录。管理员可批量 claim：

```bash
curl -b cookie -X POST https://dsh.example.com/tenancy/claim \
  -H 'Content-Type: application/json' \
  -d '{"sessionIds": ["id1", "id2"], "owner": "admin"}'
```

---

## 清理空会话

dsh 没有会话删除 API（只有归档 `workspace.archiveSession`）。清理「空会话」
（`blank: true`、无任何消息）需三步：删目录 → 清 ACL → 清 workspace 索引。

### 1. 找出空会话

```bash
# blank:true = 从未使用过的会话（无标题、无消息）
curl -s -X POST http://127.0.0.1:3088/api/session.list \
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

## 审计日志

审计日志位于 `$DSH_HOME/tenancy/audit.log`（JSONL 格式，5MB 自动轮转）。

### 记录的事件

| action | 含义 |
|---|---|
| `gate.deny` | 门控拒绝（密钥错误 / admin-only / 不可读 / 不可写） |
| `acl.register` | 会话创建/fork 时自动登记 ACL |
| `acl.set` | 手动修改 ACL |
| `acl.claim` | 批量 claim 存量会话 |
| `acl.deny` | ACL 操作被拒绝 |
| `invite.create` | 生成邀请码 |
| `invite.revoke` | 撤销邀请码 |
| `respond.deny` | respond 硬化拒绝 |

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
```

---

## 故障排查与提示

### `settings are unavailable in this browser`

dsh 配置面（模型/插件/凭证设置）默认仅限**回环浏览器**（hostname 为
localhost/[::1]/127.x）。经域名访问时：

- 非 admin：维持该提示（fail-closed，设计如此）
- admin：需已应用 P5 补丁（`bash scripts/apply-patches.sh`）并硬刷新，
  才会发起 `/tenancy/whoami` 解锁配置面

### 设置→插件里看不到「多租户」卡片

可配置 tab 按「settings.describe 命名空间 ∩ 卡片 key」派发卡片。多租户卡片
`key: 'tenancy'` 依赖宿主注册的 `tenancy` settings 命名空间（`lib/index.js`
的 `TENANCY_NS`）。若命名空间未注册（老版本/未重启），卡片不显示。
验证：

```bash
curl -s -X POST http://127.0.0.1:3088/api/settings.describe \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"t1","method":"settings.describe","payload":{}}' \
  | jq -r '.result.value.namespaces[].ns' | grep -x tenancy
```

### `remote-web-ui: CRITICAL — the /api fence is OPEN for […]`

`@linxin666/dsh-remote-web-ui` 插件的一次性姿态提示：`--trusted-host` 使该 Host
能直通 /api。对本部署（dsh 仅绑 127.0.0.1、全部流量经 nginx→Caddy→Authelia
认证）是预期信任模型，每进程只打一次，无害。

### 控制台 `GET /api/update/status → 403`

remote-web-ui 的更新检查端点，其自身设备配对围栏拒绝域名来源。仅影响更新提示
显示，无害。

### 控制台 `404 (acl)`

tenancy 对无 ACL 记录的存量会话返回 404（`no-acl-record`）。owner 徽章因此隐藏、
共享框显示「该会话还没有共享记录」——正常行为；管理员可 `POST /tenancy/claim`
补记录。

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
