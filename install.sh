#!/usr/bin/env bash
# install.sh — DSH 多租户认证前端一键部署脚本
# 用法: sudo bash install.sh [--domain dsh.example.com] [--skip-binaries]
set -euo pipefail

# ──────────────────────────────────────────────
# 颜色与工具函数
# ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

need_root() { [[ $EUID -eq 0 ]] || fail "请使用 root 或 sudo 运行此脚本"; }

# ──────────────────────────────────────────────
# 参数解析
# ──────────────────────────────────────────────
DOMAIN=""
SKIP_BINARIES=false
CRED_DIR="${DSH_HOME:-${HOME}/.dsh}/bootstrap-credentials"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GITHUB_PROXY="${GITHUB_PROXY:-}"  # 国内设 https://ghproxy.net/
ADMIN_USER="admin"
ADMIN_PASSWORD=""
ADMIN_EMAIL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)          DOMAIN="$2"; shift 2 ;;
    --skip-binaries)   SKIP_BINARIES=true; shift ;;
    --github-proxy)    GITHUB_PROXY="$2"; shift 2 ;;
    --admin-user)      ADMIN_USER="$2"; shift 2 ;;
    --admin-password)  ADMIN_PASSWORD="$2"; shift 2 ;;
    --admin-email)     ADMIN_EMAIL="$2"; shift 2 ;;
    -h|--help)
      echo "用法: sudo bash install.sh --domain <domain> [选项]"
      echo ""
      echo "必填:"
      echo "  --domain <domain>         部署域名 (如 dsh.example.com)"
      echo ""
      echo "可选:"
      echo "  --admin-user <name>       管理员用户名 (默认 admin)"
      echo "  --admin-password <pass>   管理员密码 (不指定则随机生成)"
      echo "  --admin-email <email>     管理员邮箱 (默认 <用户名>@<域名>)"
      echo "  --skip-binaries           跳过下载 Authelia/Caddy 二进制"
      echo "  --github-proxy <url>      GitHub 镜像前缀 (如 https://ghproxy.net/)"
      exit 0 ;;
    *) fail "未知参数: $1" ;;
  esac
done

[[ -n "$DOMAIN" ]] || fail "必须指定 --domain, 用法: bash install.sh --domain <domain>"

if [[ -n "$ADMIN_PASSWORD" ]]; then
  warn "--admin-password 会留在 shell history 与进程列表中, 更安全的做法是不传该参数由脚本随机生成"
fi

# 未指定密码则随机生成
if [[ -z "$ADMIN_PASSWORD" ]]; then
  ADMIN_PASSWORD="$(openssl rand -base64 16 | tr -dc 'A-Za-z0-9' | head -c 16)"
  _auto_gen_pass=true
else
  _auto_gen_pass=false
fi

# 未指定邮箱则默认 <用户名>@<域名>
if [[ -z "$ADMIN_EMAIL" ]]; then
  ADMIN_EMAIL="${ADMIN_USER}@${DOMAIN}"
fi

need_root

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  DSH 多租户认证前端 — 一键部署${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
echo ""
info "域名: ${DOMAIN}"
info "管理员: ${ADMIN_USER}"
if $_auto_gen_pass; then
  info "密码: <随机生成, 完成后查看 ${CRED_DIR}/admin.txt>"
else
  info "密码: <用户指定>"
fi
info "GitHub 代理: ${GITHUB_PROXY:-<直连>}"
echo ""

# ──────────────────────────────────────────────
# 版本常量
# ──────────────────────────────────────────────
AUTHELIA_VER="4.39.20"
CADDY_VER="2.11.4"
PLUGIN_SPEC="${DSH_TENANCY_PLUGIN:-github:Choi-Peng/dsh-tenancy}"

# ──────────────────────────────────────────────
# 第 1 步: 安装二进制
# ──────────────────────────────────────────────
install_binaries() {
  if $SKIP_BINARIES; then
    info "跳过二进制下载 (--skip-binaries)"
    return 0
  fi

  info "第 1 步: 安装 Authelia v${AUTHELIA_VER} 与 Caddy v${CADDY_VER}"

  # --- Authelia ---
  # 查找顺序: ① 已安装二进制 → ② 仓库内 authelia.tgz → ③ /tmp 缓存 → ④ 下载
  local authelia_local_tgz="${SCRIPT_DIR}/authelia.tgz"
  local authelia_cache_tgz="/tmp/authelia-v${AUTHELIA_VER}-linux-amd64.tar.gz"
  local authelia_src_tgz=""   # 最终使用的压缩包路径
  local authelia_pkg="/tmp/authelia-pkg-v${AUTHELIA_VER}"

  if [[ -x /opt/authelia/authelia ]]; then
    local cur_ver
    cur_ver="$(/opt/authelia/authelia --version 2>&1 | head -1)"
    if echo "$cur_ver" | grep -qF "$AUTHELIA_VER"; then
      ok "Authelia 已安装且版本匹配: $cur_ver"
    else
      warn "Authelia 版本不匹配 ($cur_ver), 需要 v${AUTHELIA_VER}, 将重新安装"
      rm -f /opt/authelia/authelia
    fi
  fi

  if [[ ! -x /opt/authelia/authelia ]]; then
    # ② 检查仓库内自带的压缩包
    if [[ -f "$authelia_local_tgz" ]] && [[ -s "$authelia_local_tgz" ]] && gzip -t "$authelia_local_tgz" 2>/dev/null; then
      ok "使用仓库内 Authelia 压缩包: $authelia_local_tgz ($(du -h "$authelia_local_tgz" | cut -f1))"
      authelia_src_tgz="$authelia_local_tgz"
    elif [[ -f "$authelia_local_tgz" ]]; then
      warn "仓库内 Authelia 压缩包不完整或损坏: $authelia_local_tgz"
    fi

    # ③ 检查 /tmp 缓存
    if [[ -z "$authelia_src_tgz" && -f "$authelia_cache_tgz" ]]; then
      if [[ -s "$authelia_cache_tgz" ]] && gzip -t "$authelia_cache_tgz" 2>/dev/null; then
        ok "使用缓存 Authelia 压缩包: $authelia_cache_tgz ($(du -h "$authelia_cache_tgz" | cut -f1))"
        authelia_src_tgz="$authelia_cache_tgz"
      else
        warn "缓存 Authelia 压缩包不完整或损坏, 删除"
        rm -f "$authelia_cache_tgz"
      fi
    fi

    # ④ 下载
    if [[ -z "$authelia_src_tgz" ]]; then
      info "下载 Authelia v${AUTHELIA_VER} ..."
      local authelia_url="${GITHUB_PROXY}https://github.com/authelia/authelia/releases/download/v${AUTHELIA_VER}/authelia-v${AUTHELIA_VER}-linux-amd64.tar.gz"
      curl -sSL --retry 3 -o "$authelia_cache_tgz" "$authelia_url"
      if [[ ! -s "$authelia_cache_tgz" ]] || ! gzip -t "$authelia_cache_tgz" 2>/dev/null; then
        rm -f "$authelia_cache_tgz"
        fail "Authelia 下载失败或文件不完整"
      fi
      authelia_src_tgz="$authelia_cache_tgz"
      ok "Authelia 下载完成: $(du -h "$authelia_cache_tgz" | cut -f1)"
    fi

    mkdir -p /opt/authelia "$authelia_pkg"
    tar -xzf "$authelia_src_tgz" -C "$authelia_pkg"
    install -m755 "${authelia_pkg}/authelia" /opt/authelia/authelia
    rm -rf "$authelia_pkg"
    ok "Authelia 已安装: $(/opt/authelia/authelia --version 2>&1 | head -1)"
  fi

  # --- Caddy ---
  # 查找顺序: ① 已安装二进制 → ② 仓库内 caddy.tgz → ③ /tmp 缓存 → ④ 下载
  local caddy_local_tgz="${SCRIPT_DIR}/caddy.tgz"
  local caddy_cache_tgz="/tmp/caddy_${CADDY_VER}_linux_amd64.tar.gz"
  local caddy_src_tgz=""
  local caddy_extract="/tmp/caddy-extract-v${CADDY_VER}"

  if [[ -x /usr/local/bin/caddy ]]; then
    local cur_caddy
    cur_caddy="$(/usr/local/bin/caddy version 2>&1)"
    if echo "$cur_caddy" | grep -qF "$CADDY_VER"; then
      ok "Caddy 已安装且版本匹配: $cur_caddy"
    else
      warn "Caddy 版本不匹配 ($cur_caddy), 需要 v${CADDY_VER}, 将重新安装"
      rm -f /usr/local/bin/caddy
    fi
  fi

  if [[ ! -x /usr/local/bin/caddy ]]; then
    # ② 检查仓库内自带的压缩包
    if [[ -f "$caddy_local_tgz" ]] && [[ -s "$caddy_local_tgz" ]] && gzip -t "$caddy_local_tgz" 2>/dev/null; then
      ok "使用仓库内 Caddy 压缩包: $caddy_local_tgz ($(du -h "$caddy_local_tgz" | cut -f1))"
      caddy_src_tgz="$caddy_local_tgz"
    elif [[ -f "$caddy_local_tgz" ]]; then
      warn "仓库内 Caddy 压缩包不完整或损坏: $caddy_local_tgz"
    fi

    # ③ 检查 /tmp 缓存
    if [[ -z "$caddy_src_tgz" && -f "$caddy_cache_tgz" ]]; then
      if [[ -s "$caddy_cache_tgz" ]] && gzip -t "$caddy_cache_tgz" 2>/dev/null; then
        ok "使用缓存 Caddy 压缩包: $caddy_cache_tgz ($(du -h "$caddy_cache_tgz" | cut -f1))"
        caddy_src_tgz="$caddy_cache_tgz"
      else
        warn "缓存 Caddy 压缩包不完整或损坏, 删除"
        rm -f "$caddy_cache_tgz"
      fi
    fi

    # ④ 下载
    if [[ -z "$caddy_src_tgz" ]]; then
      info "下载 Caddy v${CADDY_VER} ..."
      local caddy_url="${GITHUB_PROXY}https://github.com/caddyserver/caddy/releases/download/v${CADDY_VER}/caddy_${CADDY_VER}_linux_amd64.tar.gz"
      curl -sSL --retry 3 -o "$caddy_cache_tgz" "$caddy_url"
      if [[ ! -s "$caddy_cache_tgz" ]] || ! gzip -t "$caddy_cache_tgz" 2>/dev/null; then
        rm -f "$caddy_cache_tgz"
        fail "Caddy 下载失败或文件不完整"
      fi
      caddy_src_tgz="$caddy_cache_tgz"
      ok "Caddy 下载完成: $(du -h "$caddy_cache_tgz" | cut -f1)"
    fi

    mkdir -p "$caddy_extract"
    tar -xzf "$caddy_src_tgz" -C "$caddy_extract"
    install -m755 "${caddy_extract}/caddy" /usr/local/bin/caddy
    rm -rf "$caddy_extract"
    ok "Caddy 已安装: $(/usr/local/bin/caddy version 2>&1)"
  fi

  # --- 服务账号 ---
  for acct in authelia caddy; do
    if id "$acct" &>/dev/null; then
      ok "用户 $acct 已存在"
    else
      useradd -r -s /usr/sbin/nologin -d "/var/lib/$acct" "$acct"
      ok "创建系统用户: $acct"
    fi
  done

  mkdir -p /etc/authelia /var/lib/authelia /etc/caddy
  ok "目录已就绪: /etc/authelia, /var/lib/authelia, /etc/caddy"
}

# ──────────────────────────────────────────────
# 第 2 步: 部署 Authelia
# ──────────────────────────────────────────────
deploy_authelia() {
  info "第 2 步: 部署 Authelia"

  local _changed=false   # 追踪配置是否有变更

  # 生成密钥(仅在配置文件不存在时)
  if [[ -f /etc/authelia/configuration.yml ]]; then
    ok "/etc/authelia/configuration.yml 已存在, 跳过密钥生成"
  else
    info "生成 Authelia 随机密钥 ..."
    # 模板占位符按出现顺序替换为三个独立的随机值:
    #   ① session.secret ② storage.encryption_key ③ identity_validation.reset_password.jwt_secret
    local tmp="/etc/authelia/configuration.yml.tmp"
    cp "${SCRIPT_DIR}/examples/authelia/configuration.yml" "$tmp"
    local _i
    for _i in 1 2 3; do
      sed -i "0,/<openssl rand -hex 32>/{s|<openssl rand -hex 32>|$(openssl rand -hex 32)|}" "$tmp"
    done
    sed -i "s|dsh.example.com|${DOMAIN}|g" "$tmp"
    mv "$tmp" /etc/authelia/configuration.yml
    _changed=true
    ok "已写入 /etc/authelia/configuration.yml (三个密钥独立随机)"
  fi

  # users.yml — 三种模式: create=全新 / rewrite=含占位符重写 / append=仅追加管理员(保留现有成员!)
  local _mode="skip"
  if [[ ! -f /etc/authelia/users.yml ]]; then
    _mode="create"
  elif grep -q '<替换' /etc/authelia/users.yml; then
    _mode="rewrite"
    info "users.yml 含占位符, 将重新生成"
  elif ! grep -q "^  ${ADMIN_USER}:" /etc/authelia/users.yml; then
    _mode="append"
    info "users.yml 已存在但无 ${ADMIN_USER}, 将仅追加管理员(保留现有成员)"
  else
    ok "users.yml 已包含 ${ADMIN_USER}, 跳过"
  fi

  if [[ "$_mode" != "skip" ]]; then
    info "生成管理员 (${ADMIN_USER}) 密码哈希 ..."
    local pass_hash
    pass_hash="$(/opt/authelia/authelia crypto hash generate argon2 --password "$ADMIN_PASSWORD" 2>/dev/null | grep -oP '\$argon2.*')"
    if [[ -z "$pass_hash" || "$pass_hash" != \$argon2* ]]; then
      fail "密码哈希生成失败"
    fi

    # 管理员条目(append 模式只追加这一块, 绝不重写整个文件)
    local block
    block="$(printf '  %s:\n    disabled: false\n    displayname: "%s"\n    password: "%s"\n    email: %s\n    groups:\n      - dsh-team\n      - dsh-admins\n' \
      "$ADMIN_USER" "$ADMIN_USER" "$pass_hash" "$ADMIN_EMAIL")"

    if [[ "$_mode" == "append" ]]; then
      { echo ""; echo "$block"; } >> /etc/authelia/users.yml
    else
      cat > /etc/authelia/users.yml <<USERSEOF
# Authelia 用户库 — 由 install.sh 自动生成
# 修改后执行: systemctl restart authelia
users:
$block
  # 新成员模板: 只加 dsh-team 组即可
  # alice:
  #   disabled: false
  #   displayname: "Alice"
  #   password: "\$argon2id\$..."
  #   groups:
  #     - dsh-team
USERSEOF
    fi
    _changed=true
    ok "已写入 /etc/authelia/users.yml ($_mode)"

    # 保存初始凭据
    local cred_dir="${CRED_DIR}"
    mkdir -p "$cred_dir"
    chmod 700 "$cred_dir"
    cat > "${cred_dir}/admin.txt" <<CREDEOF
# DSH 初始管理员凭据 — 由 install.sh 生成于 $(date -Iseconds)
# 登录后请尽快修改密码
username: ${ADMIN_USER}
password: ${ADMIN_PASSWORD}
email:    ${ADMIN_EMAIL}
domain:   ${DOMAIN}
url:      https://${DOMAIN}
CREDEOF
    chmod 600 "${cred_dir}/admin.txt"

    if $_auto_gen_pass; then
      ok "密码已随机生成, 凭据已保存至 ${cred_dir}/admin.txt (仅 root 可读)"
    else
      ok "凭据已保存至 ${cred_dir}/admin.txt"
    fi
  fi

  # systemd: 比较后再覆盖, 有差异才标记变更
  if ! cmp -s "${SCRIPT_DIR}/examples/systemd/authelia.service" /etc/systemd/system/authelia.service; then
    cp "${SCRIPT_DIR}/examples/systemd/authelia.service" /etc/systemd/system/authelia.service
    _changed=true
    ok "已安装 authelia.service"
  else
    ok "authelia.service 无变化, 跳过"
  fi

  chown -R authelia:authelia /etc/authelia /var/lib/authelia

  # 校验(失败即中止, 绝不带病重启)
  if /opt/authelia/authelia validate-config --config /etc/authelia/configuration.yml >/dev/null 2>&1; then
    ok "Authelia 配置校验通过"
  else
    fail "Authelia 配置校验失败, 已中止(服务未被触碰)。检查: /opt/authelia/authelia validate-config --config /etc/authelia/configuration.yml"
  fi

  systemctl daemon-reload

  # 配置有变更且服务已在运行 → restart; 否则 enable --now
  if $_changed && systemctl is-active --quiet authelia; then
    systemctl restart authelia
    ok "Authelia 配置已更新, 服务已重启"
  else
    systemctl enable --now authelia
    ok "Authelia 服务已启动"
  fi

  # 健康检查
  sleep 1
  if curl -sf http://127.0.0.1:9091/auth/api/health >/dev/null 2>&1; then
    ok "Authelia 健康检查通过"
  else
    warn "Authelia 健康检查未通过, 请检查: journalctl -u authelia"
  fi
}

# ──────────────────────────────────────────────
# 第 3 步: 部署 Caddy
# ──────────────────────────────────────────────
deploy_caddy() {
  info "第 3 步: 部署 Caddy"

  local _changed=false

  # 共享密钥
  if [[ -f /etc/caddy/dsh.env ]]; then
    ok "/etc/caddy/dsh.env 已存在, 跳过密钥生成"
  else
    local secret
    secret="$(openssl rand -hex 32)"
    echo "DSH_TENANCY_SECRET=${secret}" > /etc/caddy/dsh.env
    _changed=true
    ok "已生成 /etc/caddy/dsh.env (DSH_TENANCY_SECRET)"
  fi
  chmod 640 /etc/caddy/dsh.env
  chown -R caddy:caddy /etc/caddy

  # Caddyfile
  if [[ -f /etc/caddy/Caddyfile ]]; then
    ok "/etc/caddy/Caddyfile 已存在, 跳过"
  else
    sed "s|dsh.example.com|${DOMAIN}|g" \
      "${SCRIPT_DIR}/examples/Caddyfile" > /etc/caddy/Caddyfile
    _changed=true
    ok "已写入 /etc/caddy/Caddyfile (域名: ${DOMAIN})"
  fi

  # systemd: 比较后再覆盖
  if ! cmp -s "${SCRIPT_DIR}/examples/systemd/caddy-dsh.service" /etc/systemd/system/caddy-dsh.service; then
    cp "${SCRIPT_DIR}/examples/systemd/caddy-dsh.service" /etc/systemd/system/caddy-dsh.service
    _changed=true
    ok "已安装 caddy-dsh.service"
  else
    ok "caddy-dsh.service 无变化, 跳过"
  fi

  # 校验(失败即中止, 绝不带病重启)
  if /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    ok "Caddy 配置校验通过"
  else
    fail "Caddy 配置校验失败, 已中止(服务未被触碰)。检查: caddy validate --config /etc/caddy/Caddyfile"
  fi

  systemctl daemon-reload

  # 配置有变更且服务已在运行 → restart; 否则 enable --now
  if $_changed && systemctl is-active --quiet caddy-dsh; then
    systemctl restart caddy-dsh
    ok "Caddy 配置已更新, 服务已重启"
  else
    systemctl enable --now caddy-dsh
    ok "Caddy 服务已启动"
  fi

  # 冒烟测试
  sleep 1
  local http_code
  http_code="$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Host: ${DOMAIN}" -H "X-Forwarded-Proto: https" \
    http://127.0.0.1:9443/api/host.describe 2>/dev/null || echo "000")"
  if [[ "$http_code" == "302" ]]; then
    ok "Caddy 冒烟测试通过 (HTTP ${http_code} → 跳门户)"
  else
    warn "Caddy 冒烟测试返回 HTTP ${http_code} (期望 302), 请检查"
  fi
}

# ──────────────────────────────────────────────
# 第 4 步: nginx 配置提示
# ──────────────────────────────────────────────
deploy_nginx_hint() {
  info "第 4 步: nginx 配置"

  local nginx_conf="/etc/nginx/conf.d/${DOMAIN}.conf"
  if [[ ! -f "$nginx_conf" ]]; then
    warn "未找到 ${nginx_conf}, 请合并 examples/nginx/ 下的站点配置:"
    warn ""
    warn "  cp ${SCRIPT_DIR}/examples/nginx/dsh.example.com.conf ${nginx_conf}"
    warn "  sed -i 's|dsh.example.com|${DOMAIN}|g' ${nginx_conf}"
    warn "  nginx -t && systemctl reload nginx"
    warn ""
    warn "关键: 所有 proxy location 必须带 X-Forwarded-Proto 等头,"
    warn "      否则 Authelia 会以 insecure scheme 拒绝 → 登录后静态资源 400 白屏"
    return 0
  fi

  # 内容检查: assets location 必须含转发头(缺了 = 登录后白屏, 实战踩过的坑)
  if awk '/location .*\/assets/,/^[[:space:]]*}/' "$nginx_conf" | grep -q 'X-Forwarded-Proto'; then
    ok "nginx 配置已存在且 assets 段含转发头"
  else
    warn "${nginx_conf} 已存在, 但 /assets/ location 缺少 X-Forwarded-Proto 等转发头!"
    warn "这会导致登录后 JS/CSS 全部 400、页面白屏。请对照 examples/nginx/ 补齐:"
    warn "  proxy_set_header X-Real-IP / X-Forwarded-For / X-Forwarded-Proto / X-Forwarded-Host"
  fi
}

# ──────────────────────────────────────────────
# 第 5 步: dsh 插件侧
# ──────────────────────────────────────────────
deploy_dsh_plugin() {
  info "第 5 步: DSH 插件安装"

  # 读取共享密钥
  local tenancy_secret=""
  if [[ -f /etc/caddy/dsh.env ]]; then
    tenancy_secret="$(grep -oP '(?<=DSH_TENANCY_SECRET=).*' /etc/caddy/dsh.env)"
  fi

  if ! command -v dsh &>/dev/null; then
    warn "dsh 命令不可用, 请先安装 dsh: npm install -g @deepseek-ai/dsh"
    return 0
  fi

  # 安装(remove+add 是可靠的覆盖/升级方式); 来源可用环境变量覆盖:
  #   DSH_TENANCY_PLUGIN="github:Choi-Peng/dsh-tenancy" 或本地路径等 pnpm 支持的规格
  local added=false
  dsh plugin --profile web remove @choi-p/dsh-tenancy >/dev/null 2>&1 || true
  info "安装来源: ${PLUGIN_SPEC}"
  if dsh plugin --profile web add "$PLUGIN_SPEC"; then
    added=true; ok "插件已安装 (${PLUGIN_SPEC})"
  else
    warn "插件安装失败 —— 请检查仓库可访问性, 或手动执行: dsh plugin --profile web add \"${PLUGIN_SPEC}\""
  fi
  $added || return 0

  # 写配置覆盖 —— 注意两点实战经验:
  #   ① `dsh plugin remove` 会剥离 cordis.patch.yml 中本插件的覆盖块, 所以必须在 add 之后写;
  #   ② patch 覆盖是整对象替换, 必须重述全部键, 不能只写 sharedSecret。
  if [[ -n "$tenancy_secret" ]]; then
    local patch_file="${HOME}/.dsh/profiles/web/cordis.patch.yml"
    touch "$patch_file"
    if ! grep -q 'id: tenancy' "$patch_file"; then
      cat >> "$patch_file" <<PATCH_EOF

- id: tenancy
  config:
    identityHeader: remote-user
    groupsHeader: remote-groups
    sharedSecret: '${tenancy_secret}'
    adminGroups:
      - dsh-admins
    localPrincipal: local
    localIsAdmin: true
    defaultAccess: private
    hideEmptyWorkspaces: true
    dbPath: ''
PATCH_EOF
      ok "已写入 tenancy 配置覆盖 (sharedSecret 已同步)"
    else
      ok "cordis.patch.yml 已含 tenancy 覆盖, 跳过"
    fi
  fi

  # 重启生效
  if command -v pm2 &>/dev/null && pm2 describe dsh-web >/dev/null 2>&1; then
    pm2 restart dsh-web >/dev/null && ok "dsh-web 已重启"
  else
    warn "请手动重启你的 dsh 服务使插件与配置生效"
  fi
}

# ──────────────────────────────────────────────
# 第 6 步: 验收清单
# ──────────────────────────────────────────────
run_checks() {
  info "第 6 步: 验收清单"
  echo ""

  local pass=0 total=0

  # ① Authelia 健康
  total=$((total + 1))
  if curl -sf http://127.0.0.1:9091/auth/api/health >/dev/null 2>&1; then
    ok "① Authelia 健康检查通过"
    pass=$((pass + 1))
  else
    warn "① Authelia 健康检查未通过"
  fi

  # ② Caddy 监听
  total=$((total + 1))
  if ss -tlnp | grep -q ':9443'; then
    ok "② Caddy 监听 :9443"
    pass=$((pass + 1))
  else
    warn "② Caddy 未监听 :9443"
  fi

  # ③ Caddy forward_auth 未认证 → 302
  total=$((total + 1))
  local code
  code="$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Host: ${DOMAIN}" -H "X-Forwarded-Proto: https" \
    http://127.0.0.1:9443/api/host.describe 2>/dev/null || echo "000")"
  if [[ "$code" == "302" ]]; then
    ok "③ 未认证请求 → HTTP 302 (跳转门户)"
    pass=$((pass + 1))
  else
    warn "③ 未认证请求 → HTTP ${code} (期望 302)"
  fi

  # ④ Authelia 监听 :9091
  total=$((total + 1))
  if ss -tlnp | grep -q ':9091'; then
    ok "④ Authelia 监听 :9091"
    pass=$((pass + 1))
  else
    warn "④ Authelia 未监听 :9091"
  fi

  echo ""
  echo -e "${CYAN}────────────────────────────────────────${NC}"
  echo -e "  验收结果: ${GREEN}${pass}${NC}/${total} 通过"
  echo -e "${CYAN}────────────────────────────────────────${NC}"

  if [[ $pass -eq $total ]]; then
    echo ""
    ok "全部检查通过! 部署完成。"
    echo ""
    info "后续步骤:"
    info "  1. 查看管理员凭据: cat ${CRED_DIR}/admin.txt"
    info "  2. 配置 nginx 反向代理 (见 examples/nginx/)"
    info "  3. 安装 dsh 插件: dsh plugin --profile web add @choi-p/dsh-tenancy"
    info "  4. 设置 cordis.patch.yml 中的 sharedSecret"
    if command -v pm2 &>/dev/null; then
      info "  5. pm2 restart dsh-web --update-env && pm2 save"
    else
      info "  5. 重启 dsh 服务使配置生效"
    fi
    info "  6. 浏览器打开 https://${DOMAIN} 验证完整流程"
  else
    echo ""
    warn "部分检查未通过, 请根据上述提示排查。"
    warn "常用诊断: journalctl -u authelia / journalctl -u caddy-dsh"
  fi
}

# ──────────────────────────────────────────────
# 主流程
# ──────────────────────────────────────────────
install_binaries
deploy_authelia
deploy_caddy
deploy_nginx_hint
# 插件还未发布, 跳过自动安装
# deploy_dsh_plugin
run_checks

echo ""
info "共享密钥文件: /etc/caddy/dsh.env"
info "Authelia 配置: /etc/authelia/configuration.yml"
info "Authelia 用户库: /etc/authelia/users.yml"
info "Caddy 配置: /etc/caddy/Caddyfile"
echo ""
ok "部署脚本执行完毕。"
