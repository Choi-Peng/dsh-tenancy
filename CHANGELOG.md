# 开发日志

> [!NOTE]
> 本文档由 AI 生成,可能存在错误或遗漏,使用前请 review。

## 2026-09-03(四)

### 热修 — 公开站点两段路径劫持插件路由(deepseek-balance 余额不可用的根因)

- **现象**:启用多租户部署后,dsh-deepseek-balance 侧栏余额读数失效
  (显示错误提示或 `--`),设置卡片读不到/存不进;`/deepseek-balance` 与
  `/deepseek-balance/settings` 直连 dsh-web(含域名 Host)均正常。
- **根因**:nginx 层把公开站点(P11)的 `location ~ ^/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+(/.*)?$`
  内联进了 dsh vhost——所有**两段无点路径**被劫持到匿名站点端口 3089,绕过
  Caddy/Authelia/dsh-web。`/deepseek-balance/settings` 正中该正则(单段的
  `/deepseek-balance` 幸免);客户端在同一个 `Promise.all`/try 里解析两个响应,
  settings 侧先抛错 ⇒ 健康的余额响应也不会被应用。同类暴露:`/footer-order/settings`
  (此前的 `/plugins/` 劫持是同一类问题的第一次现身)。
- **修复(部署侧,已即时生效)**:为 `/deepseek-balance`、`/footer-order`
  增加 `^~` 前缀豁免回 Caddy 9443;reload nginx 后两路由恢复
  302→Authelia→Caddy→dsh-web 的正常链路,公开站点路径不受影响。
  ⚠ **第一版豁免踩了 nginx 固有行为的坑并已自纠**:写成带尾斜杠的
  `location ^~ /deepseek-balance/` 后,nginx 对「以斜杠结尾的 prefix location
  + proxy_pass」会在请求 URI 恰为该前缀但缺尾斜杠时直接 301 补斜杠——本体的
  `GET /deepseek-balance` 被 301 到 `/deepseek-balance/` → dsh-web 404 空体,
  settings 通了而余额读数仍显示 `--`。改为**不带尾斜杠**的前缀(同时覆盖裸
  路径与子路径,不触发该 301)后全部恢复。
- **修复(插件侧,纵深防御)**:`lib/sites.js` 尾斜杠 301 移到
  `resolveSiteTarget` **之后**——未发布的两段根(含被误转的插件路由)直接
  404(`not-published`),不再先 301 掩盖真实 404;已发布站点行为不变(先解析
  成功再 301)。`scripts/selftest.mjs` 新增 4b 回归锚点,全量 215/0。
- **修复(deepseek-balance 侧,纵深防御)**:①客户端把 settings 拉取改为
  独立 best-effort(单独 try/catch,不与余额解析同 try)——settings 路由再被
  任何层劫持/不可达时,余额读数照常渲染,只丢显示偏好;②余额 fetch/解析失败
  且无历史读数时,显式展示失败原因(此前非 SyntaxError 的失败被静默吞掉,
  侧栏只显示 `--`,排障无从下手——本次 `--` 之谜的直接教训)。
- **文档**:`handbooks/deployment.md`(nginx 节新增「勿内联两段正则」警示 +
  「豁免前缀勿带尾斜杠」警示 + 常见问题新行)、
  `examples/nginx/dsh.example.com.conf`(P11 块头警示注释)。

## 2026-09-02(二)

### P13 — 共享工作区深化:共享区文件访问放行 + 新会话默认共享(创建时刻捕获)

- **共享工作区内的文件访问放行**(小改①):此前成员的文件访问被 P10 钳制在
  个人根 `~/dsh/<user>`,共享工作区里「能开会话干活(agent 可读写文件)但 UI
  文件树/建目录用不了」。现在 `host.listDirectory` / `host.createDirectory`
  对落在「本人可新建会话(owner/共享用户)的已登记工作区」内的请求放开到**该
  工作区根**(`workspaceCoveringRecord` 最深覆盖 + `workspaceCreatable` 判定),
  listDirectory 响应 `home` 同步指向共享工作区根;非共享路径仍钳回个人根,
  `workspace.create`(新建工作区)仍限个人根。无关用户浏览他人共享区仍钳回
  本人根、建目录仍 403。
- **共享工作区内新建会话默认共享**(小改②,语义按用户指定):会话**创建时刻**
  捕获其归属工作区的 `sharedUsers` 作为默认可读者 = 工作区 owner + 共享用户
  − 创建者(`workspaceDefaultSessionReaders`,纯读;写仍须 owner 授权)。因此:
  共享**前**已建的会话保持私有(创建时 sharedUsers 为空,不追溯);
  共享**后**新建的会话默认对参与者可读;owner 可随时经会话共享对话框
  (mode/readers)改回私有。fork 子会话维持继承父 ACL 语义不变。
- 自测:`scripts/selftest.mjs` 新增 ⑫「共享工作区深化(P13)」——9 项纯函数
  (默认读者/最深覆盖/前缀不误命中)+ 22 项影子路由集成(共享前私有 403、共享后
  双向默认可读、改回私有 403、共享区浏览/建目录放行、无关用户钳制/拒绝)。
  全量 214/0。

## 2026-09-02

### P12 — 系统用户自动开通:注册 1:1 建同名 Linux 账号(不可登录,仅归属个人工作区)

- **新模块 `lib/sysuser.js`**:注册成功后以同一用户名创建 Linux 系统账号——
  `useradd --no-create-home --home-dir <个人工作区> --shell nologin --user-group`,
  **不设密码**(shadow 固有 `!` 锁定)、不进任何管理组 ⇒ **不可登录服务器**
  (密码登录、SSH、su 均不可用);该账号的**唯一**文件权限是其个人工作区
  `memberWorkspaceRoot/<user>`(默认 `/root/dsh/<user>`):递归 chown
  (node 实现,不跟随符号链接)+ 目录 0700。
- **幂等与防误接管**:`getent passwd` 先查——已存在且 home/shell 与约定一致视为
  本插件所建(复用其 uid/gid 重放 chown);home 或 shell 不符(nologin 之外)视为
  **conflict**,不 chown、不动其任何文件,审计 `sysuser.conflict` 并告警。
  useradd 组名冲突时回落 `--no-user-group` 重试一次;非 root 进程、围栏根未配置、
  找不到 nologin shell 时整体降级为不启用(启动告警,注册主流程不受影响)。
- **注册链路**:`registerUser` 成功后的副作用链变为「先 `provisionSystemUser`
  (记审计 `sysuser.created/exists/conflict/fail`)→ 再 `createPersonalWorkspace`
  (接收 uid/gid 做目录归属)」;两者皆尽力而为,失败不翻转注册结果。
- **配置**:`systemUserEnabled`(schema 默认 **false**,模板与生产 profile 已启用)/
  `systemUserShell`(默认 `/usr/sbin/nologin`,缺失回落 `/sbin/nologin` →
  `/bin/false`)/ `systemUserChown`(默认 true)。
- **穿越告警**:`/root` 常为 0750(缺 other-x),系统用户即使拥有
  `/root/dsh/<user>` 也无法穿越抵达——检测祖先链缺 `other-x` 时告警一次/进程并给出
  建议命令(`chmod o+x /root` 仅允许穿越不可列目录,或 `setfacl -m u:<user>:x /root`);
  插件只提醒,**不擅改 /root 权限**。
- **管理端补建**:`POST /tenancy/sysuser`(admin-only,body `{username}`)为存量
  成员补建账号 + 目录归属(幂等可重放,conflict 返回 409),审计 `sysuser.ensure`。
- **修复(部署实测发现)**:`createRegisterRoutes` 组装 `registerUser` 依赖时漏传
  `provisionSystemUser` —— 注册链路静默跳过建号(管理端点与自测直调均正常,恰好
  漏在 HTTP 接线一环)。已修复并新增 ③ 路由级回归(经 `/register/api` 真实 handler
  断言钩子透传);生产端到端实测 `register.success → sysuser.created →
  sysuser.chown → workspace.create` 全链路触发,自测 183/0。
- 自测:`scripts/selftest.mjs` 新增 ⑪「P12 系统用户自动开通」(useradd 参数/幂等/
  conflict/回落重试/错误诊断/not-root 全走注入 fake exec,绝不真实建号;递归 chown
  用临时目录实测含符号链接不跟随;traversalBlockers 边界,22 项),③ 注册事务断言
  「先建号、uid/gid 传入个人工作区创建」。全量 180/0。

## 2026-08-31

### P11 — 公开站点:`pub.example.com/<user>/<projectName>` 公开工作区构建产物

- **新增独立端口匿名静态发布服务**(`lib/sites.js`):默认监听
  `127.0.0.1:3089`,与主站 3088 的 SPA/影子路由完全隔离(不注册 webServer 路由、
  不读身份头、不经 forward_auth)。部署方把公开域名(如 `pub.example.com`)经
  nginx/Caddy 转发到该端口,URL `/<user>/<projectName>` 即公开成员个人工作区
  `memberWorkspaceRoot/<user>/<projectName>/<publicBuildDir>`(默认 `dist`)的构建产物。
- **发布模型**:无需额外标记步骤——`~/dsh/<user>/<projectName>/dist` 存在即视为
  已发布(构建完成即可访问);未构建项目 404。URL 无尾斜杠 301 到尾斜杠;目录缺省
  `index.html`;未命中文件且末段无扩展名(路由形态)按 `publicSpaFallback` 回落
  `index.html`(SPA 客户端路由)。
- **路径安全**:先按 `/` 切分再逐段 `decodeURIComponent` 校验(拒 `../`、编码
  分隔符 `%2F`/`%5C`、NUL、隐藏段、`node_modules`);realpath **双重围栏**——
  buildRoot 必须落在 memberRoot 内(挡用户目录符号链接外逃),请求文件必须落在
  buildRoot 内(挡 `dist → 兄弟项目/根外` 错位);仅 GET/HEAD;可选 Host 白名单
  (`publicSitesHosts`,生产建议 `['pub.example.com']`)。
- **配置**:`publicSitesEnabled`(schema 默认 true)/ `publicSitesHost` /
  `publicSitesPort` / `publicSitesHosts` / `publicBuildDir` / `publicSpaFallback` /
  `publicCacheControl`。非回环绑定、空 Host 白名单、memberRoot 未启用时打 WARN;
  端口占用仅影响公开站点本身,不拖垮主插件。
- **部署示例**:在 `examples/nginx/dsh.example.com.conf` 内新增公开站点 server 块
  (nginx 直连 3089,无鉴权);`examples/Caddyfile` 末尾附「全流量走 Caddy」的可选块;
  `install.sh` 生成的配置模板与 `cordis.patch.yml` 同步补全 P11 键。
- **发布指引 skill(`publish-web-app`)**:新增 `skills/publish-web-app.md`(带
  frontmatter,可同时被 dsh-skill-filesystem 发现),插件启动时经
  `ctx.inject(['skills'])` + `ctx.skills.register` 运行时注入,零安装步骤。
  内容明确 DSH 写应用的约定:项目建在 `~/dsh/<user>/<projectName>/`、**构建产物
  必须放 `<项目>/dist/`**(URL 只映射 dist,项目根 index.html 不发布)、资源必须
  相对引用(Vite `base: './'`)、**项目内虚拟环境隔离依赖**(Python 建 `.venv`
  且一律用 `.venv/bin/*` 全路径——DSH 每条 bash 是全新 shell,`source activate`
  不跨命令;Node 依赖装进项目内 `node_modules`,禁 `npm install -g`;
  `.venv`/`node_modules` 是隐藏/依赖目录不会被公开服务,别弄进 dist),以及
  **最简单免构建单 index.html 直接写进 dist** 的写法、构建后验证与最终 URL
  格式。`package.json` files 增加 `skills` 目录;运维手册补「无 dist 但有
  index.html → 404」FAQ(含两种处理方式)。
- **修复**:skill 注册补齐 `source: 'runtime'` —— `ctx.skills.register` 不做
  source 默认,而 skill 加载器(validateDefinition)要求非空字符串,缺失会导致
  `skill(name)` 加载报 `source must be a string`(skill 列表可见但打不开)。
- 自测:`scripts/selftest.mjs` 新增 ⑨「公开站点(P11)」(真实 HTTP 服务冒烟:
  发布/301/资源/未发布 404/隐藏文件/穿越/符号链接逃逸与根内错位/HEAD/405/SPA
  回落/自定义 buildDir/Host 白名单/纯函数边界,41 项)与 ⑩「apply() 接线」
  (`publicSitesEnabled=true` 经插件启动真实端口并暴露 `__dshTenancy.sitesPort`,
  且断言 `publish-web-app` skill 注册成功、内容含 dist/index.html/.venv 约定、
  source/provider 就绪)。全量 156/0。

## 2026-08-29

### P10 — 成员文件访问收窄到个人主工作区(`~/dsh/<userName>`)

- 原先成员的目录浏览/建目录/新建工作区被围在整个 `memberWorkspaceRoot`(如 `~/dsh`)
  内,意味着任意成员都能浏览/读写 `~/dsh/alice`、`~/dsh/bob` 等**他人**的个人目录。
  P10 把非管理员成员的**文件访问围栏根**从 `memberWorkspaceRoot` 进一步收窄为
  `memberWorkspaceRoot/<userName>`(个人主工作区)。
- 新增 `personalRootOf(user)`:解析并惰性创建 `~/dsh/<user>`(realpath 归一),作为
  成员的围栏根。`confineMemberPayload` 的
  `workspace.create` / `host.listDirectory` / `host.createDirectory` / 非工作区
  `session.create` cwd 全部改用该个人根:
  - **浏览**(`host.listDirectory`)越界/缺省 → 静默钳制回个人根(不吐成员根绝对路径);
  - **写入/新建**(`workspace.create`、`host.createDirectory`)越出个人根 → 直接 403;
  - **非工作区会话 cwd** → 收窄到个人根(`~/dsh/alice` 下任意项目目录可建会话)。
- **共享例外**:共享用户经 `workspace.create` 之外的 `session.create`(workspaceId 或
  cwd)指向**共享工作区**时,按 `workspaceCreatable` 放行——即共享用户仍能在他人
  共享给自己的工作区里新建会话(哪怕该工作区路径在本人根之外);无关用户仍 403。
- **目录浏览响应 `home`**(`host.listDirectory` 的 `value.home`)改写为成员个人根,
  而非整个 `memberRoot`,避免 UI 诱导跳出个人根。
- 缺省 `memberWorkspaceRoot` 仍为 `~/dsh`;空串(未启用围栏)对这些方法对成员维持
  admin-only,行为不变。注册时 `createPersonalWorkspace` 已经为每个新用户建好
  `~/dsh/<user>`。
- 自测:`scripts/selftest.mjs` 新增 ⑧「成员文件访问收窄到个人根(P10)」——本人根下
  新建工作区/建目录放行、他人根下新建工作区/建目录 403、浏览他人根钳制回本人根、
  缺省浏览与 `home` 指向本人根、共享用户经 cwd 在共享工作区建会话放行、无关用户 403。
  全量 117/0。

## 2026-08-29

### P9 — 工作区共享 + 注册自动建个人工作区

- **注册即建个人工作区**:邀请码注册成功后(`registerUser`),若启用了
  `memberWorkspaceRoot`(默认 `~/dsh`),自动在 `~/dsh/<username>` 创建以用户名
  为名的工作区并旁车登记 owner。经 `ctx.get('workspaceRegistry').create(path,
  title)` 创建真实工作区(标题=用户名),目录不存在则建;失败不翻转注册结果,
  仅记日志(目录已建,用户首次登录仍可见)。
- **工作区共享模型**:旁车 workspace 记录新增 `sharedUsers: string[]`(`workspace.create`
  成功后初始化;注册建的个人工作区同形)。管理面新增
  `GET/POST /tenancy/workspaces/<id>/share`(owner/admin 限定;POST 以
  `{ sharedUsers: [...] }` 全量覆盖,去重/去空白/剔除 owner 自身)。
- **会话创建门(requirement 3/4/5)**:`session.create` 的 `workspaceId` 与 `cwd` 两
  种形式对成员统一改为「owner 或 sharedUser」才放行。共享用户可在共享工作区新建
  会话;仅被共享了会话但工作区未共享的用户(既非 owner 也非 sharedUser)无法在
  该工作区新增会话。cwd 形式额外经 `workspaceByPath` 反查工作区归属,堵「换字段绕过」。
- **列表/事件可见性(requirement 3/5)**:`workspace.list` 成员可见性从「仅 owner」
  扩展为 `workspaceVisible(owner / sharedUser / 工作区内存在可读会话)`;会话仍按
  `readable` 收敛到可读子集。因此共享工作区的共享用户看到「工作区名 + 自己可读的
  会话」;仅共享会话未共享工作区时,用户仍看到工作区名与该会话,但不能新增会话。
  WS 帧(`workspace`/`workspace-removed`/`workspace-order-changed`)过滤同构对齐(共享
  用户仍收帧,只是会话 ID 收敛)。
- **客户端(用户中心工作区管理)**:`WorkspaceList` 增加共享徽章与「共享」按钮,
  打开 `WorkspaceShareDialog`,owner/admin 可增删共享用户。
- 自测:`scripts/selftest.mjs` 新增 ⑦「工作区共享(P9)」(owner 登记、共享用户设/改、
  共享用户建会话放行、非 owner/共享用户建会话 403、谓词边界),并在 ③ 注册事务里
  验证「注册成功后触发个人工作区创建」。全量 107/0。

## 2026-08-29

### 修复:P7 pending 窗口 403（新会话模型列表永卡「Refreshing model list…」/ 历史加载失败）

- **症状**（成员,非 admin）:点 new session 后模型选择器永卡 `Refreshing model
  list…`、历史报 `Failed to load history: transport failure for
  /api/session.history: HTTP 403`;发首条消息或刷新页面才恢复
- **根因**:P7（fe258e0）引入延迟 ACL 登记——`session.create`/`fork` 成功后记录
  只进内存 `pendingSessions`,首条 `session.prompt` 才落盘 `acl.json`——但门控
  `readable()/writable()/canSeeUser()` 与 `/tenancy/sessions*` 路由只查落盘库。
  pending 窗口内创建者对自己的新会话 `models/history/selectModel` 全被 403。
  客户端两头的表现都由此派生:`ModelDirectory.load()` 里 transport 异常抛在
  error 态赋值前 → 状态永卡 loading;history 失败态驻留到重挂载 → 「刷新才好」
  实为重新拉取,权限早已被那条 prompt 恢复。（31bb078 只把 `llm.discoverModels`
  挪进影子路由,解了目录侧,没解会话侧。）
- **修复(pending 读穿兜底,查落盘 → 再查 pending,与 fork 父记录既有写法同构)**:
  - `readable()` / `writable()` / `canSeeUser()`（WS 帧过滤)三处会话判定
  - `GET /tenancy/sessions` 列表合并 pending（同 id 落盘优先,可见性与
    `readable()` 严格一致,消除「能打开却不在列表」)
  - `GET/POST /tenancy/sessions/<id>/acl`:读回、owner 判定、字段保留都兜底
    pending;显式保存视为落盘并即删 pending 影子
  - `lib/util.js` 新增纯谓词 `recordReadable`/`recordWritable`,判定语义
    单源（三处共用);注释与手册同步（`handbooks/operations.md` 排障新增）
  - fail-closed 方向不变:无记录且不在 pending 仍拒;他人读/写/收帧仍 403/丢帧
- 自测:`scripts/selftest.mjs` 新增 ⑥「P7 pending 读穿回归」影子路由级用例
  （19 项,含创建放行、pending 不落盘、读穿、越权负例、落盘、谓词边界）;
  **对修复前代码该组恰有 5 项失败**（与用户报的三症状一一对应),修复后
  全量 73/0

## 2026-08-27

### 安全审查修复（第二批）

- **影子路由补 browser-trust 围栏（F2）**：exact 影子路由优先级高于核心的 `/api`
  前缀路由,被接管的 34 个端点 + `/tenancy/*` + `/register` 本来不过核心那道
  Host/Origin 围栏。现在在 `lib/util.js` 重写同构判定 `isTrustedApiRequest`
  （包未导出原函数）,并在 `gatedHandler` / `adminRoutes` / `session.export` /
  `respond` / `createRegisterRoutes` 五处入口接上（未注入判定函数时 fail-closed）
- **新增 `trustedHosts` 配置**：声明本部署服务的非 loopback 域名;缺省只认 loopback
  Host,此时域名直入的 `/register`、`/tenancy/*` 会被围栏拒（启动时打 WARN）。
  `cordis.patch.yml` / `install.sh` 默认块与部署手册同步补上
- **Caddyfile**：`@register` 块也注入 `X-Dsh-Tenancy-Key`（围栏后的域名与 Origin 保持
  一致）,并删掉转发给插件的 `X-Forwarded-For` / `X-Real-IP`（匿名入口的限流键
  只能由 nginx 定案）
- **特权路径清单单源化（F10）**：`@adminapi` 由 15 条精确路径改为一条 `path_regexp`,
  与 Authelia `resources` 正则逐字符一致（已用 caddy 2.11.4 实测 15 个方法全部命中、
  常规方法与大小写变体不误伤）；`install.sh` 验收清单新增「⑤ 两处正则一致」
- **新增 `tools/check-privileged-sync.py`**：比对核心 `PRIVILEGED_METHODS` ↔ Caddy
  ↔ Authelia **三份**清单（`install.sh` 只比得到后两份）。实测双向可用：核心新增
  方法报「缺失」、Caddy 多列报「多余」，当前仓库三处一致（退出码 0）
- **`trusted_proxies` 收指（F11）**：`private_ranges`（整内网段可信）改为 `127.0.0.0/8`
- **Authelia 模板补二因素（F6，无邮件依赖）**：`totp.issuer` + `webauthn.disable: false`,
  并在模板里写明二因素不靠 SMTP（注册在门户完成、密钥存 SQLite）与 NTP 前置条件。
  【实测修正】试图用规则的 `methods: ['webauthn','totp']` 限定认证方式会被
  `validate-config` 拒——那个键是 HTTP 方法过滤器,已删除并加了注释
- **F12**：越界错误不再回显围栏根绝对路径；`/tenancy/sessions/<id>/acl` 的
  `decodeURIComponent` 改用 `safeDecode`,畸形转义从 500 变 400
- **F3 结论修正**（重要）：原报告的「符号链接根整体逃逸」不成立——`confineToRoot`
  的 `within(real)` 会拒掉「符号链接根 + 真实前缀」组合,所以那是**可用性缺陷**
  （真实前缀路径全被误拒 + 错误消息泄露词法根）而不是越权。已用自测把两种行为
  固定下来,归一仍然是对的修法,但严重度从「高」降为「中」
- 自测：`scripts/selftest.mjs` ④ 区域新增 14 项围栏断言（共 48 项）

## 2026-08-27

### 安全审查修复（第一批）

- **共享密钥强校验**（`lib/index.js`）：`sharedSecret` 非空时 `X-Dsh-Tenancy-Key`
  缺失也会被拒（旧逻辑只在「带头且值不符」时拒绝，抹掉该头即得 local admin）；
  比较改为 `timingSafeEqual`，带错/不带的响应不再可区分。空密钥 + `localIsAdmin`
  的组合现在会在启动时打 WARN
- **围栏根 realpath 归一**（`lib/util.js` `expandHomeDir` + `lib/index.js`）：根是指向
  其他目录的符号链接时,词法根与请求路径不在同一坐标系,成员的正常路径会被全量误拒
  （详见第二批条目的结论修正）；现在启动时归一并在归一发生时打日志告知真实根
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

> 待办（已记录未修）：低危项 F13（全量缓冲/无上游超时/文件锁 2s 等待即失败）与
> F14（审计日志只保留一份轮转、无完整性保护）；其余本批已修，见「第二批」条目。

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
  且 `session.jsonl.zstd`（或历史 `session.jsonl`）无真实对话（≤1 行或不存在）」
  的会话文件夹；删除前清理 `pendingSessions` 残留条目，审计记录 `session.cleanup`
  - **修复**：此前只查 `session.jsonl`，而实际磁盘格式是 zstd 压缩的
    `session.jsonl.zstd`，导致所有会话被误判为无对话而删除。现已支持两种格式，
    zstd 文件经 `zstd -c` 解压后统计行数。
  - 清理后自动扫除 ACL 中的孤儿记录（`acl.cleanup`），防止用户管理中
    显示已删除的会话（Title 丢失 → "Untitled session"）。
- 清理使用并发锁（`cleanupRunning`）避免重叠执行，effect 销毁时清除定时器

### Bug 修复

- **修复 session 清理误删有对话会话**：`cleanupStaleSessions()` 原先只查找
  `session.jsonl`，但实际磁盘格式是 zstd 压缩的 `session.jsonl.zstd`，
  `readFile` 永远 ENOENT 被空 catch 吞掉 → 所有会话均被判为"无对话"，
  在 >1 天后被无差别删除，导致用户管理中大量会话丢失 Title（显示为
  "Untitled session"）。现已拆分 `hasConversationIn()` 支持两种格式：
  优先 `.zstd`（经 `zstd -c` 解压统计行数），回退 `.jsonl`；zstd 不可用或
  解压失败时保守放行（不删）。新增 `cleanupOrphanAcl()` 在每次清理后
  扫除 ACL 中的孤儿记录，防止历史误删残留。

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
