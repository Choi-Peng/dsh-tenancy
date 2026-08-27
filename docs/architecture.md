# 系统架构

> [!NOTE]
> 本文档由 AI 生成,可能存在错误或遗漏,使用前请 review 并实测。

## 整体拓扑

```
浏览器 ── TLS ──▶ nginx :443
                    │  dsh.example.com ──▶ Caddy 127.0.0.1:9443(HTTP)
                    │  /auth/* ─────────▶ Authelia 127.0.0.1:9091(门户)
                    ▼
        Caddy:forward_auth 问 Authelia → 注入 Remote-User/Groups
               普通路径: Host 固定为公网域名
               特权方法路径(/api/settings.* 等15个): Host→localhost + 剥 Origin
                    ▼
        dsh 127.0.0.1:3088 + tenancy 插件(exact 影子路由做会话级 ACL)
```

## 组件职责

### nginx — TLS 终止 + 入口路由

- 独占 443 端口，持有域名证书
- 将请求分发到 Caddy（应用流量）和 Authelia（认证门户）
- 通过 `sub_filter` 向 Authelia 登录页注入「邀请码注册」入口
- **WebSocket 升级头**：`/api/events.mux|host` 与 `/sidebar/ws/`（better-sidebar
  终端）必须用独立 location 携带 `Upgrade`/`Connection: upgrade`，否则握手被剥掉
  （浏览器报 `WebSocket connection to 'wss://…' failed`）

### Caddy — 认证改写 + 特权路径重写

- `forward_auth` 指令向 Authelia 发起鉴权，成功后注入 `Remote-User` / `Remote-Groups` 头
- 对特权方法路径（`/api/settings.*` 等）做 Host→localhost 重写 + 剥离 Origin，
  解除 dsh 的 loopback 围栏
- 通过 `X-Dsh-Tenancy-Key` 头注入共享密钥，防止身份头伪造
- 放行 `/register` 公开路径（不走 forward_auth）

### Authelia — 身份认证 + 访问控制

- 提供登录门户（TOTP 二因素认证）
- `forward_auth` 端点返回鉴权结果
- 文件后端用户库（`/etc/authelia/users.yml`），支持文件监听自动重载
- 访问控制规则（顺序敏感）：
  1. `dsh-admins` 组对特权路径放行
  2. 其余人对同一批特权路径显式 deny
  3. `dsh-team` 组放行其余路径

### dsh + tenancy 插件 — 应用层多租户

dsh 本身是单用户设计，tenancy 插件通过以下机制实现多租户：

#### 身份提取

从 Caddy 注入的 `Remote-User` / `Remote-Groups` 头提取已验证身份（principal）。
SSH 隧道直连（无注入头）按 `localPrincipal` 处理（默认等同 admin）。

> [!NOTE]
> 信任边界：`sharedSecret` 非空时，`X-Dsh-Tenancy-Key` **必须存在且匹配**（恒定时间
> 比较）——缺失同样返回 401 而不再回落 local 主体，否则抹掉该头即可取得 local
> admin。`sharedSecret` 为空 = 任何能直连本端口的调用方都是 admin，仅限可信内网
> 调试；这种组合下插件启动会打 WARN 日志。

#### 影子路由

以 `exact` 路由注册 30+ 个会话类 RPC（`/api/session.create`、`/api/session.list` 等），
优先级高于 client-connection 的 `/api` 前缀路由。每个请求经过：

1. 身份提取 + 密钥校验
2. admin-only 方法检查
3. 成员路径围栏
4. 会话可读/可写权限检查
5. 转发至上游（`toFetchHandler(apiProxy)`）
6. 响应过滤（`session.list/search/workspace.list` 按可见性裁剪）

#### ACL 旁车存储

`$DSH_HOME/tenancy/acl.json` 存储会话级 ACL 记录（owner / mode / readers / writers），
原子写 + 文件锁保护。不修改 dsh 的会话文件格式（JSONL 头部是白名单序列化，
自定义字段会被丢弃）。

#### 事件帧过滤

通过 `globalThis.__dshTenancy` 钩子暴露同步接口（`principal` / `filterFrame`），
配合 `patches/` 下的补丁在 client-connection 的 WebSocket downlink pump 处逐帧过滤。
未授权会话零帧泄漏，包括内嵌 sessionId 的 workspace/归档视图帧也会被克隆裁剪。

#### respond 硬化

影子接管 `/api/respond`：rpcId 须命中事件帧索引（FIFO 4096 + 24h TTL）且会话对
主体可写，否则 403。

#### 成员工作空间围栏

非 `dsh-admins` 成员的目录浏览、建目录、建工作区、显式会话 cwd 全部限制在 `memberWorkspaceRoot`（默认 `~/dsh`）内：
- 浏览越界/缺省 → 静默钳制到根（看不到根外任何内容）
- 写入越界 → 403
- 词法 + 符号链接双重校验
- 围栏根本身经 `realpath` 归一（`~/dsh -> /` 这类配置不会把整个文件系统变成「根内」）
- `session.create` 不带 cwd 但带 `workspaceId` 时也判围栏：上游会把会话 cwd 对齐到
  目标工作区 path，因此非 admin 只允许在自己名下（旁车已登记 owner）的工作区建会话

#### 邀请码注册

`/register` 公开页 + 一次性邀请码（SHA-256 存储、持文件锁消费），经 authelia CLI 
生成 argon2id 哈希后 O_APPEND 写入 `users.yml`（inode 不变，Authelia 文件监听自动重载，
因此 `authentication_backend.file.watch` 必须为 `true`）。注册限流以 `X-Real-IP`（nginx 
追加，不可被客户端伪造值污染）为键，回退到 socket 地址；IP 桶数量有上限，防假 IP 洪水撑爆内存。

#### 设置面集成

设置→插件「可配置」tab 的派发机制是**两个账本的交集**：
`settings.describe` 提供的命名空间 ∩ 卡片注册的 `key`（`dsh-client-ui-settings-plugins`
的 `ConfigurablePluginsTabController`）。多租户卡片以 `key: 'tenancy'` 注册，
因此宿主必须 serve 同名 settings 命名空间，否则卡片永不显示。

- 命名空间 `tenancy` 经 `ctx.inject(['settings'], …)` 注册，schema 只含
  `registerEnabled` / `memberWorkspaceRoot` / `defaultAccess` / `hideEmptyWorkspaces`
  —— 不暴露 `sharedSecret` 等敏感配置
- 卡片默认收起（与 shell 插件卡片 PluginCard 同构），内容为 whoami / 登出 /
  我的会话（按 `session.list` 的 `projections.values.title` 显示标题）/ 邀请码管理
- 设置服务缺失时注册回调不执行，插件其余功能不受影响（同 deepseek-balance 语义）

#### 延迟 ACL 登记 + 无对话会话清理

  - **延迟登记**：`session.create` / `session.fork` 成功后不立即写 `acl.json`，
    首次 `session.prompt`（真实对话开始）时才落盘。只点 new session 不发消息的
    会话不产生 ACL 记录。
  - **无对话扫盘**：定期扫描 `$DSH_HOME/sessions/`，删除同时满足「目录 mtime
    > 1 天」且「`session.jsonl` 仅有 header 行（无事件）」的会话文件夹。
    清理间隔 6 小时，首次延迟 1 分钟启动。
  - fork 子会话继承父 access 时同时查 ACL store 和待注册表（父可能也尚未首 prompt）。

## 安全模型

### 纵深防御层次

| 层 | 机制 | 防护目标 |
|---|---|---|
| L1 — TLS | nginx 证书 | 传输加密 |
| L2 — 认证 | Authelia 二因素 | 身份真实性 |
| L3 — 头完整性 | Caddy `X-Dsh-Tenancy-Key` 共享密钥 | 防止绕过代理直接伪造 Remote-User |
| L4 — 特权路径 | Caddy Host→localhost 重写 + Authelia deny | 非管理员无法触达 settings/credentials |
| L5 — 客户端围栏 | dsh `isLoopback` 判定 + 补丁 | 域名浏览器默认不可见配置面；仅对 `dsh-admins` 放行 |
| L6 — 应用 ACL | tenancy 影子路由 + 旁车存储 | 会话级 owner/access 隔离 |
| L7 — 事件流 | WS pump 逐帧过滤 | 未授权会话零帧泄漏 |
| L8 — respond | rpcId 索引 + writable 校验 | 防止跨会话 respond |

### 信任边界

- **管理员**（`dsh-admins` 组或 SSH 隧道 local）：完全放行，可访问所有会话和管理功能
- **普通成员**（`dsh-team` 组）：仅可见自己的会话 + 被授权的会话（team-read/team-rw/readers）
- **未认证**：302 跳转 Authelia 登录页

## 数据流

### 普通 RPC 请求

```
浏览器 → nginx(TLS) → Caddy(forward_auth → Authelia 鉴权 → 注入头)
  → tenancy 影子路由(身份提取 → ACL 检查 → 转发)
  → dsh 核心处理 → tenancy 响应过滤 → 浏览器
```

### WebSocket 事件流

```
浏览器 → nginx → Caddy → dsh WS 升级
  → 补丁: principal(req) 记录主体
  → downlink pump 循环: filterFrame(principal, frame) 逐帧过滤
  → 仅放行帧到达浏览器
```

### 邀请码注册

```
新成员 → /register(公开) → 提交邀请码 + 用户名 + 密码
  → 插件校验邀请码(文件锁) → authelia CLI 生成 argon2id
  → O_APPEND 写入 users.yml → Authelia 自动重载
  → 新成员登录 → 自动获得 dsh-team 组权限
```

## 文件布局

```
$DSH_HOME/tenancy/
├── acl.json          # 会话 ACL 旁车存储（原子写 + 文件锁）
├── acl.json.lock     # 文件锁
├── audit.log         # 审计日志（JSONL，5MB 轮转）
├── invites.json      # 邀请码库（SHA-256 存储）
└── invites.json.lock # 文件锁
```
