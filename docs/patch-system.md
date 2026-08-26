# 补丁系统

> [!NOTE]
> 本文档由 AI 生成,可能存在错误或遗漏,使用前请 review 并实测。

## 为什么需要补丁

dsh 的 `dsh-client-connection` 包负责 WebSocket 事件帧的下行分发（pump 循环）和
客户端 `isLoopback` 判定。这两个关键点没有提供插件钩子，必须通过源码级补丁实现：

- **P2 事件帧过滤** — 在 pump 循环中注入 `filterFrame` 调用，实现未授权会话零帧泄漏
- **P5 域名入口管理放行** — 在 `isLoopback` 判定后追加 `/tenancy/whoami` 同步请求，
  让管理员经域名可用配置面

## 为什么不用 pnpm patch

dsh 采用**两锚解析**（dsh 安装目录优先、profile 兜底），
且 `$DSH_HOME/profiles/node_modules` 里的包只是指向安装目录的符号链接。
`client-connection` 全机只有一份物理副本，profile 的依赖树里也没有它，`pnpm patch` 看不见。

原地修改这一份即同时覆盖两个锚。

## 补丁文件

```
patches/
└── dsh-client-connection-<version>.patch   # 组合补丁（含 P2 + P5）
```

补丁按 dsh 的 `client-connection` 版本号命名。升级 dsh 后需检查是否需要 rebase。

### 组合补丁结构

单个 `.patch` 文件包含多个目标文件的变更：

```diff
--- a/lib/index.js          ← P2: WS pump 钩子
+++ b/lib/index.js
@@ ...
 
--- a/lib/client.js         ← P5: isLoopback 放宽
+++ b/lib/client.js
@@ ...
```

## 应用脚本

`scripts/apply-patches.sh` 幂等应用全部补丁：

### 执行流程

1. **定位目标** — 解析 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-connection` 的符号链接，找到物理副本
2. **版本匹配** — 读取包的 `package.json` 版本号，匹配 `patches/dsh-client-connection-<version>.patch`
3. **幂等检查** — 分别检测两个文件：
   - `lib/index.js` 包含 `__dshTenancy` → P2 已应用
   - `lib/client.js` 包含 `dsh-tenancy P5` → P5 已应用
   - 全部已应用则直接退出
4. **备份原件** — 创建 `.pristine` 备份
5. **拆分应用** — 用 `awk` 从组合补丁中拆出单文件段，分别 `patch -s` 应用
6. **语法校验** — `node --check` 验证两个文件
7. **错误回滚** — `trap ERR` 自动从 `.pristine` 还原

### 输出示例

```
  ✓ P2 事件帧过滤 → /path/to/lib/index.js
  ✓ P5 域名入口放行 → /path/to/lib/client.js
✓ 补丁已应用(0.1.1-rc.2) —— 重启 dsh 后生效; 卸载 = cp .pristine 回去
```

## 补丁详情

### P2 — 事件帧过滤

**目标文件**: `lib/index.js`（`dsh-client-connection` 的服务端入口）

**变更内容**:

1. WebSocket 升级时调用 `globalThis.__dshTenancy.principal(req)` 提取主体
2. `pump` 方法签名增加 `principal` 参数
3. pump 循环中每帧调用 `filterFrame(principal, frame)`，返回 `null` 则丢弃

**钩子接口**:

```javascript
globalThis.__dshTenancy = {
  version: 2,
  principal: (req) => principal | null,  // null = 密钥校验失败
  filterFrame: (principal, frame) => frame | null | clonedFrame
}
```

### P5 — 域名入口管理放行

**目标文件**: `lib/client.js`（`dsh-client-connection` 的客户端打包产物）

**变更内容**:

在 `isLoopback` 判定后追加同步 `/tenancy/whoami` 请求：

```javascript
isLoopback: pageLocation === void 0 
  || isLoopbackHostname(pageLocation.hostname)
  || /* [dsh-tenancy P5] */ (() => {
       try {
         if (typeof XMLHttpRequest === "undefined") return false;
         const xhr = new XMLHttpRequest();
         xhr.open("GET", "/tenancy/whoami", false);  // 同步
         xhr.send(null);
         return xhr.status === 200 && JSON.parse(xhr.responseText).admin === true;
       } catch { return false; }
     })()
```

**语义**:
- 仅当 tenancy 报告 `admin: true`（Authelia 组含 `dsh-admins`）才视为可信
- tenancy 未装 / 非 admin / 请求失败 → fail-closed
- 成员与未登录者行为零变化

## 维护

### dsh 升级后

1. 检查 `client-connection` 版本是否变化
2. 若版本变化，尝试应用补丁：`bash scripts/apply-patches.sh`
3. 若 `.rej`，需手动 rebase `patches/` 下的补丁文件
4. 重启 dsh：`pm2 restart dsh-web`

### Rebase 补丁

```bash
# 1. 找到新的原件位置
TARGET=$(readlink -f $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-connection)

# 2. 生成新补丁
diff -u $TARGET/lib/index.js.orig $TARGET/lib/index.js > patches/dsh-client-connection-<new-version>.patch
# 对 client.js 同理，追加到同一 patch 文件

# 3. 测试应用
bash scripts/apply-patches.sh
```

### 回滚

```bash
TARGET=$(readlink -f $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-connection)
cp $TARGET/lib/index.js.pristine $TARGET/lib/index.js
cp $TARGET/lib/client.js.pristine $TARGET/lib/client.js
pm2 restart dsh-web
```
