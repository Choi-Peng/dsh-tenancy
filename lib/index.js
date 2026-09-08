// AI 生成声明:本插件代码由 AI 生成,可能存在错误或安全隐患,使用前请 review 并实测。
//
// 职责(单实例多租户):
//   1. 从 Caddy forward_auth 注入的头里提取已验证身份(principal);
//   2. 以 exact 影子路由接管会话类 RPC(dsh-host-webserver 中 exact 优先于
//      client-connection 的 /api 前缀),做 owner/access 判定后经
//      typertGateway.dispatchRpc 直接分发到宿主服务(与核心 /api 拦截器
//      完全同一分发语义;dsh 0.1.2 起 apiProxy/toFetchHandler 已移除);
//   3. 对 session/list、session/search、workspace/list 的响应按可见性过滤;
//   4. 旁车 ACL 存储($DSH_HOME/tenancy/acl.json,原子写+文件锁)——不动会话格式,
//      因为 dsh-session 的 JSONL 头部是白名单序列化,自定义字段会被丢弃;
//   5. 暴露 globalThis.__dshTenancy 钩子(v3),供 dsh-api-gateway 补丁在
//      /api/remote.mux 的 WebSocket 升级/流开闸/下行帧处做身份与过滤
//      (dsh 0.1.2 起事件流由 client-connection WS pump 迁到 api-gateway mux)。
//
// P4 新增:
//   6. 成员工作空间围栏 —— 非 dsh-admins 成员的目录浏览(host.listDirectory)、
//      建目录(host.createDirectory)、建工作区(workspace.create)、显式会话 cwd
//      (session.create.cwd)全部被围在 memberWorkspaceRoot(默认 ~/dsh)内;
//      浏览越界/缺省静默钳制到根,写入越界直接拒绝。
//   7. 邀请码注册 —— /register 公开页 + /register/api(一次性邀请码,SHA-256
//      存储,消费持文件锁),经 authelia CLI 生成 argon2id 哈希后 O_APPEND 写入
//      users.yml(inode 不变,Authelia 文件监听不失效);管理端 /tenancy/invites*。
//
// P6 新增:
//   8. 工作区 owner 隔离 —— workspace.create 成功后旁车登记 owner;
//      workspace.list 对非 admin 仅返回本人创建的工作区(存量无记录工作区
//      fail-closed 仅 admin 可见);WS 侧 workspace-changed/removed/order-changed
//      帧同步按 owner 过滤,成员零可见他人工作区视图;hideEmptyWorkspaces
//      收敛为 admin 视角(己有工作区即使为空也保留)。
//
// P8 新增(右上角用户中心):
//   9. 工作区管理 —— GET /tenancy/workspaces 返回旁车 owner 登记一览
//      (admin 全量,成员仅本人),供用户中心工作区列表;
//   10. 修改密码 —— POST /tenancy/password 经 authelia CLI 校验旧密码后,
//      原地改写 users.yml(保 inode,文件监听不断),仅限代理身份(Remote-User)。
//
// P9 新增(工作区共享):
//   11. 注册成功自动建个人工作区 —— 在 memberWorkspaceRoot(默认 ~/dsh)下以
//      用户名为目录/工作区名创建,旁车登记 owner+path(尽力而为,不翻转注册结果);
//   12. 工作区共享 —— workspace 记录新增 sharedUsers;owner/admin 经
//      GET/POST /tenancy/workspaces/<id>/share 管理共享用户。共享用户可在该
//      工作区新增会话(session.create 的 workspaceId/cwd 门放行),但看不到
//      其中未被单独共享的会话(列表可见性只收敛到可读会话);
//   13. 仅共享会话、未共享工作区 —— 侧栏仍可见工作区名与该会话(workspace.list
//      的 hasReadableSession 可见性),但不能在该工作区新增会话(该用户既非 owner
//      也非 sharedUser,workspaceCreatable 判 false)。
//
// P10 新增(个人文件围栏):
//   14. 成员的**文件访问**收窄到 memberWorkspaceRoot/<userName>(个人主工作区)。
//      浏览(host.listDirectory)/建目录(host.createDirectory)/新建工作区
//      (workspace.create)/非工作区会话 cwd 全部只落在 `~/dsh/<user>` 内;
//      越界浏览静默钳制回个人根、写入/新建越界直接 403。共享他人工作区中的
//      新建会话仍按 workspaceCreatable 放行(cwd 指向共享工作区时不受个人根限制)。
//      未启用 memberWorkspaceRoot 时这些方法对成员维持 admin-only。
//
// P11 新增(公开站点):
//   15. 独立端口(默认 127.0.0.1:3089)的匿名静态发布服务 —— 部署方把公开域名
//      (如 pub.example.com)经 nginx/Caddy 转发到该端口,URL
//      `/<user>/<projectName>` 映射到 memberWorkspaceRoot/<user>/<projectName>/
//      <publicBuildDir>(默认 dist)的构建产物。无鉴权、只读、与主站 SPA 完全隔离;
//      详见 lib/sites.js(路径逐段校验 + realpath 双重围栏 + 可选 Host 白名单)。
//
// P12 新增(系统用户开通):
//   16. 注册成功同步创建同名 Linux 系统用户 —— `useradd -M -s nologin`,无密码
//      (shadow 固有锁定)、不进任何管理组 ⇒ 不可登录服务器;其**唯一**文件
//      权限是个人工作区 memberWorkspaceRoot/<user>(默认 /root/dsh/<user>):
//      递归 chown + 目录 0700。幂等可重放;同名既有账号 home/shell 不符视为
//      冲突,不接管不动文件。详见 lib/sysuser.js。
//
// P13 新增(共享工作区深化):
//   17. 共享工作区内的**文件访问**放行 —— 成员在「本人可新建会话(owner/共享
//      用户)的已登记工作区」内的 host.listDirectory/host.createDirectory 不再
//      钳回个人根,而是放开到该工作区根(共享的文件树/建目录可用);非共享路径
//      维持 P10 个人根钳制,workspace.create(新建工作区)仍限个人根。
//   18. 共享工作区内**新建会话默认共享** —— 会话创建时刻捕获工作区
//      sharedUsers 作为默认可读者(owner + 共享用户,去创建者);因此共享前已建
//      的会话保持私有、共享后新建的默认对参与者可读,owner 可随时改回私有。
//      仅读默认,写仍须 owner 授权。
//
// 明确不做:特权方法(settings./credentials./agentPreset.read 等)不影子注册——
// 它们由核心围栏处理(团队入口 403;管理员流量经 Caddy 重写为 loopback 后放行)。
// 注:exact 影子路由优先级高于核心的 /api 前缀路由,被接管的请求不会再过核心那道
// browser-trust 围栏,因此本插件自己重写一篇同构检查(trustedApiRequest:Host 必须是
// loopback 或 `trustedHosts` 条目、Origin 同源、sec-fetch-site 非 cross-site),
// 挡 DNS rebinding 与跨站误用;身份/ACL 判定建立在这道来源可信之上。

import z from '@deepseek-ai/schemastery';
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { statSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { basename, dirname as pathDirname, resolve as pathResolve } from 'node:path';
import { homedir } from 'node:os';
import { AuditLog } from './audit.js';
import { InviteStore, createRegisterRoutes, changeUserPassword } from './register.js';
import { confineToRoot, expandHomeDir, isLoopbackHost, isTrustedApiRequest, recordReadable, recordWritable, safeDecode, safeSegment } from './util.js';
import { workspaceCreatable, workspaceSharedUsers, workspaceVisible, workspaceCoveringRecord, workspaceDefaultSessionReaders } from './util.js';
import { checkUsername } from './util.js';
import { ensureSystemUser, chownRecursive, resolveNologinShell, traversalBlockers } from './sysuser.js';
import { createPublicSitesServer } from './sites.js';

//#region config

/** 插件配置(schema 默认 → cordis.patch.yml 的 base 层)。 */
export const Config = z.object({
  /** Caddy copy_headers 注入的用户名头(小写)。 */
  identityHeader: z.string().default('remote-user'),
  /** 组头(Authelia Remote-Groups 为逗号分隔字符串)。 */
  groupsHeader: z.string().default('remote-groups'),
  /** 共享密钥:Caddy 注入 X-Dsh-Tenancy-Key;非空则强制校验(缺失也拒)。空=仅限纯内网调试。 */
  sharedSecret: z.string().default(''),
  adminGroups: z.array(z.string()).default(['dsh-admins']),
  /**
   * 非 loopback 的合法 Host 权威(公网域名访问必填,如 ['dsh.example.com'])。
   * 影子路由不走核心的 browser-trust 围栏,本插件自己那份用这个列表判定
   * 「Host 是不是我们的」;缺省只允许 loopback(经 Caddy 重写的请求仍然走)。
   */
  trustedHosts: z.array(z.string()).default([]),
  /** 无身份头的请求(SSH 隧道直连 loopback)视为此主体。 */
  localPrincipal: z.string().default('local'),
  localIsAdmin: z.boolean().default(true),
  defaultAccess: z.union(['private', 'team-read', 'team-rw']).default('private'),
  hideEmptyWorkspaces: z.boolean().default(true),
  /** P3:影子接管 /api/respond,按 rpcId→会话归属 + writable 校验(见 §9 风险表)。 */
  hardenRespond: z.boolean().default(true),
  /** P3:审计日志;空 → $DSH_HOME/tenancy/audit.log */
  auditPath: z.string().default(''),
  /** 空 → $DSH_HOME/tenancy/acl.json */
  dbPath: z.string().default(''),
  /** P4:非管理员成员的工作空间根目录(支持 ~/ 前缀)。P10:成员的**文件访问**被进一步收窄到
   * `memberWorkspaceRoot/<userName>`(个人主工作区)——目录浏览/建目录/建工作区/会话 cwd
   * 都只落在自己名下;共享他人工作区中的新建会话按共享关系放行。空串=不启用(这些方法对成员维持 admin-only)。 */
  memberWorkspaceRoot: z.string().default('~/dsh'),
  /** P4:邀请码注册总开关(公开页面 /register 与管理端 /tenancy/invites*)。 */
  registerEnabled: z.boolean().default(true),
  /** 注册用户加入的 Authelia 组(仅 dsh-team 语义;绝不写 admin 组)。 */
  registerGroup: z.string().default('dsh-team'),
  /** Authelia file 后端用户库路径(registerEnabled 时必须可写)。 */
  autheliaUsersPath: z.string().default('/etc/authelia/users.yml'),
  /** authelia CLI 路径,用于生成 argon2id 口令哈希。 */
  autheliaBin: z.string().default('/opt/authelia/authelia'),
  /** 邀请码库;空 → $DSH_HOME/tenancy/invites.json(多实例共享 HOME 时必须逐实例唯一!) */
  invitesPath: z.string().default(''),
  /** P12:注册成功时同步创建同名 Linux 系统用户(nologin、无密码、不可登录服务器,
   * 文件权限仅限个人工作区)。依赖 dsh 以 root 运行且有 useradd/getent;未启用、
   * 围栏根未配置、非 root 或找不到 nologin shell 时自动跳过(启动时告警一次)。 */
  systemUserEnabled: z.boolean().default(false),
  /** P12:系统用户登录 shell;配置路径不存在时按 /usr/sbin/nologin → /sbin/nologin →
   * /bin/false 依次回落。 */
  systemUserShell: z.string().default('/usr/sbin/nologin'),
  /** P12:把个人工作区递归 chown 到系统用户(目录置 0700)。关闭则只建号不动文件。 */
  systemUserChown: z.boolean().default(true),
  /** P11:公开站点服务总开关 —— pub.example.com/<user>/<projectName> 匿名静态发布。
   * schema 默认 true(正式部署即启用);直接传裸配置的调用方(如自测)未显式置 true
   * 时按未启用处理,避免测试进程意外占用端口。 */
  publicSitesEnabled: z.boolean().default(true),
  /** 公开站点监听地址(仅本机回环即可:由 nginx/Caddy 转发公开域名到此端口;勿绑 0.0.0.0)。 */
  publicSitesHost: z.string().default('127.0.0.1'),
  /** 公开站点监听端口(默认 3089;与主站 3088 隔离,nginx 把 pub.example.com 转发到此)。 */
  publicSitesPort: z.natural().max(65535).default(3089),
  /** Host 白名单(hostname 或 host:port,大小写不敏感);空 = 接受任意 Host。
   * 生产建议设为公开域名(如 ['pub.example.com']):该端口只被代理访问时,
   * 防的是「Host 错配」这类混淆代理,本身不构成身份边界。 */
  publicSitesHosts: z.array(z.string()).default([]),
  /** 项目内构建输出子目录名(URL 的 <projectName> 映射到 <project>/<publicBuildDir>)。 */
  publicBuildDir: z.string().default('dist'),
  /** 未命中文件且末段无扩展名(路由形态)时回落 index.html(SPA 客户端路由)。 */
  publicSpaFallback: z.boolean().default(true),
  /** 公开站点的 Cache-Control 响应头。 */
  publicCacheControl: z.string().default('public, max-age=300')
});

//#region tenancy settings namespace(设置 → 插件「可配置」tab 的派发账本)

/**
 * 设置页插件 tab 按「settings.describe 提供的命名空间 ∩ 卡片注册的 key」派发卡片
 * (dsh-client-ui-settings-plugins 的 ConfigurablePluginsTabController)。客户端卡片
 * 以 key 'tenancy' 注册,若宿主不 serve 同名命名空间,卡片永不显示。
 * 这里注册一个最小、无敏感字段的 'tenancy' 命名空间(sharedSecret/authelia 路径等
 * 一律不进 describe 视图),仅用于卡片派发与配置可见性。
 * dsh 0.1.2 起 settingsNamespace() 助手已移除:register 直接收 lowercase-hyphenated
 * 字符串,故这里用普通字符串。
 */
const TENANCY_NS = 'tenancy';

/** Schema 同时定义默认值;字段与 Config 对应项保持一致。 */
const TENANCY_SCHEMA = z.object({
  registerEnabled: z.boolean().default(true),
  memberWorkspaceRoot: z.string().default('~/dsh'),
  defaultAccess: z.union(['private', 'team-read', 'team-rw']).default('private'),
  hideEmptyWorkspaces: z.boolean().default(true)
});

/** 从插件配置行解析 base 层(逐字段白名单,非法值回落默认)。 */
function resolveTenancySettings(config) {
  return {
    registerEnabled: typeof config.registerEnabled === 'boolean' ? config.registerEnabled : true,
    memberWorkspaceRoot: typeof config.memberWorkspaceRoot === 'string' ? config.memberWorkspaceRoot : '~/dsh',
    defaultAccess: ['private', 'team-read', 'team-rw'].includes(config.defaultAccess) ? config.defaultAccess : 'private',
    hideEmptyWorkspaces: typeof config.hideEmptyWorkspaces === 'boolean' ? config.hideEmptyWorkspaces : true
  };
}

//#endregion

const TENANCY_MAX_BODY_BYTES = 64 * 1024 * 1024;

//#endregion

//#region method classification (方案 §5.4 放行矩阵;dsh 0.1.2 typert 端点版)

/**
 * 影子注册的全部端点(exact 表,dsh 0.1.2 起 wire 端点为 `<namespace>/<method>`
 * 斜杠风格,URL 即 /api/<endpoint>)。名称已对照各控制器 lib/typert.host.js 与
 * lib/index.js 的 Remote 装饰器核实:
 *   session/* ← dsh-api-session-controller(namespace "session")
 *   skills/list ← dsh-api-session-controller(namespace "skills",会话技能目录)
 *   subagents/* ← dsh-subagent、goals/* ← dsh-goal、llm/discoverModels ← dsh-llm
 *   workspace/*、directoryPicker/* ← dsh-api-workspace-controller
 * 流式端点(session/follow、session/control、workspace/follow)经 /api/remote.mux
 * WebSocket 多路复用,由 dsh-api-gateway 补丁在流开闸/下行帧处门控(见 gateStream
 * 与 filterEvent),不走 HTTP 影子路由。
 */
export const GATED_METHODS = [
  // 会话生命周期(create 成功后登记 ACL;list/search 做可见性过滤)
  'session/create', 'session/list', 'session/search',
  // 会话读(page 取代旧 session.history;modelCatalog 取代旧 session.models)
  'session/page', 'session/modelCatalog', 'session/attachment',
  'subagents/list',
  'skills/list',
  // 模型发现(★ 从 Authelia 特权通道移到 tenancy 代理:非管理员也能拿到模型列表)
  'llm/discoverModels',
  // 会话写(fork 即读取父会话内容,按写权限判定)
  'session/selectModel', 'session/rename', 'session/fork', 'session/prompt',
  'session/updateQueue', 'session/cancel',
  'subagents/prompt', 'subagents/interruptByParent',
  'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/complete', 'goals/clear',
  // 工作区(列表需过滤;变更 v1 收敛为 admin)
  'workspace/list',
  'workspace/create', 'workspace/rename', 'workspace/delete', 'workspace/insertBefore',
  'workspace/insertSessionBefore', 'workspace/archiveSession',
  // 目录浏览/建目录(★ 旧 host.listDirectory/createDirectory 的新归属;多租户必须收紧)
  'directoryPicker/list', 'directoryPicker/createDirectory'
];

/** 响应行集需要按可见性过滤的端点(result.value.items 行含 sessionId)。 */
const LIST_FILTERED = new Set(['session/list', 'session/search']);
/** args 里带 sessionId(或可解析出会话身份)、要求 readable 的端点。 */
const READ_BY_SESSION = new Set([
  'session/page', 'session/modelCatalog', 'session/attachment',
  'subagents/list', 'skills/list'
]);
/** args 里带 sessionId(或可解析出会话身份)、要求 writable 的端点。 */
const WRITE_BY_SESSION = new Set([
  'session/prompt', 'session/rename', 'session/cancel', 'session/updateQueue',
  'session/selectModel', 'session/fork',
  'subagents/prompt', 'subagents/interruptByParent',
  'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/complete', 'goals/clear',
  'workspace/insertSessionBefore', 'workspace/archiveSession'
]);
/** 需 admin 主体才放行的工作区组织操作(侧栏排序/改名/删除,与文件系统路径无关)。 */
const ADMIN_ONLY = new Set([
  'workspace/rename', 'workspace/delete', 'workspace/insertBefore'
]);
/**
 * P4:成员可放行、但请求路径必须落在 memberWorkspaceRoot 内的端点。
 *   workspace/create             → args.path(采纳已有目录为工作区)
 *   directoryPicker/list         → args.path 缺省/越界时静默钳制到根(浏览只见根内内容)
 *   directoryPicker/createDirectory → resolve(args.path, args.name) 越界即拒
 * memberWorkspaceRoot 为空串时不放行,回落旧的 admin-only 行为。
 */
const MEMBER_PATH_CONFINED = new Set(['workspace/create', 'directoryPicker/list', 'directoryPicker/createDirectory']);
/** $events/result:ask 类事件(question/approval)的应答端点(hardenRespond 门)。 */
const EVENTS_RESULT_PATH = '/api/$events/result';

/**
 * 从 wire args(payload.args,typert 命名参数)解析会话身份:
 *   · 直接字段 sessionId / parentSessionId(绝大多数会话端点);
 *   · address 对象(session/page、session/follow 的
 *     {kind:'session',sessionId} | {kind:'subagent',parentSessionId,childSessionId});
 *   · 深度≤3 的兜底扫描(goals/subagents 的命名参数在不同控制器里命名不一)。
 */
function sessionIdOf(payload) {
  const args = payload?.args;
  if (args == null || typeof args !== 'object') return null;
  const direct = args.sessionId ?? args.parentSessionId;
  if (direct !== undefined && direct !== null && direct !== '') return String(direct);
  const addr = args.address;
  if (addr != null && typeof addr === 'object') {
    const viaAddress = addr.sessionId ?? addr.parentSessionId;
    if (viaAddress != null && viaAddress !== '') return String(viaAddress);
  }
  return deepFindSessionId(args, 0);
}

function deepFindSessionId(value, depth) {
  if (value == null || typeof value !== 'object' || depth > 3) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = deepFindSessionId(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if ((key === 'sessionId' || key === 'parentSessionId') && typeof item === 'string' && item !== '') return item;
  }
  for (const item of Object.values(value)) {
    const hit = deepFindSessionId(item, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * 在旁车 workpspaces 表中按下标路径反查工作区记录(供 session.create 的 cwd 形式
 * 做成员的 workspace 归属判定)。已登记工作区现携带 path(workspace.create 响应
 * 与注册时创建的个人工作区都会写入);未命中返回 null。
 */
async function workspaceByPath(store, canonicalPath) {
  const workspaces = (await store.all()).workspaces ?? {};
  for (const rec of Object.values(workspaces)) {
    if (rec?.path && rec.path === canonicalPath) return rec;
  }
  return null;
}

//#endregion

//#region ACL sidecar store

function resolveDshHome() {
  return process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`;
}

class AclStore {
  #path; #cache = null; #mtimeMs = 0;

  constructor(path) {
    this.#path = path;
    this.#loadSync(); // 启动即建立同步视图:WS 帧过滤(pump 内)不允许 await
  }

  /** 构造时的阻塞初始化;失败按空库处理(与异步路径语义一致)。 */
  #loadSync() {
    try {
      const st = statSync(this.#path);
      this.#cache = { version: 1, sessions: {}, workspaces: {}, ...JSON.parse(readFileSync(this.#path, 'utf8')) };
      this.#mtimeMs = st.mtimeMs;
    } catch {
      this.#cache = { version: 1, sessions: {}, workspaces: {} };
    }
  }

  async #load() {
    const { readFile, stat } = await import('node:fs/promises');
    try {
      const st = await stat(this.#path);
      if (this.#cache && st.mtimeMs === this.#mtimeMs) return this.#cache;
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'));
      this.#cache = { version: 1, sessions: {}, workspaces: {}, ...parsed };
      this.#mtimeMs = st.mtimeMs;
    } catch {
      this.#cache = { version: 1, sessions: {}, workspaces: {} };
    }
    return this.#cache;
  }

  async #persist(db) {
    // 注意:writeFileAtomic 的 options 参数是必填的(dirMode/mode),缺了会 TypeError
    const { stat } = await import('node:fs/promises');
    await writeFileAtomic(this.#path, JSON.stringify(db, null, 2), { dirMode: 0o755, mode: 0o600 });
    this.#cache = db;
    try { this.#mtimeMs = (await stat(this.#path)).mtimeMs; } catch {}
  }

  /** 读-改-写全程持锁。 */
  async mutate(mutator) {
    const { mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(this.#path), { recursive: true }); // 锁文件也落在此目录
    return withFileLock(`${this.#path}.lock`, async () => {
      const db = await this.#load();
      const result = mutator(db);
      await this.#persist(db);
      return result;
    });
  }

  async all() { return this.#load(); }

  /** 上次 mtime 探活时刻(节流:≥1s 一次),防旁路写入时视图长期陈旧。 */
  #viewCheckAt = 0;

  /**
   * 同步快照(供 WS pump 的帧过滤使用)。migrate/mutate 与 HTTP 路径的 all()
   * 都会刷新;此处额外以 ≤1s 间隔探活文件 mtime,覆盖绕过插件 API 的旁路写入
   * (另一实例共享 HOME 手写/覆盖 acl.json 等),代价是一次 statSync。
   */
  viewSync() {
    const now = Date.now();
    if (now - this.#viewCheckAt >= 1000) {
      this.#viewCheckAt = now;
      try {
        const st = statSync(this.#path);
        if (st.mtimeMs !== this.#mtimeMs) this.#loadSync();
      } catch { /* 文件暂时不可读:保持现有视图 */ }
    }
    return this.#cache ?? { version: 1, sessions: {}, workspaces: {} };
  }
}

//#endregion

//#region plugin

export const inject = ['webServer'];
export const name = 'tenancy';

export function apply(ctx, config) {
  const dbPath = config.dbPath || `${resolveDshHome()}/tenancy/acl.json`;
  const store = new AclStore(dbPath);
  const audit = new AuditLog(config.auditPath || `${resolveDshHome()}/tenancy/audit.log`);
  const invites = new InviteStore(config.invitesPath || `${resolveDshHome()}/tenancy/invites.json`);
  const adminSet = new Set(config.adminGroups);
  /** 围栏用的可信 Host 集合(小写;`hostname` 或 `host:port` 两种形式都接受)。 */
  const trustedHostSet = new Set(config.trustedHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean));

  // 安全红线提示:空密钥 + localIsAdmin 时,任何能直连本端口的调用方(本机进程、
  // SSRF、误配为 0.0.0.0 绑定)不带任何头即为 admin,身份头也可任意伪造。
  if (!config.sharedSecret && config.localIsAdmin) {
    ctx.logger?.warn?.('tenancy: sharedSecret 为空且 localIsAdmin=true —— 仅可用于可信内网；'
      + '任何能直连本端口的请求都会被当作 local admin，生产部署必须配置 sharedSecret');
  }
  // 围栏缺 trustedHosts 时只认 loopback Host:经 Caddy 的流量正常(Host 已重写/固定为域名后
  // 仍要求你声明),但 `/register` 与域名直入的 /tenancy/* 会全部 403。
  if (trustedHostSet.size === 0) {
    ctx.logger?.warn?.('tenancy: trustedHosts 为空 —— 影子路由只接受 loopback Host；'
      + '公网域名访问请设为 ["你的域名"]，否则 /register 与 /tenancy/* 会被拒绝');
  }

  /**
   * P7:待注册会话表——session.create / session.fork 成功后不立即写 ACL,
   * 而是暂存于此(纯内存,重启丢失),待首次 session.prompt(真实对话)时才
   * 登记到 acl.json。这样:① 只点 new session 不发消息的会话不落盘;
   * ② 插件重启后已有 ACL 的会话不受影响,未发消息的会话由下方 cleanup
   * 扫盘清理。值结构与 ACL 记录同形。
   * ★ 修复(regression:模型列表卡 'Refreshing model list...' / 历史 403):
   * 一切会话判定(含 WS 帧过滤与 /tenancy ACL 路由)必须「先查已落盘记录,
   * 再兜底 pending 表」。此前 readable()/writable()/canSeeUser() 只查落盘库,
   * 首条 prompt 落盘前的窗口里,创建者本人对自己的新会话 models/history/
   * selectModel 全被 403 —— 正是上述两个用户可见症状的根因。
   */
  const pendingSessions = new Map();

  // P4:注册 tenancy settings 命名空间 —— 设置→插件「可配置」tab 按 key 派发卡片,
  // 不 serve 该命名空间则多租户卡片永不显示(与 shell 卡片同机制)。
  // settings 服务缺失时注册回调不执行,插件其余功能不受影响(同 deepseek-balance 语义)。
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(TENANCY_NS, TENANCY_SCHEMA, { base: resolveTenancySettings(config) });
  });

  // P11:向 agent 注册「发布 Web 应用到公开站点」skill —— 写清楚 DSH 该怎么写应用、
  // 构建产物该放在哪(默认 dist,含免构建单 index.html 场景)。技能文件随包分发
  // (skills/publish-web-app.md,带 frontmatter,也可直接拷入 ~/.dsh/skills 由
  // dsh-skill-filesystem 发现);这里经 ctx.skills.register 运行时注入,零安装步骤。
  // skills 服务缺失/文件不可读时静默跳过,不影响插件其余功能。
  ctx.inject(['skills'], (sctx) => {
    if (!sctx?.skills?.register) return;
    try {
      const text = readFileSync(new URL('../skills/publish-web-app.md', import.meta.url), 'utf8');
      const meta = {};
      const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
      const body = front ? text.slice(front[0].length) : text;
      if (front) {
        for (const line of front[1].split(/\r?\n/)) {
          const kv = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line.trim());
          if (kv) meta[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
        }
      }
      const name = typeof meta.name === 'string' ? meta.name : '';
      const description = typeof meta.description === 'string' ? meta.description : '';
      if (!name || !description || body.trim() === '') {
        ctx.logger?.warn?.('tenancy: publish-web-app skill 文件缺失或格式异常,未注册');
        return;
      }
      sctx.skills.register({
        name,
        description,
        ...(typeof meta.whenToUse === 'string' && meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
        // source 必填:skill 加载器(validateDefinition)要求 source 为非空字符串,
        // register() 不做默认;漏了会导致 skill(name) 加载报 "source must be a string"。
        source: 'runtime',
        content: body
      });
      ctx.logger?.info?.(`tenancy: 已注册 skill "${name}"(公开站点发布指引)`);
    } catch (error) {
      ctx.logger?.error?.(`tenancy: 注册 publish-web-app skill 失败: ${error?.message ?? error}`);
    }
  });

  //#region P4:成员工作空间围栏根

  /**
   * 非管理员成员的可见/可用目录根(支持 ~/ 展开)。null=未启用围栏,
   * 此时 MEMBER_PATH_CONFINED 方法对成员回落旧的 admin-only 行为。
   */
  const memberRoot = (() => {
    const raw = (config.memberWorkspaceRoot ?? '').trim();
    if (!raw) return null;
    return expandHomeDir(raw, homedir()); // realpath 归一:与 confineToRoot 的真实路径词法同一坐标系
  })();

  // 尽力确保围栏根存在;失败不阻塞启动(后续请求按目录缺失自然报错)。
  // 建好后再 realpath 一次:配置指向尚不存在的目录时,首轮 expandHomeDir 只能
  // 退回词法路径,不补这一步就会留下未归一的根,与请求路径不在同一坐标系而误拒。
  if (memberRoot) {
    import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(memberRoot, { recursive: true });
      try {
        const real = await fs.realpath(memberRoot);
        if (real !== memberRoot) ctx.logger?.warn?.(`tenancy: memberWorkspaceRoot 经符号链接归一为 ${real}(配置值 ${memberRoot})`);
      } catch { /* 归一失败保持现值,请求期由 confineToRoot 判定 */ }
    }).catch(() => {});
  }

  //#region P12:系统用户自动开通(注册 1:1 建号,仅归属个人工作区)

  /**
   * 启用时先做可行性自检(围栏根/nologin shell/root 权限),不满足则整体降级为
   * 未启用并告警——注册主流程不受影响,只是不建号。
   */
  const sysUserCtl = (() => {
    if (config.systemUserEnabled !== true) return null;
    if (!memberRoot) {
      ctx.logger?.warn?.('tenancy: systemUserEnabled=true 但 memberWorkspaceRoot 为空 —— 系统用户自动开通未启用');
      return null;
    }
    const shell = resolveNologinShell(config.systemUserShell);
    if (!shell) {
      ctx.logger?.warn?.('tenancy: systemUserEnabled=true 但找不到可用的 nologin shell —— 系统用户自动开通未启用');
      return null;
    }
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      ctx.logger?.warn?.('tenancy: systemUserEnabled=true 但当前进程非 root —— 系统用户自动开通未启用');
      return null;
    }
    return { shell, chown: config.systemUserChown !== false };
  })();
  if (sysUserCtl) {
    ctx.logger?.info?.(`tenancy: P12 系统用户自动开通已启用(shell=${sysUserCtl.shell} chown=${sysUserCtl.chown});`
      + `注册将建同名 nologin 账号并归属 ${memberRoot}/<user>`);
  }

  // /root 这类祖先缺 other-x 的告警每进程只提示一次(每次注册都喊就是噪音)
  let sysUserTraversalWarned = false;

  /**
   * P12:为成员开通同名系统用户(useradd -M -s nologin,无密码、不进管理组
   * ⇒ 不可登录服务器),返回 {status, uid, gid, home, shell} 或 null:
   *   · 未启用 / 围栏根未配置 / 用户名非法 / 越界 → null;
   *   · 同名既有账号 home/shell 与约定不符(conflict)→ null 且不动其任何文件;
   *   · useradd 失败 → null(已记审计与日志)。
   * 幂等:已存在且 home/shell 一致视为本插件所建,直接复用其 uid/gid。
   */
  async function provisionSystemUser(username) {
    if (!sysUserCtl || !memberRoot) return null;
    if (checkUsername(username)) return null; // 与注册期同一校验,防御性兜底
    const homeDir = confineToRoot(memberRoot, pathResolve(memberRoot, username));
    if (!homeDir) return null;
    const outcome = await ensureSystemUser({
      username, homeDir, shell: sysUserCtl.shell, comment: `dsh tenancy (${username})`
    });
    if (outcome.status === 'created') {
      audit.record({ actor: username, action: 'sysuser.created', uid: outcome.uid, gid: outcome.gid, home: outcome.home, shell: outcome.shell });
      ctx.logger?.info?.(`tenancy: 已创建系统用户 ${username}(uid=${outcome.uid} gid=${outcome.gid} home=${outcome.home} shell=${outcome.shell} 密码锁定)`);
    } else if (outcome.status === 'exists') {
      audit.record({ actor: username, action: 'sysuser.exists', uid: outcome.uid, gid: outcome.gid, home: outcome.home });
    } else if (outcome.status === 'conflict') {
      audit.record({ actor: username, action: 'sysuser.conflict', uid: outcome.uid, home: outcome.home, shell: outcome.shell });
      ctx.logger?.warn?.(`tenancy: 用户名 ${username} 与既有系统账号冲突(home=${outcome.home} shell=${outcome.shell})—— 不接管,个人目录不做归属变更`);
      return null;
    } else {
      audit.record({ actor: username, action: 'sysuser.fail', reason: outcome.reason, detail: String(outcome.message ?? '').slice(0, 200) });
      ctx.logger?.error?.(`tenancy: 创建系统用户 ${username} 失败(${outcome.reason}): ${outcome.message ?? ''}`);
      return null;
    }
    // 穿越检查:home 在 /root 之下时,祖先缺 other-x 会让系统用户进不了自己的目录。
    // 只提醒不擅改(/root 权限是运维决策),建议命令见日志/运维手册。
    if (!sysUserTraversalWarned) {
      const blockers = traversalBlockers(homeDir);
      if (blockers.length > 0) {
        sysUserTraversalWarned = true;
        ctx.logger?.warn?.(`tenancy: 系统用户 ${username} 无法穿越以下目录抵达 ${homeDir}(缺 other-x):${blockers.join(' → ')};`
          + `如需真实可访问,可执行 chmod o+x <目录>(仅允许穿越,不允许列目录)或 setfacl -m u:${username}:x <目录>`);
      }
    }
    return { status: outcome.status, uid: outcome.uid, gid: outcome.gid, home: outcome.home, shell: outcome.shell };
  }

  //#endregion

  // P11:公开站点 —— 独立端口的匿名静态发布(pub.example.com/<user>/<projectName>)。
  // 语义:显式为 true 才启动(schema 默认 true;自测等裸配置调用方 undefined 视为未启用,
  // 避免测试进程占用端口)。buildDir 必须是单段安全名(防 '..'/绝对路径把整个项目当发布根)。
  const publicSitesOn = config.publicSitesEnabled === true;
  const publicBuildDir = safeSegment(config.publicBuildDir) ?? 'dist';
  if (publicSitesOn && !memberRoot) {
    ctx.logger?.warn?.('tenancy: publicSitesEnabled=true 但 memberWorkspaceRoot 为空 —— 公开站点未启动(需要个人工作区根)');
  }
  if (publicSitesOn && memberRoot && (!Array.isArray(config.publicSitesHosts) || config.publicSitesHosts.length === 0)) {
    ctx.logger?.warn?.('tenancy: publicSitesHosts 为空 —— 公开站点接受任意 Host；生产建议设为 ["你的公开域名"]');
  }
  if (publicSitesOn && !isLoopbackHost(config.publicSitesHost)) {
    ctx.logger?.warn?.('tenancy: publicSitesHost 非回环地址 —— 公开站点将直接暴露在网络上(无鉴权)；强烈建议仅绑定 127.0.0.1 并交由 nginx/Caddy 转发');
  }

  /**
   * P9:注册成功后的个人工作区创建(~/dsh/<username>)。尽力而为、绝不抛:
   *   · 目录不存在则建;已存在也沿用(幂等);
   *   · 经 workspace service 创建/复用工作区(若服务未就绪则跳过);
   *   · 旁车登记 owner=username、path、空 sharedUsers。
   * P12:第二参 sysAccount(provisionSystemUser 的返回)非空且 systemUserChown
   *   开启时,把目录递归 chown 给系统用户并置 0700 —— 该账号唯一的文件权限就是
   *   这里。chown 失败只告警,不翻转目录/工作区创建结果。
   * 返回 {workspaceId, path} 或 null(失败/未启用)。用户名已过 checkUsername,
   * 单段、无路径分隔符,作目录/工作区名安全。
   */
  async function createPersonalWorkspace(username, sysAccount = null) {
    if (!memberRoot || typeof username !== 'string' || username.trim() === '') return null;
    const { mkdir } = await import('node:fs/promises');
    const targetDir = pathResolve(memberRoot, username);
    const confined = confineToRoot(memberRoot, targetDir);
    if (!confined) return null; // 用户名不应越界;防御性兜底
    let dirPath;
    try {
      await mkdir(confined, { recursive: true });
      const { realpath } = await import('node:fs/promises');
      dirPath = await realpath(confined);
    } catch (e) {
      ctx.logger?.error?.(`tenancy: 创建 ${username} 个人目录失败: ${e?.message ?? e}`);
      return null;
    }
    if (sysAccount?.uid != null && sysUserCtl?.chown) {
      try {
        const { chmod } = await import('node:fs/promises');
        const res = await chownRecursive(dirPath, sysAccount.uid, sysAccount.gid);
        if (res.errors.length === 0) await chmod(dirPath, 0o700);
        audit.record({
          actor: username, action: res.errors.length ? 'sysuser.chown-partial' : 'sysuser.chown',
          target: 'workspace', path: dirPath, uid: sysAccount.uid, gid: sysAccount.gid,
          entries: res.count, errors: res.errors.length
        });
        if (res.errors.length > 0) {
          ctx.logger?.warn?.(`tenancy: ${username} 个人目录 chown 部分失败(${res.errors.length} 项,首项: ${res.errors[0]?.path}: ${res.errors[0]?.message})`);
        }
      } catch (e) {
        audit.record({ actor: username, action: 'sysuser.chown-fail', target: 'workspace', path: dirPath, detail: String(e?.message ?? e).slice(0, 200) });
        ctx.logger?.warn?.(`tenancy: ${username} 个人目录归属系统用户失败: ${e?.message ?? e}`);
      }
    }
    try {
      const ws = ctx.get?.('workspaceRegistry');
      if (!ws?.create) return null; // 服务未就绪:目录已建,可稍后补
      const entity = await ws.create(dirPath, username);
      const wsId = String(entity?.id ?? '');
      if (wsId) {
        await store.mutate((db) => {
          if (!db.workspaces[wsId]) {
            db.workspaces[wsId] = {
              owner: username,
              path: dirPath,
              title: username,
              sharedUsers: [],
              createdAt: null,
              updatedAt: Date.now()
            };
          }
        });
      }
      return { workspaceId: wsId || null, path: dirPath };
    } catch (e) {
      ctx.logger?.error?.(`tenancy: 创建 ${username} 个人工作区失败: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * P10:成员的个人围栏根 = memberRoot/<userName>(如 ~/dsh/alice),并把其**文件
   * 访问**限制在该目录内(浏览/建目录/新建工作区只落在自己主工作区下)。目录不存在
   * 则惰性创建并 realpath 归一(与 memberRoot 启动流程同一坐标系)。非管理员成员在
   * 共享他人工作区中的新建会话仍经 workspaceCreatable 放行(见 session.create)。
   * 返回个人根或 null(未启用围栏/用户不可解析)。
   */
  async function personalRootOf(user) {
    if (!memberRoot || typeof user !== 'string' || user.trim() === '') return null;
    const candidate = pathResolve(memberRoot, user);
    if (!confineToRoot(memberRoot, candidate)) return null;
    try {
      const { mkdir, realpath } = await import('node:fs/promises');
      await mkdir(candidate, { recursive: true });
      return await realpath(candidate);
    } catch {
      return candidate; // 建/归一失败:维持词法路径,由 confineToRoot 判定
    }
  }

  /**
   * P13:成员文件访问的"有效根"判定——请求路径落在「本人可新建会话(owner/共享
   * 用户)的已登记工作区」内时,返回该工作区根(共享工作区的文件树/建目录放行
   * 到工作区根);否则返回 null(调用方回落 P10 个人根钳制)。仅用于
   * host.listDirectory / host.createDirectory;workspace.create(新建工作区)
   * 仍限个人根,不走此放行。
   */
  async function creatableWorkspaceRootFor(principal, path) {
    if (!memberRoot || typeof path !== 'string' || path.trim() === '') return null;
    const canonical = confineToRoot(memberRoot, path);
    if (!canonical) return null;
    const wrec = workspaceCoveringRecord((await store.all()).workspaces ?? {}, canonical);
    if (!wrec || !workspaceCreatable(wrec, principal.user)) return null;
    return wrec.path;
  }

  /**
   * P13:会话创建时刻捕获其归属共享工作区的默认可读者(workspaceId 或 cwd 形式)。
   * 返回读者数组或 null(未共享/不可解析——维持默认私有)。
   */
  async function defaultSessionReadersOf(args, creator) {
    const wsId = args?.workspaceId;
    let wrec = null;
    if (wsId !== undefined && wsId !== null && String(wsId).trim() !== '') {
      wrec = (await store.all()).workspaces?.[String(wsId)] ?? null;
    } else if (typeof args?.cwd === 'string' && args.cwd.trim() !== '') {
      const canonical = confineToRoot(memberRoot, args.cwd);
      wrec = canonical ? await workspaceByPath(store, canonical) : null;
    }
    return wrec ? workspaceDefaultSessionReaders(wrec, creator) : null;
  }

  /**
   * 对成员请求做路径围栏:返回 {deny, reason?, changed?}。
   * 第二参直接是 wire args(envelope.payload.args,typert 命名参数),越界时
   * 原地改写 args;changed=true 时调用方把 envelope 重序列化回 bodyBuf 再分发。
   * directoryPicker/list 的越界/缺省是"静默钳制"(浏览体验只见围栏根),
   * 其余端点越界一律拒绝。异步:session/create 需查旁车工作区归属。
   * P10:非管理员成员的**文件访问**围栏从 memberRoot 收窄为「个人根
   * memberRoot/<user>」——浏览/建目录/新建工作区只落在自己主工作区下;
   * 共享他人工作区中的新建会话按 workspaceCreatable 放行。
   */
  async function confineMemberPayload(method, args, principal) {
    if (!memberRoot) {
      return MEMBER_PATH_CONFINED.has(method) ? { deny: true, reason: 'admin-only' } : { deny: false };
    }
    switch (method) {
      case 'workspace/create': {
        // P10:只允许在本人主工作区下新建工作区
        const personalRoot = await personalRootOf(principal.user);
        if (!personalRoot) return { deny: true, reason: 'path-outside-root' };
        const confined = confineToRoot(personalRoot, String(args?.path ?? ''));
        if (!confined) return { deny: true, reason: 'path-outside-root' };
        args.path = confined;
        return { deny: false, changed: true };
      }
      case 'directoryPicker/createDirectory': {
        const seg = safeSegment(args?.name);
        if (!seg) return { deny: false }; // 非法段名交上游 schema 报错
        const hasBase = typeof args?.path === 'string' && args.path.trim() !== '';
        const personalRoot = await personalRootOf(principal.user);
        // P13:建目录请求落在本人可新建会话的共享工作区内 → 放开到该工作区根
        const wsRoot = hasBase ? await creatableWorkspaceRootFor(principal, args.path) : null;
        const root = wsRoot ?? personalRoot;
        if (!root) return { deny: true, reason: 'path-outside-root' };
        // 共享工作区根内 → 钳到工作区根;无工作区命中 → 原样交给个人根判定
        const baseDir = hasBase
          ? (wsRoot ? confineToRoot(wsRoot, args.path) : args.path)
          : root;
        const target = confineToRoot(root, pathResolve(baseDir, seg));
        if (!target) return { deny: true, reason: 'path-outside-root' };
        args.path = pathDirname(target);
        args.name = basename(target);
        return { deny: false, changed: true };
      }
      case 'directoryPicker/list': {
        const personalRoot = await personalRootOf(principal.user);
        const requested = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path : null;
        // P13:浏览请求落在本人可新建会话的共享工作区内 → 放开到该工作区根
        const wsRoot = requested ? await creatableWorkspaceRootFor(principal, requested) : null;
        const root = wsRoot ?? personalRoot;
        if (!root) return { deny: true, reason: 'path-outside-root' };
        const confined = requested ? confineToRoot(root, requested) : null;
        if (!confined || confined !== requested) {
          args.path = confined ?? root;
          return { deny: false, changed: true };
        }
        return { deny: false };
      }
      case 'session/create': {
        // 显式 cwd 与工作区同一围栏;缺省 cwd 时仍要查 workspaceId 归属——
        // 上游会把会话 cwd 对齐到目标工作区 path,不查就等于让成员经他人/存量
        // 工作区把 cwd 换到围栏外(工作区 owner 仅在 workspace.create 成功后登记)。
        // P9:围栏扩展到「owner 或共享用户」——共享用户可在共享工作区新建会话;
        // 仅被共享了会话但工作区未共享的用户(右侧栏可见该工作区)不是 owner/共享
        // 用户,不能经 workspaceId 或 cwd 在该工作区新增会话(requirement 5)。
        // P10:cwd 若指向某已登记工作区 → 按 workspaceCreatable 放行(共享用户可在
        // 共享工作区新建会话,哪怕 cwd 在本人根之外);否则收窄到本人根。
        if (typeof args?.cwd === 'string' && args.cwd.trim() !== '') {
          const cwdUnderRoot = confineToRoot(memberRoot, args.cwd);
          if (!cwdUnderRoot) return { deny: true, reason: 'path-outside-root' };
          const target = await workspaceByPath(store, cwdUnderRoot);
          if (target) {
            if (!workspaceCreatable(target, principal.user)) {
              return { deny: true, reason: 'workspace-not-shared' };
            }
            if (cwdUnderRoot !== args.cwd) {
              args.cwd = cwdUnderRoot;
              return { deny: false, changed: true };
            }
            return { deny: false };
          }
          const personalRoot = await personalRootOf(principal.user);
          const confined = personalRoot ? confineToRoot(personalRoot, args.cwd) : null;
          if (!confined) return { deny: true, reason: 'path-outside-root' };
          if (confined !== args.cwd) {
            args.cwd = confined;
            return { deny: false, changed: true };
          }
          return { deny: false };
        }
        const wsId = args?.workspaceId;
        if (wsId !== undefined && wsId !== null && String(wsId).trim() !== '') {
          const wrec = (await store.all()).workspaces?.[String(wsId)];
          if (!workspaceCreatable(wrec, principal.user)) return { deny: true, reason: 'workspace-not-shared' };
        }
        return { deny: false };
      }
      default:
        return { deny: false };
    }
  }

  //#endregion

  //#region respond 硬化:rpcId → sessionId 索引(P3)

  // filterFrame 放行的帧若同时携带 rpcId 与 sessionId(question/approval 等
// ask 类帧),记入索引;/api/respond 影子路由据此做归属校验。
  // 容量 FIFO 上限 + TTL 清理,防长驻进程内存膨胀。
  const RPC_TTL_MS = 24 * 60 * 60 * 1000;
  const RPC_CAP = 4096;
  const rpcIndex = new Map();

  function noteRpc(rpcId, sessionId) {
    if (typeof rpcId !== 'string' || typeof sessionId !== 'string') return;
    const now = Date.now();
    if (rpcIndex.size >= RPC_CAP) {
      // 先清过期,仍超限再淘汰最旧
      for (const [k, v] of rpcIndex) {
        if (now - v.seenAt > RPC_TTL_MS) rpcIndex.delete(k);
      }
      while (rpcIndex.size >= RPC_CAP) {
        rpcIndex.delete(rpcIndex.keys().next().value);
      }
    }
    rpcIndex.set(rpcId, { sessionId, seenAt: now });
  }

  //#endregion

  //#region principal & policy

  /** 恒定时间比较共享密钥;长度不等直接拒(非字符串输入先换成哨兵,保证比较本身不抛错)。 */
  function secretMatches(presented) {
    const want = Buffer.from(config.sharedSecret, 'utf8');
    const got = Buffer.from(typeof presented === 'string' ? presented : '\0invalid', 'utf8');
    return want.length === got.length && timingSafeEqual(want, got);
  }

  function principalOf(req) {
    const presented = req.headers['x-dsh-tenancy-key'];
    // 配了密钥就必须带对:缺失不再等价于"可信本机"(否则抹掉该头即得 local admin),
    // 也不能只比不匹配的情况(带错/不带的响应差会被当作密钥存在性预言机探测)。
    if (config.sharedSecret && !secretMatches(presented)) return null;
    const user = req.headers[config.identityHeader];
    if (user) {
      const groups = String(req.headers[config.groupsHeader] ?? '')
        .split(',').map((g) => g.trim()).filter(Boolean);
      return { user: String(user).trim(), groups, source: 'proxy' };
    }
    // SSH 隧道直连 loopback:无注入头 → local 主体(默认等同 admin)。
    return {
      user: config.localPrincipal,
      groups: config.localIsAdmin ? [...adminSet] : [],
      source: 'local'
    };
  }

  const isAdminOf = (p) => p.groups.some((g) => adminSet.has(g));

  /** 事件帧钩子用的轻量判定(同步;读 store 的同步视图,见 AclStore.viewSync)。
   * 以完整 principal 判定:admin 按组放行(此前以用户名比对组名,管理员会误丢帧);
   * 无 ACL 记录的存量/恢复会话对非 admin fail-closed(可经 claim/共享补记录)。
   * P7 修复:落盘缺记录时兜底 pendingSessions——否则新会话首条 prompt 前,
   * 创建者自己的会话事件帧(标题更新、订阅态等)会被整帧丢弃。 */
  const canSeeUser = (principal, sessionId) => {
    if (!sessionId) return true;
    if (isAdminOf(principal)) return true;
    const key = String(sessionId);
    const rec = store.viewSync().sessions[key] ?? pendingSessions.get(key);
    if (!rec) return false;
    return recordReadable(rec, principal.user);
  };

  /**
   * 帧过滤(dsh 0.1.2:/api/remote.mux 的下行 item 值):返回原值(放行)、
   * null(丢弃)或克隆后的裁剪值(绝不原地改——同一广播推给所有连接)。
   * 三类通道:
   *   · $events:emit 广播帧(api-session/* 等)与 waterfall ask 帧
   *     (approval/request、user-questions/request,以 agentId=会话 id 归属);
   *   · workspace/follow:baseline/upsert/remove/order/archived 工作区视图帧;
   *   · session/control:baseline(queues/jobs/projections 按 agentId 键控)+
   *     queue/jobs/projection 增量帧(均带 sessionId)。
   * 其余流(session/follow)的帧是单一会话内容,已在流开闸处门控,不再逐帧过滤。
   */
  const filterEvent = (principal, endpoint, value) => {
    if (principal === null) return null; // 密钥错误的升级连接:全帧丢弃
    if (value == null || typeof value !== 'object') return value;
    if (isAdminOf(principal)) return value;
    if (endpoint === 'workspace/follow') return filterWorkspaceFollow(principal, value);
    if (endpoint === 'session/control') return filterControlFrame(principal, value);
    if (value.type === 'waterfall') {
      // ask 帧归属 = agentId(dsh 中 agent 身份即会话 id);无法归属时成员侧 fail-closed。
      const sid = value.agentId != null && value.agentId !== '' ? String(value.agentId) : null;
      if (!sid || !canSeeUser(principal, sid)) return null;
      // eventId 入索引:供 /api/$events/result 门做归属校验(取代 P3 的 rpcId 索引)
      if (typeof value.eventId === 'string') noteRpc(value.eventId, sid);
      return value;
    }
    if (value.type === 'emit') {
      const sid = sessionIdFromEventArgs(value);
      if (sid && !canSeeUser(principal, sid)) return null;
      return value;
    }
    return value;
  };

  /** api-session/* 广播帧的会话身份:args[0] 为会话 id 字符串或摘要对象(含 sessionId/id)。 */
  function sessionIdFromEventArgs(value) {
    const args = Array.isArray(value.args) ? value.args : [];
    for (const arg of args) {
      if (typeof arg === 'string' && arg !== '') return arg;
      if (arg != null && typeof arg === 'object') {
        const sid = arg.sessionId ?? arg.id;
        if (typeof sid === 'string' && sid !== '') return sid;
      }
    }
    return null;
  }

  /**
   * workspace/follow 帧过滤(P6/P9 语义平移):成员可见某工作区 = owner / 共享用户 /
   * 该工作区存在可读会话;行内 sessionIds 收敛到可读会话;无关工作区整行丢弃。
   */
  const filterWorkspaceFollow = (principal, value) => {
    const wmap = store.viewSync().workspaces ?? {};
    const trimIds = (ids) => {
      const kept = ids.filter((id) => canSeeUser(principal, id));
      return kept.length === ids.length ? ids : kept;
    };
    const visibleRow = (ws) => {
      if (!ws || typeof ws !== 'object') return true;
      const wrec = ws.workspaceId != null ? wmap[String(ws.workspaceId)] : null;
      let hasReadableSession = false;
      for (const sid of (ws.sessionIds ?? [])) {
        if (canSeeUser(principal, sid)) { hasReadableSession = true; break; }
      }
      return workspaceVisible(wrec, hasReadableSession, principal.user);
    };
    switch (value.type) {
      case 'baseline': {
        const base = value.value;
        if (base == null || typeof base !== 'object') return value;
        const rows = Array.isArray(base.items) ? base.items : [];
        const kept = rows.filter(visibleRow).map((ws) => {
          if (!ws || typeof ws !== 'object' || !Array.isArray(ws.sessionIds)) return ws;
          const trimmed = trimIds(ws.sessionIds);
          return trimmed === ws.sessionIds ? ws : { ...ws, sessionIds: trimmed };
        });
        const archived = Array.isArray(base.archivedSessionIds) ? trimIds(base.archivedSessionIds) : base.archivedSessionIds;
        return { ...value, value: { items: kept, archivedSessionIds: archived } };
      }
      case 'upsert': {
        const ws = value.workspace;
        if (!visibleRow(ws)) return null;
        if (!ws || typeof ws !== 'object' || !Array.isArray(ws.sessionIds)) return value;
        const trimmed = trimIds(ws.sessionIds);
        return trimmed === ws.sessionIds ? value : { ...value, workspace: { ...ws, sessionIds: trimmed } };
      }
      case 'remove':
        if (typeof value.workspaceId !== 'string' || !workspaceVisible(wmap[value.workspaceId], false, principal.user)) return null;
        return value;
      case 'order': {
        if (!Array.isArray(value.workspaceIds)) return value;
        const keptIds = value.workspaceIds.filter((id) => workspaceVisible(wmap[String(id)], false, principal.user));
        return keptIds.length === value.workspaceIds.length ? value : { ...value, workspaceIds: keptIds };
      }
      case 'archived':
        if (!Array.isArray(value.archivedSessionIds)) return value;
        return { ...value, archivedSessionIds: trimIds(value.archivedSessionIds) };
      default:
        return value;
    }
  };

  /** session/control 帧:baseline 的 queues/jobs/projections 按 agentId(会话 id)键裁剪;增量帧按 sessionId 判定。 */
  const filterControlFrame = (principal, value) => {
    if (value.type === 'baseline') {
      const base = value.value;
      if (base == null || typeof base !== 'object') return value;
      const keepKeys = (record) => {
        if (record == null || typeof record !== 'object') return record;
        const out = {}; let changed = false;
        for (const [key, item] of Object.entries(record)) {
          if (canSeeUser(principal, key)) out[key] = item;
          else changed = true;
        }
        return changed ? out : record;
      };
      return {
        ...value,
        value: {
          queues: keepKeys(base.queues),
          jobs: keepKeys(base.jobs),
          projections: keepKeys(base.projections)
        }
      };
    }
    const sid = value.sessionId ?? value.agentId;
    if (typeof sid === 'string' && sid !== '' && !canSeeUser(principal, sid)) return null;
    return value;
  };

  /**
   * 流开闸(dsh 0.1.2:/api/remote.mux 的 open 分发):返回 false 拒绝开流
   * (网关补丁向该 streamId 回 error 帧)。同步判定(读 store 同步视图)。
   *   · $events / workspace/follow / session/control:放行,逐帧过滤兜底;
   *   · session/follow(含 subagent address):按地址会话可读性门控;
   *   · 其余/未知流端点:成员 fail-closed(admin 放行)。
   */
  const gateStream = (principal, endpoint, payload) => {
    try {
      if (principal === null) return false; // 密钥错误的升级连接:一律拒绝
      if (isAdminOf(principal)) return true;
      if (endpoint === '$events' || endpoint === 'workspace/follow' || endpoint === 'session/control') return true;
      if (endpoint === 'session/follow') {
        const sid = sessionIdOf(payload);
        return sid ? canSeeUser(principal, sid) : false;
      }
      return false;
    } catch {
      return false;
    }
  };

  async function readable(p, sessionId) {
    if (!sessionId) return true;
    if (isAdminOf(p)) return true;
    // P7 修复:先查已落盘记录,再兜底 pendingSessions(尚未首 prompt 的新会话)。
    // 缺这层兜底时,创建者自己的 session.history / session.models 在首条消息前
    // 会 403(客户端表现为历史报错、模型选择器永停在「正在刷新模型列表…」)。
    const rec = (await store.all()).sessions[sessionId] ?? pendingSessions.get(sessionId);
    if (!rec) return false; // 无记录且不在 pending(存量/重启丢失):P1 提供 claim 前 admin-only
    return recordReadable(rec, p.user);
  }

  async function writable(p, sessionId) {
    if (!sessionId) return true;
    if (isAdminOf(p)) return true;
    const rec = (await store.all()).sessions[sessionId] ?? pendingSessions.get(sessionId);
    if (!rec) return false;
    return recordWritable(rec, p.user);
  }

  //#endregion

  //#region request/response plumbing

  /**
   * browser-trust 围栏(来源可信判定)本体在 util.js(便于离线自测):
   * exact 影子路由优先级高于核心的 /api 前缀路由,被接管的 37 个方法 + /api/respond
   * + session.export + /tenancy/* + /register **永不经过核心那道围栏**,因此本插件
   * 必须自己卡住 DNS rebinding(Host 伪造成攻击者域名)与跨站请求。
   */
  function trustedApiRequest(req) {
    return isTrustedApiRequest(req.headers, trustedHostSet);
  }

  /** 拒绝不具备可信来源的请求(未通过 browser-trust 围栏)。 */
  function denyUntrusted(res) {
    return deny(res, 403, 'tenancy: untrusted request origin');
  }

  async function readBody(req) {
    // 幂等缓存:$events/result 硬化路径先读 body 解析 eventId、随后再读一次分发,
    // 流式读取不缓存会导致第二次读到空流,上游解析失败,弹窗点击无反应。
    if (req.__tenancyBody) return req.__tenancyBody;
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > TENANCY_MAX_BODY_BYTES) throw new Error('body too large');
      chunks.push(chunk);
    }
    req.__tenancyBody = Buffer.concat(chunks);
    return req.__tenancyBody;
  }

  /** res 关闭时中止上游分发(node ServerResponse;自测桩等无 .on 时返回永不中止的信号)。 */
  function abortSignalFor(res) {
    try {
      if (typeof res?.on !== 'function') return undefined;
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      return ac.signal;
    } catch {
      return undefined;
    }
  }

  /**
   * 经核心 connection 服务把请求转发回宿主 /api 分发链(dsh 0.1.2 起
   * apiProxy/toFetchHandler 已移除;client-connection 的 HostConnectionService
   * 暴露 createSharedFetchHandler('/api'),exact fetch 路由(session.export 等)
   * 与 gateway 拦截器(typert RPC)都经它命中——与核心 /api 前缀完全同一分发语义)。
   * 返回 fetch Response;connection 未就绪时返回 undefined。
   */
  async function forwardToApi(req, bodyBuf, signal) {
    const connection = ctx.get('connection');
    const handler = typeof connection?.createSharedFetchHandler === 'function'
      ? connection.createSharedFetchHandler('/api')
      : null;
    if (!handler?.fetch) return undefined;
    const headers = { ...req.headers };
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    delete headers['connection'];
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(`http://tenancy.internal${req.url}`, {
      method: req.method,
      headers,
      body: hasBody ? bodyBuf : undefined,
      duplex: hasBody ? 'half' : undefined,
      ...(signal ? { signal } : {})
    });
    return handler.fetch(request);
  }

  function sendJson(res, status, buf, contentType = 'application/json') {
    res.writeHead(status, { 'content-type': contentType, 'content-length': String(buf.length) });
    res.end(buf);
  }

  const jsonBuf = (obj) => Buffer.from(JSON.stringify(obj));

  /** 身份提取失败的统一响应:配了密钥 = 密钥缺失/不匹配;未配 = 匿名入口已禁用。 */
  const denyBadSecret = (res) => deny(res, 401, config.sharedSecret
    ? 'tenancy: bad proxy secret'
    : 'tenancy: anonymous access disabled');

  async function deny(res, code, message) {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(message);
  }

  //#endregion

  //#region response filtering

  /** 递归剔除不可见会话行;workspace 行额外收敛 sessionIds/archivedSessionIds。 */
  async function filterBody(method, body, p) {
    const value = body?.result?.value;

    if (LIST_FILTERED.has(method) && value != null) {
      // 实测信封:result.value = { items: [...] }(行对象含 sessionId)
      const rows = Array.isArray(value) ? value
        : Array.isArray(value.items) ? value.items : null;
      if (rows) {
        const kept = [];
        for (const row of rows) {
          const sid = typeof row === 'string' ? row : row?.sessionId;
          if (sid === undefined || sid === null) { kept.push(row); continue; }
          if (await readable(p, sid)) kept.push(row); // await:readable 异步判定
        }
        if (Array.isArray(value)) body.result.value = kept;
        else body.result.value.items = kept;
      }
      return body;
    }

    if (method === 'workspace.list' && value != null) {
      // 实测信封:result.value = { items: [...], archivedSessionIds: [...] }
      const lists = Array.isArray(value) ? value
        : [value.items, value.workspaces, value.rows].find(Array.isArray) ?? [];
      const wmap = (await store.all()).workspaces ?? {};
      const kept = [];
      for (const ws of lists) {
        if (!ws || typeof ws !== 'object') { kept.push(ws); continue; }
        // P9:成员可见 = owner / 共享用户 / 工作区内存在可读会话;
        // 无记录的存量工作区 fail-closed。仅共享会话但未共享工作区时,
        // 用户仍能看到该工作区名与那他可读的会话(requirement 5)。
        const wrec = ws.workspaceId != null ? wmap[String(ws.workspaceId)] : null;
        let hasReadableSession = false;
        const allSids = [...(ws.sessionIds ?? []), ...(ws.archivedSessionIds ?? [])];
        for (const sid of allSids) { if (await readable(p, sid)) { hasReadableSession = true; break; } }
        if (!isAdminOf(p) && !workspaceVisible(wrec, hasReadableSession, p.user)) continue;
        for (const key of ['sessionIds', 'archivedSessionIds']) {
          if (Array.isArray(ws[key])) {
            const filtered = [];
            for (const sid of ws[key]) if (await readable(p, sid)) filtered.push(sid);
            ws[key] = filtered;
          }
        }
        const remaining = [...(ws.sessionIds ?? []), ...(ws.archivedSessionIds ?? [])];
        // hideEmptyWorkspaces 只影响 admin 视角;己有工作区即使为空也保留
        if (!(isAdminOf(p) && config.hideEmptyWorkspaces && remaining.length === 0)) kept.push(ws);
      }
      if (Array.isArray(value)) body.result.value = kept;
      else if (Array.isArray(value.items)) body.result.value.items = kept;
      else if (Array.isArray(value.workspaces)) body.result.value.workspaces = kept;
      else if (Array.isArray(value.rows)) body.result.value.rows = kept;
    }
    return body;
  }

  //#endregion

  //#region gated handler

  async function gatedHandler(method, req, res) {
    try {
      res.setHeader('x-tenancy-gate', method);
      if (!trustedApiRequest(req)) {
        audit.record({ actor: '?', action: 'gate.deny', target: method, decision: 403, reason: 'untrusted-origin' });
        return denyUntrusted(res);
      }
      const principal = principalOf(req);
      if (!principal) {
        audit.record({ actor: req.headers[config.identityHeader] ?? '?', action: 'gate.deny', target: method, decision: 401, reason: 'bad-secret' });
        return denyBadSecret(res);
      }
      if (ADMIN_ONLY.has(method) && !isAdminOf(principal)) {
        audit.record({ actor: principal.user, action: 'gate.deny', target: method, decision: 403, reason: 'admin-only' });
        return deny(res, 403, 'tenancy: admin only');
      }

      let bodyBuf = await readBody(req);
      let envelope = null;
      try {
        envelope = JSON.parse(bodyBuf.toString('utf8') || '{}');
        envelope.payload = envelope.payload ?? {};
        if (envelope.payload.args == null || typeof envelope.payload.args !== 'object') envelope.payload.args = {};
      } catch { /* schema 校验交给上游 */ }
      const args = envelope?.payload?.args ?? {};

      // P4:成员路径围栏(分发前重写或拒绝)
      if (!isAdminOf(principal) && envelope) {
        const verdict = await confineMemberPayload(method, args, principal);
        if (verdict.deny) {
          audit.record({ actor: principal.user, action: 'gate.deny', target: method, decision: 403, reason: verdict.reason ?? 'confined' });
          if (verdict.reason === 'admin-only') return deny(res, 403, 'tenancy: admin only');
          if (verdict.reason === 'workspace-not-shared') return deny(res, 403, 'tenancy: workspace not shared with you');
          // 不回显围栏根绝对路径(会泄露部署布局/home 形状)
          return deny(res, 403, 'tenancy: path outside workspace root');
        }
        if (verdict.changed) {
          envelope.payload.args = args;
          bodyBuf = Buffer.from(JSON.stringify(envelope));
        }
      }

      const sid = sessionIdOf(envelope?.payload);

      // P7:延迟 ACL 登记——session/create 时不写 acl.json,首次 session/prompt
      // (真实对话开始)时才落盘。此处同时处理恢复路径(插件重启后 pending 表丢失,
      // 但会话已在上游创建且已有 sid,需按当前 principal 补登记)。
      if (method === 'session/prompt' && sid) {
        const pending = pendingSessions.get(sid);
        if (pending) {
          await store.mutate((db) => {
            if (!db.sessions[sid]) {
              db.sessions[sid] = pending;
            }
          });
          pendingSessions.delete(sid);
          audit.record({ actor: principal.user, action: 'acl.register', sessionId: sid, mode: pending.mode, via: 'session/prompt' });
        } else {
          // 恢复:不在 pending 表(插件重启/升级前创建)→ 按当前 principal 补登记
          const existing = (await store.all()).sessions[sid];
          if (!existing) {
            await store.mutate((db) => {
              if (!db.sessions[sid]) {
                db.sessions[sid] = {
                  owner: principal.user,
                  mode: config.defaultAccess,
                  readers: [],
                  writers: [],
                  title: '',
                  updatedBy: principal.user,
                  updatedAt: Date.now()
                };
              }
            });
            audit.record({ actor: principal.user, action: 'acl.register', sessionId: sid, mode: config.defaultAccess, via: 'session/prompt (recovery)' });
          }
        }
      }

      if (READ_BY_SESSION.has(method) && !(await readable(principal, sid))) {
        audit.record({ actor: principal.user, action: 'gate.deny', target: method, decision: 403, sessionId: sid ?? null, reason: 'not-readable' });
        return deny(res, 403, 'tenancy: session not readable');
      }
      if (WRITE_BY_SESSION.has(method) && !(await writable(principal, sid))) {
        audit.record({ actor: principal.user, action: 'gate.deny', target: method, decision: 403, sessionId: sid ?? null, reason: 'not-writable' });
        return deny(res, 403, 'tenancy: session not writable');
      }

      // 经核心 connection 共享 fetch handler 分发(dsh 0.1.2 起 apiProxy 已移除)。
      // 业务错误与核心 /api 拦截器同形:一律 HTTP 200,失败骑在 result.error 上。
      const upstream = await forwardToApi(req, bodyBuf, abortSignalFor(res));
      if (upstream === undefined) return deny(res, 503, 'tenancy: api gateway unavailable');
      const buf = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      if (!contentType.includes('json')) return sendJson(res, upstream.status, buf, contentType);
      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch { /* 透传原文 */ }
      if (body == null) return sendJson(res, upstream.status, buf, contentType);
      const result = body?.result;
      const ok = upstream.ok && result?.ok !== false;

      // P7:session/create / session/fork 成功后不立即写 ACL,而是暂存到
      // pendingSessions(纯内存),等首次 session/prompt 才落盘到 acl.json。
      // fork 子会话继承父 access:父可能也在 pending 中(尚未首 prompt),
      // 故同时查 pendingSessions 兜底。
      // P13:共享工作区中**新建**的会话(非 fork)在创建时刻捕获工作区共享用户为
      // 默认可读者——共享前已建的会话不受影响(保持私有),共享后新建的默认对
      // 参与者(owner+sharedUsers,去创建者)可读;owner 可随时经会话共享改回私有。
      if ((method === 'session/create' || method === 'session/fork') && ok) {
        const newId = result?.value?.sessionId;
        if (newId) {
          const parentRec = method === 'session/fork' && sid
            ? ((await store.all()).sessions[sid] ?? pendingSessions.get(sid))
            : null;
          const defaultReaders = parentRec ? null : await defaultSessionReadersOf(args, principal.user);
          pendingSessions.set(String(newId), {
            owner: principal.user,
            mode: parentRec?.mode ?? config.defaultAccess,
            readers: parentRec?.readers ?? defaultReaders ?? [],
            writers: parentRec?.writers ?? [],
            title: typeof args.title === 'string' ? args.title : (parentRec?.title ?? ''),
            updatedBy: principal.user,
            updatedAt: Date.now()
          });
          audit.record({ actor: principal.user, action: 'acl.pending', sessionId: String(newId), mode: parentRec?.mode ?? config.defaultAccess, via: method });
        }
      }

      // session/rename 成功后同步 title 到旁车 ACL(含 pending 与已落盘记录)。
      // args.title 是用户设定的原始标题;response.value.title 是规范化后的标题。
      if (method === 'session/rename' && ok && sid) {
        const renamedTitle = result?.value?.title ?? args?.title ?? '';
        if (typeof renamedTitle === 'string' && renamedTitle !== '') {
          const pending = pendingSessions.get(sid);
          if (pending) {
            pending.title = renamedTitle;
          } else {
            await store.mutate((db) => {
              if (db.sessions[sid]) {
                db.sessions[sid].title = renamedTitle;
                db.sessions[sid].updatedAt = Date.now();
              }
            });
          }
        }
      }

      // P6:workspace/create 成功后登记 owner(workspace.list 过滤与 WS 帧过滤的依据)。
      // create 采纳已有目录时返回已存在记录:绝不覆盖既有 owner。
      // P9:一并存 path(供 session/create 的 cwd 形式反查归属)并初始化 sharedUsers。
      if (method === 'workspace/create' && ok) {
        const wsValue = result?.value;
        const wsId = wsValue?.workspace?.workspaceId ?? wsValue?.workspaceId;
        if (wsId) {
          await store.mutate((db) => {
            if (!db.workspaces[String(wsId)]) {
              db.workspaces[String(wsId)] = {
                owner: principal.user,
                path: wsValue?.workspace?.path ?? null,
                title: wsValue?.workspace?.title ?? '',
                sharedUsers: [],
                createdAt: wsValue?.workspace?.createdAt ?? null,
                updatedAt: Date.now()
              };
            }
          });
          audit.record({ actor: principal.user, action: 'acl.register', target: 'workspace', workspaceId: String(wsId), via: method });
        }
      }
      // workspace/rename 成功后同步 title 到旁车 ACL。
      // args.title 是新标题;response.value.workspace.title 是规范化后的标题。
      if (method === 'workspace/rename' && ok) {
        const wsId = args?.workspaceId;
        const renamedTitle = result?.value?.workspace?.title ?? args?.title ?? '';
        if (wsId && typeof renamedTitle === 'string' && renamedTitle !== '') {
          await store.mutate((db) => {
            if (db.workspaces[String(wsId)]) {
              db.workspaces[String(wsId)].title = renamedTitle;
              db.workspaces[String(wsId)].updatedAt = Date.now();
            }
          });
        }
      }
      // workspace/delete 成功后清理旁车 owner 记录(保持与宿主登记一致)
      if (method === 'workspace/delete' && ok) {
        const wsId = args?.workspaceId;
        if (wsId) {
          await store.mutate((db) => { delete db.workspaces[String(wsId)]; });
          audit.record({ actor: principal.user, action: 'acl.unregister', target: 'workspace', workspaceId: String(wsId), via: method });
        }
      }

      if (LIST_FILTERED.has(method) || method === 'workspace/list') {
        await filterBody(method, body, principal);
        return sendJson(res, 200, jsonBuf(body));
      }
      // P4:成员目录浏览响应里的 home 指向宿主真实 HOME,会诱导 UI 跳出围栏根——改写为根
      // P10:改写为成员个人根(~/dsh/<user>),而非整个 memberRoot。
      // P13:若本次浏览落在本人可新建会话的共享工作区内,home 指向该工作区根
      // (否则 UI 文件面板会跳回个人根,与列表路径错位)。
      if (method === 'directoryPicker/list' && !isAdminOf(principal)
        && memberRoot && typeof body?.result?.value?.home === 'string') {
        const wsRoot = typeof args.path === 'string'
          ? await creatableWorkspaceRootFor(principal, args.path) : null;
        const personalRoot = await personalRootOf(principal.user);
        body.result.value.home = wsRoot ?? personalRoot ?? memberRoot;
        return sendJson(res, 200, jsonBuf(body));
      }
      return sendJson(res, 200, jsonBuf(body));
    } catch (error) {
      ctx.logger?.error?.(`tenancy: ${method} gate failure: ${error?.stack ?? error}`);
      return deny(res, 500, 'tenancy: internal error');
    }
  }

  //#endregion

  //#region /tenancy management prefix

  async function adminRoutes(req, res) {
    try {
      if (!trustedApiRequest(req)) return denyUntrusted(res);
      const principal = principalOf(req);
      if (!principal) return denyBadSecret(res);
      const url = new URL(req.url, 'http://tenancy.internal');
      const path = url.pathname.replace(/^\/tenancy/, '') || '/';
      const admin = isAdminOf(principal);

      if (req.method === 'GET' && path === '/whoami') {
        return sendJson(res, 200, jsonBuf({ ...principal, admin }));
      }

      if (req.method === 'GET' && (path === '/sessions' || path === '/unclaimed')) {
        const { sessions } = await store.all();
        // P7 修复:合并内存 pending 会话(未首 prompt;同 id 以落盘记录为准),
        // 与 readable() 的 pending 兜底保持同一可见性,避免「能打开却不在列表」。
        const merged = { ...Object.fromEntries(pendingSessions), ...sessions };
        const entries = Object.entries(merged)
          .filter(([, rec]) => admin || rec.owner === principal.user)
          .map(([id, rec]) => ({ sessionId: id, ...rec }));
        return sendJson(res, 200, jsonBuf({ sessions: entries }));
      }

      // P8/P9:工作区 owner 一览(用户中心「工作区管理」;admin 全量,成员本人 +
      // 被共享的工作区)。附 sharedUsers 供共享管理 UI 展示。
      if (req.method === 'GET' && path === '/workspaces') {
        const { workspaces } = await store.all();
        const entries = Object.entries(workspaces ?? {})
          .filter(([, rec]) => admin || rec.owner === principal.user
            || workspaceSharedUsers(rec).includes(principal.user))
          .map(([wsId, rec]) => ({
            workspaceId: wsId,
            owner: rec.owner,
            path: rec.path ?? null,
            title: rec.title ?? '',
            sharedUsers: workspaceSharedUsers(rec),
            createdAt: rec.createdAt ?? null,
            updatedAt: rec.updatedAt ?? null
          }));
        return sendJson(res, 200, jsonBuf({ ok: true, workspaces: entries }));
      }

      // P9:工作区共享管理——owner/admin 可读、可增删 sharedUsers(更新工作区共享用户)。
      // GET 展示当前共享表;POST 以 { sharedUsers: [...] } 全量覆盖。
      if (req.method === 'GET' && path.startsWith('/workspaces/') && path.endsWith('/share')) {
        const id = safeDecode(path.split('/')[2] ?? '');
        if (id === null) return deny(res, 400, 'tenancy: malformed workspace id');
        const rec = (await store.all()).workspaces?.[id];
        if (!rec) return deny(res, 404, 'tenancy: unknown workspace');
        if (!admin && rec.owner !== principal.user) return deny(res, 403, 'tenancy: owner or admin only');
        return sendJson(res, 200, jsonBuf({ ok: true, workspaceId: id, owner: rec.owner, title: rec.title ?? '', sharedUsers: workspaceSharedUsers(rec) }));
      }

      if (req.method === 'POST' && path.startsWith('/workspaces/') && path.endsWith('/share')) {
        const id = safeDecode(path.split('/')[2] ?? '');
        if (id === null) return deny(res, 400, 'tenancy: malformed workspace id');
        const rec = (await store.all()).workspaces?.[id];
        if (!rec) return deny(res, 404, 'tenancy: unknown workspace');
        if (!admin && rec.owner !== principal.user) return deny(res, 403, 'tenancy: owner or admin only');
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const raw = Array.isArray(body.sharedUsers) ? body.sharedUsers : [];
        // 共享用户归一:去空白、去空、去重;禁止把自己设为共享用户(owner 恒等于全权)
        const sharedUsers = [...new Set(raw.map((u) => String(u).trim()).filter(Boolean))]
          .filter((u) => u !== rec.owner);
        await store.mutate((db) => {
          if (!db.workspaces[id]) return;
          db.workspaces[id].sharedUsers = sharedUsers;
          db.workspaces[id].updatedAt = Date.now();
        });
        audit.record({ actor: principal.user, action: 'workspace.share.set', workspaceId: id, sharedUsers });
        return sendJson(res, 200, jsonBuf({ ok: true, workspaceId: id, sharedUsers }));
      }

      if (req.method === 'GET' && path.startsWith('/sessions/') && path.endsWith('/acl')) {
        // ACL 详情:可读即可见(owner/admin/被分享者)——供 UI 徽章与共享对话框
        const id = safeDecode(path.split('/')[2] ?? '');
        if (id === null) return deny(res, 400, 'tenancy: malformed session id');
        if (!(await readable(principal, id))) {
          audit.record({ actor: principal.user, action: 'acl.deny', target: 'get', sessionId: id || null, decision: 403 });
          return deny(res, 403, 'tenancy: session not readable');
        }
        // P7 修复:pending 记录同形可读回(共享对话框徽章在首 prompt 前也有真实状态)。
        const rec = (await store.all()).sessions[id] ?? pendingSessions.get(id);
        return sendJson(res, rec ? 200 : 404, jsonBuf(rec ?? { error: 'no-acl-record' }));
      }

      if (req.method === 'POST' && path.startsWith('/sessions/') && path.endsWith('/acl')) {
        // P3:owner 本人或 admin 可改自己会话的 ACL(共享对话框);他人拒绝
        const id = safeDecode(path.split('/')[2] ?? '');
        if (id === null) return deny(res, 400, 'tenancy: malformed session id');
        // P7 修复:owner 判定与保留字段都先查落盘、再兜底 pending——
        // 新建未发消息的会话也能打开共享(显式落盘,写后 pending 影子即删)。
        const rec = (await store.all()).sessions[id] ?? pendingSessions.get(id);
        const isOwner = rec?.owner === principal.user;
        if (!admin && !isOwner) {
          audit.record({ actor: principal.user, action: 'acl.deny', target: 'set', sessionId: id || null, decision: 403 });
          return deny(res, 403, 'tenancy: owner or admin only');
        }
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        await store.mutate((db) => {
          const base = db.sessions[id] ?? pendingSessions.get(id);
          db.sessions[id] = {
            owner: body.owner ?? base?.owner ?? principal.user,
            mode: body.mode ?? base?.mode ?? config.defaultAccess,
            readers: body.readers ?? base?.readers ?? [],
            writers: body.writers ?? base?.writers ?? [],
            title: base?.title ?? '',
            updatedBy: principal.user, updatedAt: Date.now()
          };
        });
        pendingSessions.delete(id);
        const after = (await store.all()).sessions[id];
        audit.record({ actor: principal.user, action: 'acl.set', sessionId: id, owner: after.owner, mode: after.mode, readers: after.readers, writers: after.writers });
        return sendJson(res, 200, jsonBuf({ ok: true }));
      }

      // P4:邀请码管理(admin-only;GET 需显式判权,POST 由下方统一闸门兜底)
      if (req.method === 'GET' && path === '/invites') {
        if (!admin) return deny(res, 403, 'tenancy: admin only');
        return sendJson(res, 200, jsonBuf({ ok: true, invites: await invites.list() }));
      }

      // P8:修改密码(用户中心)——仅代理身份(Remote-User 注入的登录用户);
      // local 主体(SSH 直连)没有 users.yml 条目,直接拒绝。
      // 必须放在下方「POST 非 admin 一律 403」闸门之前:成员也要能改自己的密码。
      if (req.method === 'POST' && path === '/password') {
        if (principal.source !== 'proxy') return deny(res, 403, 'tenancy: password change requires proxy identity');
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const outcome = await changeUserPassword({
          store: invites, audit,
          autheliaUsersPath: config.autheliaUsersPath,
          autheliaBin: config.autheliaBin,
          actorHint: 'user-center'
        }, {
          username: principal.user,
          currentPassword: body.currentPassword,
          newPassword: body.newPassword
        });
        if (!outcome.ok) {
          const code = ['current-password-wrong', 'current-password-required', 'password-weak'].includes(outcome.error) ? 400 : 500;
          return deny(res, code, 'tenancy: ' + outcome.error);
        }
        return sendJson(res, 200, jsonBuf({ ok: true }));
      }

      if (req.method === 'POST' && !admin) return deny(res, 403, 'tenancy: admin only');

      // P12:手动补建/修复系统用户 + 个人目录归属(admin-only)。覆盖两类场景:
      //   ① 功能启用前注册的存量成员(账号/归属缺失);
      //   ② 当年注册时建号失败的重放。
      // 幂等;同名既有账号 home/shell 不符(acct=null,conflict)时返回 409 不动文件。
      if (req.method === 'POST' && path === '/sysuser') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const username = String(body.username ?? '').trim();
        const invalid = checkUsername(username);
        if (invalid) return deny(res, 400, 'tenancy: ' + invalid);
        const account = await provisionSystemUser(username);
        if (!account) {
          return deny(res, 409, 'tenancy: sysuser 不可用或与既有系统账号冲突(原因见 audit.log 与进程日志)');
        }
        const workspace = await createPersonalWorkspace(username, account);
        audit.record({ actor: principal.user, action: 'sysuser.ensure', target: username, status: account.status, uid: account.uid });
        return sendJson(res, 200, jsonBuf({ ok: true, username, account, workspace }));
      }

      if (req.method === 'POST' && path === '/invites') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const count = Math.max(1, Math.min(20, Number(body.count) || 1));
        const note = typeof body.note === 'string' ? body.note.slice(0, 120) : '';
        const created = await invites.create(count, principal.user, note);
        audit.record({ actor: principal.user, action: 'invite.create', count });
        return sendJson(res, 200, jsonBuf({ ok: true, invites: created }));
      }

      if (req.method === 'POST' && path === '/invites/revoke') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const id = String(body.id ?? '');
        const done = await invites.revoke(id);
        audit.record({ actor: principal.user, action: done ? 'invite.revoke' : 'invite.revoke-miss', inviteId: id || null });
        return sendJson(res, 200, jsonBuf({ ok: done }));
      }

      if (req.method === 'POST' && path === '/claim') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const ids = body.sessionIds ?? [];
        const owner = body.owner ?? principal.user;
        await store.mutate((db) => {
          for (const id of ids) {
            db.sessions[id] = {
              mode: config.defaultAccess, readers: [], writers: [], title: '',
              ...db.sessions[id],
              owner, updatedBy: principal.user, updatedAt: Date.now()
            };
          }
        });
        audit.record({ actor: principal.user, action: 'acl.claim', owner, count: ids.length });
        return sendJson(res, 200, jsonBuf({ ok: true, claimed: ids.length, owner }));
      }

      // P9:重启 dsh-web(经 pm2)——admin-only;先回响应再触发重启,避免客户端卡顿。
      if (req.method === 'POST' && path === '/restart') {
        audit.record({ actor: principal.user, action: 'restart.request', target: 'dsh-web' });
        // 先发响应,再异步触发 pm2 restart(进程随后被回收,此处不再写更多日志)
        sendJson(res, 200, jsonBuf({ ok: true, message: 'restart initiated' }));
        setImmediate(() => {
          execFile('/bin/sh', ['-c', 'pm2 restart dsh-web'], { timeout: 30_000 }, (error, stdout, stderr) => {
            // 进程即将被 pm2 回收,此处仅尽力打日志;stdout/stderr 落盘供排错
            if (error) ctx.logger?.error?.(`tenancy: pm2 restart failed: ${error.message}`);
            else ctx.logger?.info?.(`tenancy: pm2 restart dsh-web triggered`);
          });
        });
        return;
      }

      return deny(res, 404, 'tenancy: unknown route');
    } catch (error) {
      ctx.logger?.error?.(`tenancy: admin route failure: ${error?.stack ?? error}`);
      return deny(res, 500, 'tenancy: internal error');
    }
  }

  //#endregion

  //#region P7:无对话会话扫盘清理(1 天前 + 无对话 → 删文件夹)

  /** 会话根目录($DSH_HOME/sessions,与 dsh-session-persistence-jsonl 同源)。 */
  const sessionRoot = `${resolveDshHome()}/sessions`;
  /** 清理间隔(6 小时)。 */
  const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
  /** 无对话会话最大存活时间(1 天)。 */
  const CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  /** 清理并发锁,避免重叠执行。 */
  let cleanupRunning = false;

  /**
   * 检查指定会话目录是否包含真实对话。
   * 会话文件可能是 session.jsonl.zstd(zstd 压缩,当前格式)或
   * session.jsonl(未压缩,历史格式)。只有 header 行(≤1 行)视为无对话。
   * ★ 修复:此前只查 session.jsonl,而实际磁盘格式是 .zstd,
   *   readFile 永远 ENOENT 被空 catch 吞掉 → 所有会话都被误删。
   */
  async function hasConversationIn(sessionPath) {
    const { readFile, stat } = await import('node:fs/promises');
    const { join } = await import('node:path');

    // 优先查当前格式 .zstd,回退历史格式 .jsonl
    for (const fname of ['session.jsonl.zstd', 'session.jsonl']) {
      const filePath = join(sessionPath, fname);
      try {
        await stat(filePath);
      } catch { continue; }

      if (fname.endsWith('.zstd')) {
        // zstd 解压后统计行数;zstd 不可用时保守放行(不删)
        return new Promise((resolve) => {
          const child = execFile('zstd', ['-c', filePath], { timeout: 30_000 }, (error, stdout) => {
            if (error) {
              ctx.logger?.warn?.(`tenancy: zstd decompress failed for ${filePath}: ${error.message}`);
              resolve(true); // 解压失败保守放行,不删会话
              return;
            }
            const lines = stdout.toString('utf8').trim().split('\n');
            resolve(lines.length > 1);
          });
          child.on('error', (e) => {
            ctx.logger?.warn?.(`tenancy: zstd not available: ${e.message}`);
            resolve(true); // 无 zstd 保守放行
          });
        });
      } else {
        const content = await readFile(filePath, 'utf8');
        const lines = content.trim().split('\n');
        return lines.length > 1;
      }
    }
    // 两种格式都没有 → 无对话(空会话/僵尸)
    return false;
  }

  /**
   * 清理 ACL 中的孤儿记录:会话目录已被删除但 ACL 仍残留。
   * 防止用户管理中显示已不存在的会话(Title 丢失 → "Untitled session")。
   */
  async function cleanupOrphanAcl(sessionRoot) {
    const { readdir, stat } = await import('node:fs/promises');
    const { join } = await import('node:path');

    // 收集磁盘上实际存在的 sessionId
    const onDisk = new Set();
    try {
      const projects = await readdir(sessionRoot);
      for (const project of projects) {
        const pp = join(sessionRoot, project);
        try { if (!(await stat(pp)).isDirectory()) continue; } catch { continue; }
        try {
          for (const sid of await readdir(pp)) {
            const sp = join(pp, sid);
            try { if ((await stat(sp)).isDirectory()) onDisk.add(sid); } catch {}
          }
        } catch {}
      }
    } catch { return; }

    // 删除 ACL 中不存在于磁盘的记录
    await store.mutate((db) => {
      let removed = 0;
      for (const sid of Object.keys(db.sessions)) {
        if (!onDisk.has(sid)) {
          delete db.sessions[sid];
          removed++;
        }
      }
      if (removed > 0) {
        audit.record({
          actor: 'system',
          action: 'acl.cleanup',
          reason: 'orphan-after-session-deleted',
          count: removed
        });
      }
    });
  }

  /**
   * 扫描 sessionRoot 下所有 project/session 目录,删除满足以下条件的会话文件夹:
   *   ① 目录 mtime 超过 1 天;
   *   ② 会话无真实对话(session.jsonl.zstd 仅有 header 行,或无该文件)。
   * 有对话(≥2 行)的会话不受影响。删除前先清理 pendingSessions 中的残留条目。
   */
  async function cleanupStaleSessions() {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
      const { readdir, stat, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');

      let projectEntries;
      try {
        projectEntries = await readdir(sessionRoot);
      } catch {
        return; // 会话根目录尚不存在(未创建过任何会话)
      }

      for (const project of projectEntries) {
        const projectPath = join(sessionRoot, project);
        let projectStat;
        try { projectStat = await stat(projectPath); } catch { continue; }
        if (!projectStat.isDirectory()) continue;

        let sessionEntries;
        try { sessionEntries = await readdir(projectPath); } catch { continue; }

        for (const sessionId of sessionEntries) {
          const sessionPath = join(projectPath, sessionId);
          let sessionStat;
          try { sessionStat = await stat(sessionPath); } catch { continue; }
          if (!sessionStat.isDirectory()) continue;

          const age = Date.now() - sessionStat.mtimeMs;
          if (age < CLEANUP_MAX_AGE_MS) continue;

          // 检查是否有真实对话(支持 .zstd 压缩格式与历史 .jsonl 格式)
          if (await hasConversationIn(sessionPath)) continue;

          // 清理 pending 表中的残留条目(纯内存,不写盘)
          pendingSessions.delete(sessionId);
          await rm(sessionPath, { recursive: true, force: true });
          audit.record({
            actor: 'system',
            action: 'session.cleanup',
            sessionId,
            reason: 'stale-no-conversation',
            ageHours: Math.round(age / 1000 / 60 / 60)
          });
        }
      }

      // 清理因本次清理(或历史误删)产生的 ACL 孤儿记录
      await cleanupOrphanAcl(sessionRoot);
    } catch (error) {
      ctx.logger?.error?.(`tenancy: session cleanup failed: ${error?.stack ?? error}`);
    } finally {
      cleanupRunning = false;
    }
  }

  //#endregion

  ctx.effect(() => {
    const disposers = GATED_METHODS.map((method) => {
      try {
        return ctx.webServer.register({
          kind: 'exact',
          path: `/api/${method}`,
          handler: (req, res) => gatedHandler(method, req, res)
        });
      } catch (e) {
        console.error(`[tenancy] register failed ${method}: ${e.message}`);
        return null;
      }
    }).filter(Boolean);

    disposers.push(ctx.webServer.register({
      kind: 'exact', path: '/api/session.export',
      handler: async (req, res) => {
        if (!trustedApiRequest(req)) return denyUntrusted(res);
        const p = principalOf(req);
        if (!p) return denyBadSecret(res);
        const sid = new URL(req.url, 'http://x').searchParams.get('sessionId');
        if (!(await readable(p, sid))) return deny(res, 403, 'tenancy: session not readable');
        const upstream = await forwardToApi(req, await readBody(req), abortSignalFor(res));
        if (upstream === undefined) return deny(res, 503, 'tenancy: api gateway unavailable');
        const buf = Buffer.from(await upstream.arrayBuffer());
        return sendJson(res, upstream.status, buf,
          upstream.headers.get('content-type') ?? 'application/octet-stream');
      }
    }));

    disposers.push(ctx.webServer.register({
      kind: 'prefix', path: '/tenancy', handler: adminRoutes
    }));

    // P4:邀请码注册页(/register 公开前缀;Caddy 侧需放行该路径不走 forward_auth)
    if (config.registerEnabled) {
      disposers.push(ctx.webServer.register({
        kind: 'prefix', path: '/register',
        handler: createRegisterRoutes({
          config, store: invites, audit, logger: ctx.logger,
          // 该路径在 Caddy 侧不走 forward_auth,身份不可信,但 Host/Origin 仍要卡围栏
          isTrusted: trustedApiRequest,
          // P12:注册成功先开通同名系统用户(nologin,仅归属个人目录),再建个人工作区
          provisionSystemUser,
          // P9:注册成功后自动为其建个人工作区(~/dsh/<username>)
          createPersonalWorkspace
        })
      }));
    }

    // P3(dsh 0.1.2 版):$events/result 硬化——eventId 必须在 waterfall 事件帧索引中
    // 且会话对主体可写。eventId 为服务端铸造的 UUID,只会经 $events 流的
    // approval/request、user-questions/request waterfall 帧到达客户端;帧过滤后
    // 不可见会话的 eventId 根本不会出现在成员浏览器里,此处是纵深防御。
    // (dsh ≤0.1.1 的同位防线是 /api/respond 门。)
    if (config.hardenRespond) {
      disposers.push(ctx.webServer.register({
        kind: 'exact', path: EVENTS_RESULT_PATH,
        handler: async (req, res) => {
          try {
            if (!trustedApiRequest(req)) return denyUntrusted(res);
            const principal = principalOf(req);
            if (!principal) {
              audit.record({ actor: '?', action: 'respond.deny', decision: 401, reason: 'bad-secret' });
              return denyBadSecret(res);
            }
            let eventId = null;
            try {
              const parsed = JSON.parse((await readBody(req)).toString('utf8') || '{}');
              const raw = parsed.payload?.args ?? parsed.payload ?? {};
              eventId = typeof raw.eventId === 'string' ? raw.eventId : null;
            } catch { /* 交由上游 schema 报错 */ }
            const hit = eventId !== null ? rpcIndex.get(eventId) : undefined;
            if (!hit) {
              audit.record({ actor: principal.user, action: 'respond.deny', decision: 403, rpcId: eventId, reason: 'rpcid-unknown-or-expired' });
              return deny(res, 403, 'tenancy: unknown or expired eventId');
            }
            if (!(await writable(principal, hit.sessionId))) {
              audit.record({ actor: principal.user, action: 'respond.deny', decision: 403, rpcId: eventId, sessionId: hit.sessionId, reason: 'not-writable' });
              return deny(res, 403, 'tenancy: session not writable');
            }
            const upstream = await forwardToApi(req, await readBody(req), abortSignalFor(res));
            if (upstream === undefined) return deny(res, 503, 'tenancy: api gateway unavailable');
            const buf = Buffer.from(await upstream.arrayBuffer());
            return sendJson(res, upstream.status, buf,
              upstream.headers.get('content-type') ?? 'application/json');
          } catch (error) {
            ctx.logger?.error?.(`tenancy: respond gate failure: ${error?.stack ?? error}`);
            return deny(res, 500, 'tenancy: internal error');
          }
        }
      }));
    }

    // P2(dsh 0.1.2 版):dsh-api-gateway 补丁在 /api/remote.mux WS 升级时调用
    // principal(req) 记录主体,流开闸时调用 gateStream,下行 item 逐帧调用
    // filterEvent(均同步,见 patches/ 下的补丁)。
    globalThis.__dshTenancy = {
      version: 3,
      principal: principalOf, // (req) => principal | null;null = 密钥校验失败
      gateStream,             // (principal, endpoint, payload) => boolean(同步)
      filterEvent             // (principal, endpoint, value) => value | null(同步)
    };

    // P11:公开站点 HTTP 服务 —— 独立端口匿名静态发布,与主站 SPA/影子路由隔离。
    // 启动是异步的(listen 一次);失败只记日志,不拖垮主插件。sitesPort 暴露到
    // globalThis.__dshTenancy(自测/排障用)。teardown 先置 ctxStopped,防止 listen
    // 回调在卸载后才落地而泄漏一个关不掉的 server。
    let sitesDispose = null;
    let ctxStopped = false;
    if (publicSitesOn && memberRoot) {
      createPublicSitesServer({
        memberRoot,
        buildDir: publicBuildDir,
        host: config.publicSitesHost,
        port: config.publicSitesPort,
        hostAllowlist: Array.isArray(config.publicSitesHosts) ? config.publicSitesHosts : [],
        spaFallback: config.publicSpaFallback !== false,
        cacheControl: config.publicCacheControl || 'public, max-age=300',
        audit,
        logger: ctx.logger
      }).then((sites) => {
        if (ctxStopped) {
          sites.dispose();
          return;
        }
        sitesDispose = sites.dispose;
        globalThis.__dshTenancy.sitesPort = sites.port;
        ctx.logger?.info?.(`tenancy: 公开站点已监听 http://${config.publicSitesHost}:${sites.port} (buildDir=${publicBuildDir})`);
      }).catch((error) => {
        ctx.logger?.error?.(`tenancy: 公开站点启动失败: ${error?.message ?? error}`);
      });
    }

    // P7:启动无对话会话扫盘清理(首次 1 分钟后执行,之后每 6 小时一次)。
    let cleanupIntervalId = null;
    const cleanupTimeoutId = setTimeout(() => {
      cleanupStaleSessions();
      cleanupIntervalId = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
    }, 60000);

    return () => {
      ctxStopped = true;
      if (sitesDispose) sitesDispose();
      clearTimeout(cleanupTimeoutId);
      if (cleanupIntervalId) clearInterval(cleanupIntervalId);
      delete globalThis.__dshTenancy;
      for (const d of disposers) d();
    };
  }, 'tenancy: shadow routes + management api');


  ctx.inject(['connection'], () => {
    ctx.logger?.info?.('tenancy: connection available — shadow routes + api gateway dispatch active');
  });
}

export default { name, inject, Config, apply };
