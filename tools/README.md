# tools — 部署制品补丁说明

## authelia_register_link_patch.py

**作用**: 在 Authelia v4.39.20 二进制内嵌的登录表单 JS
(`public_html/static/js/portal.FirstFactorForm.*.js`) 中, 把「邀请码注册」入口
从 nginx sub_filter 悬浮按钮改为内置于表单:

- 位置: 「重置密码？」所在行, **左侧**为「邀请码注册」链接(指向 `/register`),
  右侧仍为「重置密码？」(行布局 `justify-content: space-between`);
- 文案与原悬浮按钮一致(「邀请码注册」), 样式沿用门户 Link 组件(下划线 hover)。

**原理**: Authelia 用 go:embed 把前端资源原样编进二进制, blob 指针/长度编译期固定,
只能做**等长原地替换**(脚本通过 `my`/`py` sx 简写与去掉默认
`flexDirection:row` 省出字节, 尾部空格回填)。
`server.asset_path` 仅支持覆盖 favicon/logo/locales, 覆盖不了 JS bundle,
故采用二进制补丁方案。

### 重新打补丁(升级 Authelia 后)

```bash
# 1. 取新版二进制对应的参考 bundle(hash 会变)
curl -s http://127.0.0.1:9091/auth/static/js/portal.FirstFactorForm.<hash>.js -o /tmp/ref.js
node --check /tmp/ref.js   # 确认仍是同构 v4.39 布局

# 2. 打补丁(若前端重构导致锚点不匹配, 需按新 bundle 更新脚本内锚点)
python3 tools/authelia_register_link_patch.py <新版authelia> /tmp/ref.js /tmp/authelia.patched

# 3. 校验 + 替换 + 重启
python3 -c "d=open('/tmp/authelia.patched','rb').read(); assert d.count(b'register-link')==1"
systemctl stop authelia && install -m755 /tmp/authelia.patched /opt/authelia/authelia && systemctl start authelia
```

### 回滚

- 安装备份: `/opt/authelia/authelia.bak-20260826152827`(补丁前原始 v4.39.20);
- 或重装官方 v4.39.20 后, 恢复 nginx 悬浮按钮注入
  (见 git 历史中 `/etc/nginx/conf.d/dsh.choi-p.site.conf` 的 sub_filter 段)。

### 当前状态 (2026-08-26)

- `/opt/authelia/authelia` = 补丁后二进制(sha256 前 16 位 `dc3cfd77705961da`);
- 本目录 `../authelia.tgz` 已同步为补丁后制品;
- nginx `/auth/` location 的悬浮按钮 sub_filter 注入已移除。

## check-privileged-sync.py

**作用**: 核对**特权方法清单的三处同步** —— 核心 `dsh-client-connection` 里的
`PRIVILEGED_METHODS`、`Caddyfile` 的 `@adminapi path_regexp`、`Authelia configuration.yml`
的两条 `resources` 正则。

**为何需要**: 特权方法不被本插件影子接管,只靠「Caddy 对这些路径把 Host 重写为
localhost」+「Authelia 只放 admins 组进这些路径」两道配置保护。三份清单各自维护,
核心升级新增特权方法而另两处未跟 = 该方法在团队入口被当普通方法放行。

```bash
python3 tools/check-privileged-sync.py                       # 开发仓库内直接跑（默认 examples/*）
python3 tools/check-privileged-sync.py \                     # 部署机
  --core-file "$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js" \
  --caddyfile /etc/caddy/Caddyfile --authelia /etc/authelia/configuration.yml
# 退出码 0=一致, 1=漂移（打印缺失/多余的方法名）
```

实现只解析本项目正则的实际形状(字面量 + `\.` + 最多两层分组),命名空间整体授权
(`settings\.`)展开为 `settings.*`;不做通用正则求解。`install.sh` 验收项⑤ 只比对
Caddy ↔ Authelia 两处,核心侧必须用本脚本。
