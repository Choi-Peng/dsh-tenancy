# 开发日志

> [!NOTE]
> 本文档由 AI 生成,可能存在错误或遗漏,使用前请 review。

## 2026-08-27

### 安全审查修复（第一批）

- **共享密钥强校验**（`lib/index.js`）：`sharedSecret` 非空时 `X-Dsh-Tenancy-Key`
  缺失也会被拒（旧逻辑只在「带头且值不符」时拒绝，抹掉该头即得 local admin）；
  比较改为 `timingSafeEqual`，带错/不带的响应不再可区分。空密钥 + `localIsAdmin`
  的组合现在会在启动时打 WARN
- **围栏根 realpath 归一**（`lib/util.js` `expandHomeDir` + `lib/index.js`）：
  `memberWorkspaceRoot` 自身是符号链接（如 `~/dsh -> /`）时不再把整个文件系统
  当作「根内」；启动时 mkdir 后再补一次归一并记录实际路径
- **`session.create` 的 workspaceId 旁路**：非 admin 不带 cwd 但传 `workspaceId` 时，
  要求该工作区在旁车已登记且 owner 为本人，否则 403（上游会把会话 cwd 对齐到
  工作区 path，不查即可绕过围栏）；`confineMemberPayload` 因此改为异步
- **注册限流加固**（`lib/register.js`）：限流键不再取客户端可控的 XFF 最左值，
  改用 `X-Real-IP`（回退 socket 地址）；IP 桶加 4096 上限，假 IP 洪水不再无界占内存
- **Authelia 模板补 `authentication_backend.file.watch: true`**：缺此项时邀请码注册
  写进 `users.yml` 的用户不会热重载（注册成功但登录必败）
- **凭据文件收权**（`install.sh`）：`/etc/authelia/configuration.yml` 新建即 600，
  与 `users.yml` 一起 `chmod o-r`（哈希/邮箱/会话密钥不再世界可读）
- 文档同步：`docs/architecture.md` 信任边界、`handbooks/deployment.md` 密钥/权限
  要求、`handbooks/operations.md` 直连 loopback 的 curl 需带 `x-dsh-tenancy-key`
- `scripts/selftest.mjs` 新增「④ 安全边界回归」（围栏根符号链接、限流键与上限）

> 待办（已记录未修）：影子路由复用核心 browser-trust 围栏（Host/Origin/sec-fetch-site）、
> Caddy 特权路径清单与 Authelia 正则清单双源同步、2FA 后端缺失（`two_factor` 实为单因子）。

### P7 — 延迟 ACL 登记 + 无对话会话清理

- `session.create` / `session.fork` 成功后不再立即写 `acl.json`，改为暂存到
  纯内存 `pendingSessions` 表；首次 `session.prompt`（真实对话开始）时才落盘
  登记 ACL，审计动作从 `acl.register` 拆为 `acl.pending`（创建时）+
  `acl.register`（首 prompt 时）
- 恢复路径：插件重启/升级后 `pendingSessions` 丢失，首次 `session.prompt`
  命中未在 ACL 中的会话时按当前 principal 补登记（审计标记 `recovery`）
- fork 子会话继承父 access 时同时查 `pendingSessions` 兜底（父可能也在
  pending 中尚未首 prompt）
- 无对话会话扫盘清理：启动 1 分钟后首次执行，之后每 6 小时扫描
  `$DSH_HOME/sessions` 下所有 project/session 目录，删除满足「mtime > 1 天
  且 `session.jsonl` 无真实对话（≤1 行或不存在）」的会话文件夹；删除前清理
  `pendingSessions` 残留条目，审计记录 `session.cleanup`
- 清理使用并发锁（`cleanupRunning`）避免重叠执行，effect 销毁时清除定时器

### Bug 修复

- **修复 workspace.list 过滤失效**：实测 RPC 响应信封为
  `{ result: { value: { items: [...], archivedSessionIds: [...] } } }`，
  原代码只检查 `value.workspaces` / `value.rows`，漏了 `value.items`，
  导致过滤逻辑命中空数组、所有工作区原样返回。已补全 `value.items` 分支

### P6 — 工作区 owner 隔离

- `workspace.create` 成功后旁车登记 owner（`acl.json` 的 `workspaces` 表，
  采纳已有目录返回已存在记录时绝不覆盖既有 owner）；`workspace.delete` 同步清理
- `workspace.list` 对非 admin 仅返回本人创建的工作区；无旁车记录的存量工作区
  fail-closed 仅 admin 可见（与存量会话同策略）
- WS 帧同步收紧：`workspace-changed` 视图帧非己有整帧丢弃，
  `workspace-removed` / `workspace-order-changed` 帧仅保留己有工作区引用
- `hideEmptyWorkspaces` 收敛为 admin 视角：己有工作区即使为空也保留
  （成员侧"非己有即隐藏"已无条件生效）

### 验收

- 成员 choi 建新工作区 → 仅自己可见；testmember 的 workspace.list 不含
  choi 的工作区（含 sessionIds 全量裁剪）✓
- WS 帧：choi 建工作区，testmember 零 workspace-changed 帧（含内嵌 ID 扫描）✓
- admin 全量可见不受影响；存量无记录工作区仅 admin 可见 ✓

## 2026-08-26

### P4 后续 — 注册页与门户微调

- `/register` 成功分支改为**自动 continue**：展示「注册成功!正在前往登录…」约 1.2s
  后自动跳转 `/auth/?rd=%2F`（`location.replace`，后退键不回到已消费邀请码的表单页；
  跳转前提交按钮保持禁用防重复提交），移除手动「Continue/去登录」链接
- Authelia 门户「邀请码注册」入口从 nginx 悬浮按钮（sub_filter 注入）迁入登录表单：
  重置密码行左侧（等长二进制补丁，见 `tools/authelia_register_link_patch.py`
  与 `tools/README.md`）
- **修复注册密码哈希截断**：`hashArgon2` 提取正则字符类漏了逗号，
  `$argon2id$v=19$m=65536,t=3,p=4$…$…` 在首个逗号处被截断入库（登录必败）；
  改为严格匹配完整 argon2 编码（参数段+盐段+摘要段）。受影响的存量测试账号
  （inviteduser / inviteduser2）已从 users.yml 清除（备份在 `.dsh-repair/`），
  需用新邀请码重新注册
- **修复注册用户登录失败（第二层根因）**：Authelia v4.39 的
  `authentication_backend.file.watch` 默认 `false`，注册直写 users.yml 后
  Authelia 感知不到新增用户 → 登录报 "Incorrect username or password"。
  已在 `/etc/authelia/configuration.yml` 显式开启 `watch: true`，追加/删除
  用户均验证动态重载生效（探针用户免重启即登录、删除后立即失效）
- 运维红线记录：两个 yml 属主必须保持 `authelia:authelia`
  （configuration.yml 0600 / users.yml 644）；root 编辑后若属主变为 root，
  服务用户读不了配置会陷入重启循环
### P5 — 域名入口管理放行

- 编写 client.js 补丁：`isLoopback` 判定追加 `/tenancy/whoami` 同步请求
- 仅 `dsh-admins` 经域名访问时可用设置→模型/插件管理功能
- 成员与未登录者行为零变化（fail-closed）

### 工程整理

- 合并 P2/P5 补丁为单个 `dsh-client-connection-*.patch`
- 合并 `apply-p2-patch.sh` + `apply-p5-admin-domain-patch.sh` → `apply-patches.sh`
- README 精简，去除开发相关内容

### 设置面集成收尾

- **tenancy settings 命名空间**：宿主注册 `tenancy` 命名空间（`registerEnabled` /
  `memberWorkspaceRoot` / `defaultAccess` / `hideEmptyWorkspaces`，无敏感字段）。
  设置→插件「可配置」tab 按「settings.describe 命名空间 ∩ 卡片 key」派发卡片，
  此前因宿主不 serve `tenancy` 命名空间，多租户卡片永不显示（与 P5 无关，
  只是此前插件设置整体不可用掩盖了它）
- 多租户卡片改为**可折叠**，与 shell 插件卡片（PluginCard）同构：header 按钮 +
  chevron + 默认收起
- 「我的会话」列表由 session id 改为**会话标题**（并行 `session.list` 合并
  `projections.values.title`；无标题显示「未命名会话」，悬停可看原始 id）
- **nginx 修复**：新增 `location ^~ /sidebar/ws/` WebSocket 升级块——
  此前 better-sidebar 的终端 WS 升级头被 nginx 剥掉，浏览器报
  `WebSocket connection to 'wss://…/sidebar/ws/agent-terminals' failed`
- 运维：空会话清理流程沉淀（见 handbooks/operations.md）

### P4 — 工作空间围栏、邀请码注册、登出

- 成员工作空间围栏：非 `dsh-admins` 的目录浏览/新建工作区/新建会话限制在 `~/dsh` 内
- 浏览越界静默钳制到根，写入越界 403
- 一次性邀请码注册：`/register` 公开页 + SHA-256 存储 + authelia CLI 生成 argon2id
- 设置卡片「登出」按钮：POST `/auth/api/logout` 销毁 Authelia 会话

### P3 — Client UI、respond 硬化、审计日志

- 会话头「共享」按钮 + owner 徽章
- 设置页多租户卡片（whoami / 登出 / 邀请码管理）
- 影子接管 `/api/respond`：rpcId 须命中事件帧索引且会话可写，否则 403
- 审计日志 `$DSH_HOME/tenancy/audit.log`（JSONL，5MB 轮转）

## 2026-08-25
### P2 — 事件帧过滤

- 编写 `dsh-client-connection` 原地补丁，在 WS downlink pump 处注入 `__dshTenancy` 钩子
- 未授权会话零帧泄漏（含内嵌 sessionId 的 workspace/归档视图帧克隆裁剪）
- 编写 `scripts/apply-patches.sh` 幂等应用补丁

### P1 — 影子路由 + 旁车 ACL

- 插件骨架 `lib/index.js`：身份提取、会话 ACL、管理面 `/tenancy/*`
- exact 影子路由接管会话类 RPC，按 `owner/access` 判定可见性
- `session.list/search/workspace.list` 响应按可见性过滤
- claim 迁移存量会话（无 owner 的会话自动分配给首次访问者）
- 启用 `sharedSecret` 校验（插件 ↔ Caddy 共享密钥）
- `host.listDirectory/createDirectory` 收紧为 admin-only

### P0 — 认证前端搭建

- 搭建 Caddy + Authelia 认证前端，实现单实例 dsh 多人复用
- Caddy `forward_auth` 对接 Authelia，注入 `Remote-User` / `Remote-Groups`
- 特权路径（`settings.*` 等 15 个）Host 重写为 localhost，解除 dsh loopback 围栏
- 编写 `install.sh` 一键部署脚本（下载二进制、生成密钥、创建管理员）
- 凭据保存目录改为可配置的 `CRED_DIR`（默认 `/root/dsh-p0-credentials/`）
- 添加 nginx / Caddy / Authelia / systemd 配置示例

### 验收

- 影子路由生效（响应头 `x-tenancy-gate`）✓
- 密钥错误 + 伪造 Remote-User → 401 ✓
- session.list 可见性：local admin 24 行 / choi 18 行 / testmember 0 行 ✓
- grant reader 后 testmember 对该会话 history 200；未授权会话 403 ✓
- WS events.mux：choi 建新会话，testmember 零帧（含内嵌 ID 扫描）✓
