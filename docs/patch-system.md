# 补丁系统

> [!NOTE]
> 本文档由 AI 生成,可能存在错误或遗漏,使用前请 review 并实测。

## 为什么需要补丁

dsh 的 `dsh-client-connection` 包负责 WebSocket 事件帧的下行分发（pump 循环）和
客户端 `isLoopback` 判定。这两个关键点没有提供插件钩子，必须通过源码级补丁实现：

- **事件帧过滤** — 在 pump 循环中注入 `filterFrame` 调用，实现未授权会话零帧泄漏
- **域名入口管理放行** — 在 `isLoopback` 判定后追加 `/tenancy/whoami` 同步请求，
  让管理员经域名可用配置面

## 补丁文件

```
patches/
└── dsh-client-connection-<version>.patch   # 组合补丁
```

补丁按 dsh 的 `client-connection` 版本号命名。升级 dsh 后需检查是否需要 rebase。

## 应用脚本

`scripts/apply-patches.sh` 幂等应用全部补丁。

### 执行流程

1. **定位目标** — 解析 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-connection` 的符号链接，找到物理副本
2. **版本匹配** — 读取包的 `package.json` 版本号，匹配 `patches/dsh-client-connection-<version>.patch`
3. **幂等检查** — 检测补丁是否已应用，已应用则直接退出
4. **备份原件** — 创建 `.pristine` 备份
5. **拆分应用** — 用 `awk` 从组合补丁中拆出单文件段，分别 `patch -s` 应用
6. **语法校验** — `node --check` 验证两个文件
7. **错误回滚** — `trap ERR` 自动从 `.pristine` 还原

### 输出示例

```
  ✓ 事件帧过滤 → /path/to/lib/index.js
  ✓ 域名入口放行 → /path/to/lib/client.js
✓ 补丁已应用(0.1.1-rc.2) —— 重启 dsh 后生效; 卸载 = cp .pristine 回去
```

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