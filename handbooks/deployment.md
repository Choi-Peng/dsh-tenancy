# 部署手册

> [!NOTE]
> 本文档由 AI 生成,可能存在错误或遗漏,使用前请 review 并实测。

本手册提供从零部署 DSH 多租户环境的完整步骤。大多数场景可直接使用一键脚本。

## 前置条件

| 项 | 要求 |
|---|---|
| 已有 | nginx 占 443 且有可用证书的站点 |
| 端口空闲 | `127.0.0.1:9091`(Authelia)、`127.0.0.1:9443`(Caddy)，均只绑回环 |
| DNS/证书 | 不需要新增，复用现有域名与证书 |
| 网络 | 能访问 GitHub（国内超时时用镜像 `https://ghproxy.net/`） |
| Node.js | >= 20 |

> 版本参考：Authelia v4.39.20、Caddy v2.11.4

---

## 一键部署

```bash
sudo bash install.sh --domain dsh.example.com
# 可选参数:
#   --admin-user <name>          管理员用户名（默认 admin）
#   --admin-password <pass>      管理员密码（默认随机生成）
#   --github-proxy <url>         GitHub 镜像前缀
```

脚本自动完成：
1. 下载 Authelia 和 Caddy 二进制
2. 创建服务账号（`authelia`、`caddy`）
3. 生成随机密钥和口令
4. 部署配置文件
5. 创建管理员账号
6. 启动 systemd 服务
7. 保存凭据至 `/root/dsh-p0-credentials/admin.txt`

完成后继续「插件安装」章节。

---

## 手动部署

一键脚本不适用时（如已有 Authelia 实例、自定义路径等），按以下步骤手动部署。

### 1. 安装二进制

```bash
M=https://ghproxy.net/   # GitHub 直连可用时置空
cd /tmp

# Authelia
curl -sSL --retry 3 -o authelia.tgz \
  "${M}https://github.com/authelia/authelia/releases/download/v4.39.20/authelia-v4.39.20-linux-amd64.tar.gz"
mkdir -p /opt/authelia /tmp/authelia-pkg && tar -xzf authelia.tgz -C /tmp/authelia-pkg
install -m755 /tmp/authelia-pkg/authelia /opt/authelia/authelia

# Caddy
curl -sSL --retry 3 -o caddy.tgz \
  "${M}https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_amd64.tar.gz"
mkdir -p /tmp/caddy-extract && tar -xzf caddy.tgz -C /tmp/caddy-extract
install -m755 /tmp/caddy-extract/caddy /usr/local/bin/caddy

# 服务账号
useradd -r -s /usr/sbin/nologin -d /var/lib/authelia authelia
useradd -r -s /usr/sbin/nologin -d /var/lib/caddy caddy
mkdir -p /etc/authelia /var/lib/authelia /etc/caddy
```

### 2. 部署 Authelia

```bash
# 生成三个随机密钥
openssl rand -hex 32   # → session.secret
openssl rand -hex 32   # → storage.encryption_key
openssl rand -hex 32   # → identity_validation.reset_password.jwt_secret
```

1. 复制 [`examples/authelia/configuration.yml`](../examples/authelia/configuration.yml) 到 `/etc/authelia/configuration.yml`，填入三个密钥
2. 复制 [`examples/authelia/users.yml`](../examples/authelia/users.yml) 到 `/etc/authelia/users.yml`，生成管理员口令哈希：

   ```bash
   /opt/authelia/authelia crypto hash generate argon2 --password '你的密码'
   # 将输出的 $argon2id$... 替换 users.yml 中的占位
   ```

3. 校验并启动：

   ```bash
   chown -R authelia:authelia /etc/authelia /var/lib/authelia
   /opt/authelia/authelia validate-config --config /etc/authelia/configuration.yml
   cp examples/systemd/authelia.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now authelia
   curl -s http://127.0.0.1:9091/auth/api/health   # 期望 {"status":"OK"}
   ```

**Authelia v4.39 关键点**：
- 子路径挂载写进 `server.address: 'tcp://127.0.0.1:9091/auth'`（旧 `server.path` 已废弃）
- 访问控制规则**顺序敏感**：admins 放行 → 同路径显式 deny → team 放行其余。
  **缺少 deny 规则会导致非管理员穿透**
- 启用邀请码注册时必须有 `authentication_backend.file.watch: true`（模板已含），
  否则追加进 `users.yml` 的新用户不会热重载 —— 注册返回成功但登录必败
- 二因素（`policy: two_factor`）**不依赖邮件**：可选方法只有 TOTP / WebAuthn / Duo，
  注册在门户完成、密钥加密存进 SQLite；模板已给 `totp.issuer` 并启用 `webauthn`。
  前提是服务器时钟准确（`timedatectl show-timesync --property=NTPSynchronized`）。
  注：规则里的 `methods:` 是 HTTP 方法过滤器，不是认证方式白名单（写错会被
  `validate-config` 直接拒）
- **dsh ≥ 0.1.2 必配 `server.buffers.read: 16384`（模板已含）**：0.1.2 的
  client-modules 把启动期插件打成「组合 bundle」地址
  `/plugins/??<模块列表>&rev=<rev>`（单批可达 ~2.2KB）。经 Caddy
  `forward_auth` 时该 query 会原样附加到 Authelia 鉴权子请求（请求头
  `X-Forwarded-URI` 同样携带全长 URL），请求行+请求头超过 Authelia 默认 4096B
  读缓冲 → **431 "small read buffer"** → 浏览器登录后首屏报 `Failed to load
  plugins` / `bundle script /plugins/??… failed to load`。SSH 隧道直连不经
  Authelia 所以正常，公网域名必现；`configuration.yml` 不热重载，改后必须
  `systemctl restart authelia`（nginx / Caddy / dsh 均无需改动）
- 权限：`configuration.yml`（含三个密钥）`600`、`users.yml`（含哈希/邮箱）`o-r`；
  收权前先确认 dsh 进程跑在哪个用户下（见 `operations.md`「确认 dsh 进程用户」），
  root 恒可写；非 root 用户需 `chmod g+w users.yml` + `usermod -aG authelia <dsh用户>`
  并**完全重启该服务**（补充组只在进程启动时读取）；加组结果可用
  `groups authelia` 复核

### 3. 部署 Caddy

```bash
# 生成共享密钥
echo "DSH_TENANCY_SECRET=$(openssl rand -hex 32)" > /etc/caddy/dsh.env
chmod 640 /etc/caddy/dsh.env && chown -R caddy:caddy /etc/caddy
```

1. 复制 [`examples/Caddyfile`](../examples/Caddyfile) 到 `/etc/caddy/Caddyfile`，替换域名
2. 校验并启动：

   ```bash
   /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile
   cp examples/systemd/caddy-dsh.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now caddy-dsh
   ```

3. 冒烟测试：

   ```bash
   curl -s -o /dev/null -D - -H "Host: dsh.example.com" -H "X-Forwarded-Proto: https" \
     http://127.0.0.1:9443/api/host.describe | head -1    # 期望 HTTP/1.1 302 Found
   ```

### 4. 接入 nginx

参照 [`examples/nginx/dsh.example.com.conf`](../examples/nginx/dsh.example.com.conf) 修改你的 dsh vhost，关键配置：

- `proxy_pass` 指向 Caddy `127.0.0.1:9443`
- `/auth/` 路径指向 Authelia `127.0.0.1:9091`
- `sub_filter` 向 Authelia 登录页注入「邀请码注册」入口
- 传递 `X-Forwarded-Proto: https`
- **WebSocket 升级 location**（必须，否则 dsh 与 better-sidebar 的 WS 握手失败）：

  ```nginx
  # dsh 事件流
  location /api/events.mux  { proxy_pass http://127.0.0.1:9443; proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
    proxy_set_header Host $host; proxy_read_timeout 86400s; }
  location /api/events.host { proxy_pass http://127.0.0.1:9443; proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
    proxy_set_header Host $host; proxy_read_timeout 86400s; }

  # dsh ≥ 0.1.2 api-gateway 主 RPC WS：typert 全量 Remote(会话/模型目录/对话)都走它。
  # 缺这一块 = 页面能渲染但一直「连接异常」、会话模型无法加载(见故障排查)。
  location /api/remote.mux { proxy_pass http://127.0.0.1:9443; proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
    proxy_set_header Host $host; proxy_read_timeout 86400s; }

  # better-sidebar 终端 WS（缺这一块会报 WebSocket …/sidebar/ws/agent-terminals failed）
  location ^~ /sidebar/ws/ { proxy_pass http://127.0.0.1:9443; proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
    proxy_set_header Host $host; proxy_read_timeout 86400s; }
  ```

- **公开站点（可选，P11）**：若要让 `pub.example.com/<user>/<projectName>` 公开
  成员构建产物，在 `examples/nginx/dsh.example.com.conf` 内新增一个公开站点
  server 块（`server_name` 换成你的公开域名），把该域名转发到 `127.0.0.1:3089`
  （dsh-tenancy 的匿名静态发布端口，不走 Caddy/Authelia）——参照该文件末尾的
  示例块，并配置插件 `publicSitesHosts`。
- **⚠ 勿把两段路径正则内联进 dsh vhost**：公开站点 URL 形如两段路径
  `/user/project`。若不按示例用独立 server 块，而是在 dsh vhost 里用
  `location ~ ^/[A-Za-z0-9_-]+/[^/]+…` 之类正则分流到 3089，**dsh 插件自己的
  两段路由也会被劫持**（如 `/deepseek-balance/settings`、`/footer-order/settings`、
  `/plugins/<id>/client.js`——浏览器侧余额读数、插件设置卡片、客户端 bundle 全部
  失效）。确实要内联时，必须为每个插件路由前缀加 `^~` 前缀豁免（`^~` 优先于
  正则），把它们仍转发回 Caddy `127.0.0.1:9443`。
- **⚠ 豁免 location 必须写成不带尾斜杠的形式**（`location ^~ /deepseek-balance {…}`）：
  nginx 对「以斜杠结尾的 prefix location + proxy_pass」有固有行为——请求 URI
  恰好等于该前缀但缺尾斜杠时，nginx 直接回 301 补斜杠。写成
  `location ^~ /deepseek-balance/` 会把插件本体的 `GET /deepseek-balance`
  301 到 `/deepseek-balance/`（dsh-web 对带斜杠变体 404），单段路由照样全灭；
  不带尾斜杠的前缀同时覆盖裸路径与子路径，且不触发该 301。

### 5. dsh 侧确认

确保 dsh 启动参数包含 `--trusted-host <你的域名>`。无需重启（除非改过参数）。

---

## 插件安装

### 1. 安装插件

```bash
dsh plugin --profile web add github:choi-peng/dsh-tenancy
```

### 2. 配置 sharedSecret

编辑 profile 的 `cordis.patch.yml`，将 `sharedSecret` 设为与 `/etc/caddy/dsh.env` 的 `DSH_TENANCY_SECRET` 相同的值：

```yaml
- id: tenancy
  name: '@choi-peng/dsh-tenancy'
  config:
    sharedSecret: '与 /etc/caddy/dsh.env 中 DSH_TENANCY_SECRET 同值'
```

> 该值非空后，**未带 `X-Dsh-Tenancy-Key` 的请求一律 401**（不再回落 local 管理员），
> SSH 隧道直连 `127.0.0.1:3088` 需自行补上该头。留空仅限可信内网调试，
> 且插件启动时会打 WARN（空密钥 + `localIsAdmin: true` = 本机任意进程可得 admin）。

核对配置：

```bash
dsh --profile web --dump-config | grep sharedSecret
```

### 2b. 配置 trustedHosts（围栏判定用）

影子路由自己有一道 browser-trust 围栏（Host 必须是 loopback 或本列表条目、Origin
同源、`sec-fetch-site` 非 cross-site）。经 Caddy 的常规流量 Host 被固定为公网域名，
所以**必须把域名声明进来**，否则 `/register` 与域名直入的 `/tenancy/*` 全被 403：

```yaml
    trustedHosts:
      - 'dsh.example.com'
```

验收（应看到 `untrusted request origin` 而不是页正常返回）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3088/register/ -H 'Host: attacker.example'
# 期望 403
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3088/register/ -H "Host: dsh.example.com"
# 期望 200
```

### 3. 应用补丁

```bash
bash scripts/apply-patches.sh && pm2 restart dsh-web
```

### 4. 验证

浏览器打开 `https://dsh.example.com`，应跳转 Authelia 登录页。登录后正常使用。

---

## 首次登录

1. 浏览器打开 `https://dsh.example.com`
2. 跳转 Authelia 门户，使用管理员账号登录
3. 按引导注册 TOTP（二因素认证必需）
4. 回到 dsh 页面，正常使用

---

## 常见问题

| 问题 | 排查 |
|---|---|
| 安装脚本报错 | 检查网络连通性、端口是否被占用 |
| Authelia 启动失败 | 运行 `authelia validate-config` 检查配置 |
| Caddy 启动失败 | 运行 `caddy validate` 检查 Caddyfile |
| 登录后跳不回 dsh | 检查 nginx 的 `proxy_set_header Host` 是否正确 |
| 浏览器报 `WebSocket …/sidebar/ws/agent-terminals failed` | nginx 缺 `/sidebar/ws/` 升级 location（见「接入 nginx」） |
| 插件两段路由 404/行为异常（如 deepseek-balance 侧栏余额不显示、`/deepseek-balance/settings` 或 `/footer-order/settings` 打不开） | 若把公开站点的两段正则 `location ~ ^/[^/]+/[^/]+…` 内联进了 dsh vhost，插件自身的两段路径会被劫持到 3089。为每个插件路由前缀加 `^~` 豁免回 Caddy（`/plugins/`、`/deepseek-balance`、`/footer-order` 等，见「接入 nginx」）；**豁免前缀勿带尾斜杠**（`^~ /deepseek-balance/` 会把本体 `GET /deepseek-balance` 301 到带斜杠变体 → 404，读数照样全灭） |
| 设置页报 `settings are unavailable in this browser` | 经域名访问且非 admin：dsh 配置面仅限回环/补丁放行；管理员需已应用补丁 |
| 插件不生效 | 确认 `sharedSecret` 一致、补丁已应用、dsh 已重启 |

详细故障排查见 [README](../README.md#故障排查)。
