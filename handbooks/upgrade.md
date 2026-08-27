# 升级手册

> [!NOTE]
> 本文档由 AI 生成,可能存在错误或遗漏,使用前请 review 并实测。

本手册覆盖各类升级场景：dsh 升级、插件升级、Authelia/Caddy 升级、补丁 rebase。

---

## 升级前检查

### 1. 备份

```bash
# 备份 tenancy 数据
cp $DSH_HOME/tenancy/acl.json $DSH_HOME/tenancy/acl.json.bak
cp $DSH_HOME/tenancy/invites.json $DSH_HOME/tenancy/invites.json.bak
cp $DSH_HOME/tenancy/audit.log $DSH_HOME/tenancy/audit.log.bak

# 备份 Authelia 用户库
cp /etc/authelia/users.yml /etc/authelia/users.yml.bak
```

### 2. 记录当前版本

```bash
# dsh 版本
pm2 describe dsh-web | grep version

# client-connection 版本（补丁依赖此版本）
TARGET=$(readlink -f $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-connection)
node -p "require('$TARGET/package.json').version"

# Authelia / Caddy 版本
/opt/authelia/authelia --version
/usr/local/bin/caddy version
```

---

## dsh 升级

dsh 升级后，`client-connection` 可能被覆盖，补丁失效。需重新应用补丁。

### 步骤

```bash
# 1. 停止 dsh
pm2 stop dsh-web

# 2. 升级 dsh（按 dsh 官方文档）
# ...

# 3. 重新安装插件依赖
cd ~/.dsh/profiles/web && pnpm install

# 4. 检查 client-connection 版本
TARGET=$(readlink -f $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-connection)
NEW_VERSION=$(node -p "require('$TARGET/package.json').version")
echo "client-connection 版本: $NEW_VERSION"

# 5. 检查是否有对应版本的补丁
ls patches/dsh-client-connection-$NEW_VERSION.patch

# 6. 应用补丁
bash scripts/apply-patches.sh

# 7. 重启 dsh
pm2 restart dsh-web
```

### 补丁不匹配

若 `apply-patches.sh` 报 `补丁不匹配` 或产生 `.rej` 文件，说明上游代码已漂移，
需 rebase 补丁。见下方「补丁 Rebase」章节。

---

## 插件升级

```bash
# 1. 拉取新版本
cd /path/to/dsh-tenancy
git pull

# 2. 重新链接（link 方式）
cd ~/.dsh/profiles/web && pnpm install

# 3. 重启 dsh
pm2 restart dsh-web
```

若新版本的 `patches/` 有更新，升级 dsh 后需重跑 `bash scripts/apply-patches.sh`。

---

## Authelia 升级

### 步骤

```bash
# 1. 下载新版本
M=https://ghproxy.net/
curl -sSL --retry 3 -o /tmp/authelia.tgz \
  "${M}https://github.com/authelia/authelia/releases/download/v<NEW_VERSION>/authelia-v<NEW_VERSION>-linux-amd64.tar.gz"

# 2. 停止服务
systemctl stop authelia

# 3. 备份
cp /opt/authelia/authelia /opt/authelia/authelia.bak

# 4. 解压安装
mkdir -p /tmp/authelia-pkg && tar -xzf /tmp/authelia.tgz -C /tmp/authelia-pkg
install -m755 /tmp/authelia-pkg/authelia /opt/authelia/authelia

# 5. 校验配置
/opt/authelia/authelia validate-config --config /etc/authelia/configuration.yml

# 6. 启动
systemctl start authelia

# 7. 验证
curl -s http://127.0.0.1:9091/auth/api/health
```

### 注意事项

- Authelia v4.39 废弃了 `server.path`，改用 `server.address` 配置子路径
- 升级后检查 `configuration.yml` 是否有废弃字段
- 用户库格式通常不变，但建议备份

---

## Caddy 升级

### 步骤

```bash
# 1. 下载新版本
M=https://ghproxy.net/
curl -sSL --retry 3 -o /tmp/caddy.tgz \
  "${M}https://github.com/caddyserver/caddy/releases/download/v<NEW_VERSION>/caddy_<NEW_VERSION>_linux_amd64.tar.gz"

# 2. 停止服务
systemctl stop caddy-dsh

# 3. 备份
cp /usr/local/bin/caddy /usr/local/bin/caddy.bak

# 4. 解压安装
mkdir -p /tmp/caddy-extract && tar -xzf /tmp/caddy.tgz -C /tmp/caddy-extract
install -m755 /tmp/caddy-extract/caddy /usr/local/bin/caddy

# 5. 校验配置
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile

# 6. 启动
systemctl start caddy-dsh
```

---

## 补丁 Rebase

当 dsh 升级导致补丁应用失败时，需手动 rebase。

### 步骤

```bash
# 1. 定位新的原件
TARGET=$(readlink -f $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-connection)
NEW_VERSION=$(node -p "require('$TARGET/package.json').version")

# 2. 备份原件
cp $TARGET/lib/index.js $TARGET/lib/index.js.orig
cp $TARGET/lib/client.js $TARGET/lib/client.js.orig

# 3. 手动应用补丁到 index.js
#    编辑 $TARGET/lib/index.js，按 patches/ 下的补丁内容修改

# 4. 手动应用补丁到 client.js
#    编辑 $TARGET/lib/client.js，找到 isLoopback 判定行
#    在 isLoopbackHostname(pageLocation.hostname) 后追加 || (() => {...})()

# 5. 生成新补丁
(
  echo "--- a/lib/index.js"
  echo "+++ b/lib/index.js"
  diff -u $TARGET/lib/index.js.orig $TARGET/lib/index.js | tail -n +3
  
  echo "--- a/lib/client.js"
  echo "+++ b/lib/client.js"
  diff -u $TARGET/lib/client.js.orig $TARGET/lib/client.js | tail -n +3
) > patches/dsh-client-connection-$NEW_VERSION.patch

# 6. 还原原件（让 apply-patches.sh 重新应用）
cp $TARGET/lib/index.js.orig $TARGET/lib/index.js
cp $TARGET/lib/client.js.orig $TARGET/lib/client.js

# 7. 测试应用
bash scripts/apply-patches.sh

# 8. 重启 dsh
pm2 restart dsh-web
```

### 验证补丁

```bash
# 检查补丁
grep -q "__dshTenancy" $TARGET/lib/index.js && echo "index.js OK" || echo "index.js MISSING"
grep -q "dsh-tenancy" $TARGET/lib/client.js && echo "client.js OK" || echo "client.js MISSING"
```

---

## 回滚

### 回滚 dsh

```bash
# 1. 停止 dsh
pm2 stop dsh-web

# 2. 恢复旧版本（按 dsh 官方文档）

# 3. 重新应用补丁
bash scripts/apply-patches.sh

# 4. 重启
pm2 restart dsh-web
```

### 回滚补丁

```bash
TARGET=$(readlink -f $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-connection)
cp $TARGET/lib/index.js.pristine $TARGET/lib/index.js
cp $TARGET/lib/client.js.pristine $TARGET/lib/client.js
pm2 restart dsh-web
```

### 回滚插件

```bash
cd ~/.dsh/profiles/web
pnpm remove @choi-p/dsh-tenancy
pm2 restart dsh-web
```

---

## 升级检查清单

| 项目 | 检查命令 |
|---|---|
| Authelia 健康 | `curl -s http://127.0.0.1:9091/auth/api/health` |
| Caddy 配置 | `/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile` |
| nginx 配置 | `nginx -t`；`nginx -T \| grep -c '/sidebar/ws/'`（升级/迁移后确认 WS 升级块仍在） |
| dsh 运行 | `pm2 status dsh-web` |
| 补丁已应用 | `grep -q __dshTenancy $TARGET/lib/index.js` |
| 插件已加载 | `curl -b cookie https://dsh.example.com/tenancy/whoami` |
| 登录正常 | 浏览器打开 `https://dsh.example.com` |
| 成员隔离 | 成员只能看到自己的会话 |
| 管理员功能 | 管理员可访问设置→模型/插件，且插件 tab 可见「多租户」卡片 |
