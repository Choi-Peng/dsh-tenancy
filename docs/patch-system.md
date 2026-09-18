# 补丁系统

> [!NOTE]
> 本文档由 AI 生成,可能存在错误或遗漏,使用前请 review 并实测。

## 为什么需要补丁

dsh 的核心包没有提供插件钩子，必须通过源码级补丁实现多租户：

- **P2 — 事件帧过滤 + 流开闸**：`/api/remote.mux` WebSocket 的
  `RemoteStreamMuxConnection` 在握手时提取代理身份(principal)、流开闸时
  `gateStream` 判定、下行 item 逐帧 `filterEvent` 过滤。
  dsh 0.1.5-rc.2 起该类在 **`dsh-api-gateway/lib/index.js`**。
- **P5 — 域名入口管理放行**：客户端 `isLoopback` 判定后追加 `/tenancy/whoami`
  同步请求，仅 admin 视为可信，让管理员经域名可用配置面。
  在 **`dsh-client-connection/lib/client.js`**。
- **P5b — 服务端 BrowserAuth 旁路**：经 Caddy/Authelia 进来、带
  `X-Dsh-Tenancy-Key` 头的请求直接视为已认证(免 browser-session cookie)。
  在 **`dsh-client-connection/lib/index.js`** 的 `requestRejection` /
  `authorizeIndex` 两处。

## 补丁文件

```
patches/
├── dsh-api-gateway-<version>.patch           # P2(api-gateway/lib/index.js)
├── dsh-client-connection-<version>.patch     # P5(client.js) + P5b(index.js)
└── dsh-client-connection-0.1.1-rc.2.patch    # 历史版本(≤0.1.1 专用)
```

补丁按包名 + 安装版本号命名。升级 dsh 后 `apply-patches.sh` 按
`package.json` 的 `version` 自动匹配对应补丁，无需手动指定。

### 已支持版本

| 包 | 版本 | 状态 |
|---|---|---|
| `dsh-api-gateway` | `0.1.2-rc.1` | 保留(旧版) |
| `dsh-api-gateway` | `0.1.5-rc.2` | **当前** |
| `dsh-client-connection` | `0.1.1-rc.2` | 历史(≤0.1.1 专用) |
| `dsh-client-connection` | `0.1.2-rc.1` | 保留(旧版) |
| `dsh-client-connection` | `0.1.5-rc.2` | **当前** |

## 应用脚本

`scripts/apply-patches.sh` 幂等应用全部补丁。

### 执行流程

1. **定位目标** — 解析 `$DSH_HOME/profiles/node_modules/@deepseek-ai/<pkg>` 的
   符号链接，找到物理副本(全机只有一份)
2. **版本匹配** — 读取包的 `package.json` 版本号，匹配
   `patches/<pkg>-<version>.patch`
3. **还原基准** — 若存在 `.pristine`(上次打过补丁)，先还原出原始文件，
   同时清掉旧补丁残留与 `.rej`(支持从任意旧代次升级到当前代次)
4. **备份原件** — 首次创建 `.pristine` 备份
5. **应用补丁** — `patch -s -d <pkg> -p1 --forward < patch`
6. **语法校验** — 对每个 `lib/*.js` 跑 `node --check`
7. **标记校验** — 确认当前代次独有标记已写入(否则视为未生效)
8. **错误回滚** — `trap ERR` 自动从 `.pristine` 还原

### 输出示例

```
  → 应用 dsh-api-gateway@0.1.5-rc.2 补丁…
  ✓ dsh-api-gateway@0.1.5-rc.2 补丁已应用
  → 应用 dsh-client-connection@0.1.5-rc.2 补丁…
  ✓ dsh-client-connection@0.1.5-rc.2 补丁已应用
✓ 全部补丁应用完成 —— 重启 dsh 后生效
```

## 维护

### dsh 升级后

1. 检查 `dsh-api-gateway` 与 `dsh-client-connection` 版本是否变化
2. 运行 `bash scripts/apply-patches.sh`(版本通配自动匹配)
3. 若报 `✗ 没有对应版本的补丁` 或产生 `.rej`，需手动 rebase
4. 重启 dsh：`pm2 restart dsh-web`

### Rebase 补丁

```bash
# 1. 找到新的原件位置
TARGET=$(readlink -f $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-api-gateway)
NEW_VERSION=$(node -p "require('$TARGET/package.json').version")

# 2. 备份原件
cp $TARGET/lib/index.js $TARGET/lib/index.js.orig

# 3. 手动按 patches/ 下的补丁内容修改

# 4. 生成新补丁
diff -u $TARGET/lib/index.js.orig $TARGET/lib/index.js \
  | tail -n +3 \
  > patches/dsh-api-gateway-$NEW_VERSION.patch

# 5. 还原原件(让 apply-patches.sh 重新应用)
cp $TARGET/lib/index.js.orig $TARGET/lib/index.js

# 6. 测试应用
bash scripts/apply-patches.sh
```

### 回滚

```bash
TARGET=$(readlink -f $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-api-gateway)
cp $TARGET/lib/index.js.pristine $TARGET/lib/index.js
# dsh-client-connection 同理
pm2 restart dsh-web
```