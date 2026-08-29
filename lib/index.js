// AI 生成声明:本插件代码由 AI 生成,可能存在错误或安全隐患,使用前请 review 并实测。
//
// 职责(单实例多租户):
//   1. 从 Caddy forward_auth 注入的头里提取已验证身份(principal);
//   2. 以 exact 影子路由接管会话类 RPC(dsh-host-webserver 中 exact 优先于
//      client-connection 的 /api 前缀),做 owner/access 判定后经
//      toFetchHandler(apiProxy) 转发(与核心 fallback 完全同一分发语义);
//   3. 对 session.list/search/workspace.list 的响应按可见性过滤;
//   4. 旁车 ACL 存储($DSH_HOME/tenancy/acl.json,原子写+文件锁)——不动会话格式,
//      因为 dsh-session 的 JSONL 头部是白名单序列化,自定义字段会被丢弃;
//   5. 暴露 globalThis.__dshTenancy 钩子,供 P2 的 client-connection 补丁在
//      WebSocket downlink pump 处过滤事件帧。
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
// 明确不做:特权方法(settings./credentials./agentPreset.read 等)不影子注册——
// 它们由核心围栏处理(团队入口 403;管理员流量经 Caddy 重写为 loopback 后放行)。
// 注:exact 影子路由优先级高于核心的 /api 前缀路由,被接管的请求不会再过核心那道
// browser-trust 围栏,因此本插件自己重写一篇同构检查(trustedApiRequest:Host 必须是
// loopback 或 `trustedHosts` 条目、Origin 同源、sec-fetch-site 非 cross-site),
// 挡 DNS rebinding 与跨站误用;身份/ACL 判定建立在这道来源可信之上。

import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy';
import { statSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { basename, dirname as pathDirname, resolve as pathResolve } from 'node:path';
import { homedir } from 'node:os';
import { AuditLog } from './audit.js';
import { InviteStore, createRegisterRoutes, changeUserPassword } from './register.js';
import { confineToRoot, expandHomeDir, isTrustedApiRequest, safeDecode, safeSegment } from './util.js';

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
  /** P4:非管理员成员的工作空间根目录(支持 ~/ 前缀)。成员的目录浏览/建目录/建工作区/会话 cwd 都被围在该目录内。空串=不启用(这些方法对成员维持 admin-only)。 */
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
  invitesPath: z.string().default('')
});

//#region tenancy settings namespace(设置 → 插件「可配置」tab 的派发账本)

/**
 * 设置页插件 tab 按「settings.describe 提供的命名空间 ∩ 卡片注册的 key」派发卡片
 * (dsh-client-ui-settings-plugins 的 ConfigurablePluginsTabController)。客户端卡片
 * 以 key 'tenancy' 注册,若宿主不 serve 同名命名空间,卡片永不显示。
 * 这里注册一个最小、无敏感字段的 'tenancy' 命名空间(sharedSecret/authelia 路径等
 * 一律不进 describe 视图),仅用于卡片派发与配置可见性。
 */
const TENANCY_NS = settingsNamespace('tenancy');

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

//#region method classification (方案 §5.4 放行矩阵)

/** 影子注册的全部方法(exact 表)。字段名已对照 api/*.schema.js 核实:全部为 sessionId。 */
export const GATED_METHODS = [
  // 会话生命周期(create 成功后登记 ACL;list/search 做可见性过滤)
  'session.create', 'session.list', 'session.search',
  // 会话读
  'session.history', 'session.models', 'session.attachment',
  'subagent.list', 'subagent.history',
  'skill.list',
  // 模型发现(★ 从 Authelia 特权通道移到 tenancy 代理:非管理员也能拿到模型列表)
  'llm.discoverModels',
  // 会话写
  'session.selectModel', 'session.rename', 'session.fork', 'session.prompt',
  'session.updateQueue', 'session.cancel',
  'subagent.prompt', 'subagent.interrupt',
  'goal.create', 'goal.edit', 'goal.pause', 'goal.resume', 'goal.complete', 'goal.clear',
  // 工作区(列表需过滤;变更 v1 收敛为 admin)
  'workspace.list',
  'workspace.create', 'workspace.rename', 'workspace.delete', 'workspace.insertBefore',
  'workspace.insertSessionBefore', 'workspace.archiveSession',
  // 主机文件浏览(★ 方案 §5.4:这两者不在核心特权表里,多租户必须收紧为 admin)
  'host.listDirectory', 'host.createDirectory'
];

/** 响应行集需要按可见性过滤的方法。 */
const LIST_FILTERED = new Set(['session.list', 'session.search']);
/** payload 里带 sessionId、要求 readable 的方法。 */
const READ_BY_SESSION = new Set([
  'session.history', 'session.models', 'session.attachment',
  'subagent.list', 'subagent.history', 'skill.list'
]);
/** payload 里带 sessionId、要求 writable 的方法。 */
const WRITE_BY_SESSION = new Set([
  'session.prompt', 'session.rename', 'session.cancel', 'session.updateQueue',
  'session.selectModel',
  'subagent.prompt', 'subagent.interrupt',
  'goal.create', 'goal.edit', 'goal.pause', 'goal.resume', 'goal.complete', 'goal.clear',
  'workspace.insertSessionBefore', 'workspace.archiveSession'
]);
/** 需 admin 主体才放行的工作区组织操作(侧栏排序/改名/删除,与文件系统路径无关)。 */
const ADMIN_ONLY = new Set([
  'workspace.rename', 'workspace.delete', 'workspace.insertBefore'
]);
/**
 * P4:成员可放行、但请求路径必须落在 memberWorkspaceRoot 内的方法。
 *   workspace.create      → payload.path(采纳已有目录为工作区)
 *   host.listDirectory    → payload.path 缺省/越界时静默钳制到根(浏览只见根内内容)
 *   host.createDirectory  → resolve(payload.path, payload.name) 越界即拒
 * memberWorkspaceRoot 为空串时不放行,回落旧的 admin-only 行为。
 */
const MEMBER_PATH_CONFINED = new Set(['workspace.create', 'host.listDirectory', 'host.createDirectory']);
/** GET /api/session.export?sessionId=… */
const SESSION_EXPORT_PATH = '/api/session.export';

function sessionIdOf(payload) {
  return payload?.sessionId ?? payload?.parentSessionId ?? null;
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
   */
  const pendingSessions = new Map();

  // P4:注册 tenancy settings 命名空间 —— 设置→插件「可配置」tab 按 key 派发卡片,
  // 不 serve 该命名空间则多租户卡片永不显示(与 shell 卡片同机制)。
  // settings 服务缺失时注册回调不执行,插件其余功能不受影响(同 deepseek-balance 语义)。
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(TENANCY_NS, TENANCY_SCHEMA, { base: resolveTenancySettings(config) });
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

  /**
   * 对成员请求做路径围栏:返回 {deny, reason?, changed?}。
   * changed=true 时调用方必须把 envelope 重序列化回 bodyBuf 再转发。
   * host.listDirectory 的越界/缺省是"静默钳制"(浏览体验只见围栏根),
   * 其余方法越界一律拒绝。异步:session.create 需查旁车工作区归属。
   */
  async function confineMemberPayload(method, payload, principal) {
    if (!memberRoot) {
      return MEMBER_PATH_CONFINED.has(method) ? { deny: true, reason: 'admin-only' } : { deny: false };
    }
    switch (method) {
      case 'workspace.create': {
        const confined = confineToRoot(memberRoot, String(payload.path ?? ''));
        if (!confined) return { deny: true, reason: 'path-outside-root' };
        payload.path = confined;
        return { deny: false, changed: true };
      }
      case 'host.createDirectory': {
        const seg = safeSegment(payload.name);
        if (!seg) return { deny: false }; // 非法段名交上游 schema 报错
        const baseDir = typeof payload.path === 'string' && payload.path.trim() !== '' ? payload.path : memberRoot;
        const target = confineToRoot(memberRoot, pathResolve(baseDir, seg));
        if (!target) return { deny: true, reason: 'path-outside-root' };
        payload.path = pathDirname(target);
        payload.name = basename(target);
        return { deny: false, changed: true };
      }
      case 'host.listDirectory': {
        const requested = typeof payload.path === 'string' && payload.path.trim() !== '' ? payload.path : null;
        const confined = requested ? confineToRoot(memberRoot, requested) : null;
        if (!confined || confined !== requested) {
          payload.path = confined ?? memberRoot;
          return { deny: false, changed: true };
        }
        return { deny: false };
      }
      case 'session.create': {
        // 显式 cwd 与工作区同一围栏;缺省 cwd 时仍要查 workspaceId 归属——
        // 上游会把会话 cwd 对齐到目标工作区 path,不查就等于让成员经他人/存量
        // 工作区把 cwd 换到围栏外(工作区 owner 仅在 workspace.create 成功后登记)。
        if (typeof payload.cwd === 'string' && payload.cwd.trim() !== '') {
          const confined = confineToRoot(memberRoot, payload.cwd);
          if (!confined) return { deny: true, reason: 'path-outside-root' };
          if (confined !== payload.cwd) {
            payload.cwd = confined;
            return { deny: false, changed: true };
          }
          return { deny: false };
        }
        const wsId = payload?.workspaceId;
        if (wsId !== undefined && wsId !== null && String(wsId).trim() !== '') {
          const wrec = (await store.all()).workspaces?.[String(wsId)];
          if (!wrec || wrec.owner !== principal.user) return { deny: true, reason: 'workspace-not-owned' };
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
   * 无 ACL 记录的存量/恢复会话对非 admin fail-closed(可经 claim/共享补记录)。 */
  const canSeeUser = (principal, sessionId) => {
    if (!sessionId) return true;
    if (isAdminOf(principal)) return true;
    const rec = store.viewSync().sessions[String(sessionId)];
    if (!rec) return false;
    return rec.owner === principal.user || rec.mode === 'team-read' || rec.mode === 'team-rw'
      || (rec.readers?.includes(principal.user) ?? false);
  };

  /** 帧过滤:返回原帧(放行)、null(丢弃)或克隆后的裁剪帧(绝不原地改——broadcast 把同一信封推给所有队列)。 */
  const filterFrame = (principal, frame) => {
    if (principal === null) return null; // 密钥错误的升级连接:全帧丢弃
    const payload = frame?.payload;
    if (payload == null || typeof payload !== 'object') return frame;

    const sid = payload.sessionId;
    const rid = typeof frame.rpcId === 'string' ? frame.rpcId : null;
    if (sid !== undefined && sid !== null) {
      if (!canSeeUser(principal, sid)) return null;
      // ask 类帧(question/approval)同时带 rpcId+sessionId:入索引供 respond 校验
      if (rid !== null) noteRpc(rid, String(sid));
      return frame;
    }
    if (isAdminOf(principal)) return frame;

    // 无顶层 sessionId 的主机状态帧,可能内嵌会话 ID 集合(workspace 视图 / 归档列表)
    let out = payload; let changed = false;
    const ws = payload.workspace;
    if (ws != null && typeof ws === 'object'
      && (Array.isArray(ws.sessionIds) || Array.isArray(ws.archivedSessionIds))) {
      // P6:成员不可见他人工作区的 workspace-changed 视图帧——整帧丢弃
      const wsId = ws.workspaceId;
      if (wsId !== undefined && wsId !== null) {
        const wrec = store.viewSync().workspaces[String(wsId)];
        if (!wrec || wrec.owner !== principal.user) return null;
      }
      out = { ...out, workspace: { ...ws } };
      for (const key of ['sessionIds', 'archivedSessionIds']) {
        if (Array.isArray(out.workspace[key])) {
          out.workspace[key] = out.workspace[key].filter((id) => canSeeUser(principal, id));
          changed = true;
        }
      }
    }
    // P6:workspace-removed / workspace-order-changed 帧仅保留己有工作区的引用
    if (typeof payload.workspaceId === 'string') {
      const wrec = store.viewSync().workspaces[String(payload.workspaceId)];
      if (!wrec || wrec.owner !== principal.user) return null;
    }
    if (Array.isArray(payload.workspaceIds)) {
      const wmap = store.viewSync().workspaces ?? {};
      const keptIds = payload.workspaceIds.filter((id) => {
        const wrec = wmap[String(id)];
        return wrec && wrec.owner === principal.user;
      });
      if (keptIds.length !== payload.workspaceIds.length) {
        if (out === payload) out = { ...payload };
        out.workspaceIds = keptIds;
        changed = true;
      }
    }
    if (Array.isArray(out.archivedSessionIds)) {
      if (out === payload) out = { ...payload };
      out.archivedSessionIds = out.archivedSessionIds.filter((id) => canSeeUser(principal, id));
      changed = true;
    }
    return changed ? { ...frame, payload: out } : frame;
  };

  async function readable(p, sessionId) {
    if (!sessionId) return true;
    if (isAdminOf(p)) return true;
    const rec = (await store.all()).sessions[sessionId];
    if (!rec) return false; // 无记录的存量会话:P1 提供 claim 前 admin-only
    return rec.owner === p.user || rec.mode === 'team-read' || rec.mode === 'team-rw'
      || (rec.readers?.includes(p.user) ?? false);
  }

  async function writable(p, sessionId) {
    if (!sessionId) return true;
    if (isAdminOf(p)) return true;
    const rec = (await store.all()).sessions[sessionId];
    if (!rec) return false;
    return rec.owner === p.user || rec.mode === 'team-rw'
      || (rec.writers?.includes(p.user) ?? false);
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
    // 幂等缓存:respond 硬化路径先读 body 解析 rpcId、随后再读一次转发,
    // 流式读取不缓存会导致第二次读到空流,上游 respond 400,弹窗点击无反应。
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

  async function forward(req, bodyBuf) {
    const apiProxy = ctx.get('apiProxy');
    if (apiProxy === undefined) return new Response('api proxy unavailable', { status: 503 });
    const headers = { ...req.headers };
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    delete headers['connection'];
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(`http://tenancy.internal${req.url}`, {
      method: req.method,
      headers,
      body: hasBody ? bodyBuf : undefined,
      duplex: hasBody ? 'half' : undefined
    });
    return toFetchHandler(apiProxy).fetch(request);
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
        // P6:成员仅见自己创建的工作区(旁车登记);无记录的存量工作区 fail-closed。
        const wrec = ws.workspaceId != null ? wmap[String(ws.workspaceId)] : null;
        if (!isAdminOf(p) && !(wrec && wrec.owner === p.user)) continue;
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
      } catch { /* schema 校验交给上游 */ }
      let payload = envelope?.payload ?? {};

      // P4:成员路径围栏(转发前重写或拒绝)
      if (!isAdminOf(principal) && envelope) {
        const verdict = await confineMemberPayload(method, payload, principal);
        if (verdict.deny) {
          audit.record({ actor: principal.user, action: 'gate.deny', target: method, decision: 403, reason: verdict.reason ?? 'confined' });
          if (verdict.reason === 'admin-only') return deny(res, 403, 'tenancy: admin only');
          if (verdict.reason === 'workspace-not-owned') return deny(res, 403, 'tenancy: workspace not owned by you');
          // 不回显围栏根绝对路径(会泄露部署布局/home 形状)
          return deny(res, 403, 'tenancy: path outside workspace root');
        }
        if (verdict.changed) {
          bodyBuf = Buffer.from(JSON.stringify(envelope));
        }
      }

      const sid = sessionIdOf(payload);

      // P7:延迟 ACL 登记——session.create 时不写 acl.json,首次 session.prompt
      // (真实对话开始)时才落盘。此处同时处理恢复路径(插件重启后 pending 表丢失,
      // 但会话已在上游创建且已有 sid,需按当前 principal 补登记)。
      if (method === 'session.prompt' && sid) {
        const pending = pendingSessions.get(sid);
        if (pending) {
          await store.mutate((db) => {
            if (!db.sessions[sid]) {
              db.sessions[sid] = pending;
            }
          });
          pendingSessions.delete(sid);
          audit.record({ actor: principal.user, action: 'acl.register', sessionId: sid, mode: pending.mode, via: 'session.prompt' });
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
                  updatedBy: principal.user,
                  updatedAt: Date.now()
                };
              }
            });
            audit.record({ actor: principal.user, action: 'acl.register', sessionId: sid, mode: config.defaultAccess, via: 'session.prompt (recovery)' });
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

      const upstream = await forward(req, bodyBuf);
      const buf = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get('content-type') ?? 'application/json';

      if (!contentType.includes('json')) return sendJson(res, upstream.status, buf, contentType);

      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch { /* 透传原文 */ }

      if (body == null) return sendJson(res, upstream.status, buf, contentType);

      // P7:session.create / session.fork 成功后不立即写 ACL,而是暂存到
      // pendingSessions(纯内存),等首次 session.prompt 才落盘到 acl.json。
      // fork 子会话继承父 access:父可能也在 pending 中(尚未首 prompt),
      // 故同时查 pendingSessions 兜底。
      if ((method === 'session.create' || method === 'session.fork')
        && upstream.ok && body?.result?.ok !== false) {
        const newId = body?.result?.value?.sessionId;
        if (newId) {
          const parentRec = method === 'session.fork' && sid
            ? ((await store.all()).sessions[sid] ?? pendingSessions.get(sid))
            : null;
          pendingSessions.set(newId, {
            owner: principal.user,
            mode: parentRec?.mode ?? config.defaultAccess,
            readers: parentRec?.readers ?? [],
            writers: parentRec?.writers ?? [],
            updatedBy: principal.user,
            updatedAt: Date.now()
          });
          audit.record({ actor: principal.user, action: 'acl.pending', sessionId: newId, mode: parentRec?.mode ?? config.defaultAccess, via: method });
        }
      }

      // P6:workspace.create 成功后登记 owner(workspace.list 过滤与 WS 帧过滤的依据)。
      // create 采纳已有目录时返回已存在记录:绝不覆盖既有 owner。
      if (method === 'workspace.create' && upstream.ok && body?.result?.ok !== false) {
        const wsValue = body?.result?.value;
        const wsId = wsValue?.workspace?.workspaceId ?? wsValue?.workspaceId;
        if (wsId) {
          await store.mutate((db) => {
            if (!db.workspaces[String(wsId)]) {
              db.workspaces[String(wsId)] = {
                owner: principal.user,
                createdAt: wsValue?.workspace?.createdAt ?? null,
                updatedAt: Date.now()
              };
            }
          });
          audit.record({ actor: principal.user, action: 'acl.register', target: 'workspace', workspaceId: String(wsId), via: method });
        }
      }
      // workspace.delete 成功后清理旁车 owner 记录(保持与宿主登记一致)
      if (method === 'workspace.delete' && upstream.ok && body?.result?.ok !== false) {
        const wsId = payload?.workspaceId;
        if (wsId) {
          await store.mutate((db) => { delete db.workspaces[String(wsId)]; });
          audit.record({ actor: principal.user, action: 'acl.unregister', target: 'workspace', workspaceId: String(wsId), via: method });
        }
      }

      if (LIST_FILTERED.has(method) || method === 'workspace.list') {
        body = await filterBody(method, body, principal);
        return sendJson(res, upstream.status, jsonBuf(body));
      }
      // P4:成员目录浏览响应里的 home 指向宿主真实 HOME,会诱导 UI 跳出围栏根——改写为根
      if (method === 'host.listDirectory' && !isAdminOf(principal)
        && memberRoot && typeof body?.result?.value?.home === 'string') {
        body.result.value.home = memberRoot;
        return sendJson(res, upstream.status, jsonBuf(body));
      }
      return sendJson(res, upstream.status, buf, contentType);
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
        const entries = Object.entries(sessions)
          .filter(([, rec]) => admin || rec.owner === principal.user)
          .map(([id, rec]) => ({ sessionId: id, ...rec }));
        return sendJson(res, 200, jsonBuf({ sessions: entries }));
      }

      // P8:工作区 owner 一览(用户中心「工作区管理」;admin 全量,成员仅本人)
      if (req.method === 'GET' && path === '/workspaces') {
        const { workspaces } = await store.all();
        const entries = Object.entries(workspaces ?? {})
          .filter(([, rec]) => admin || rec.owner === principal.user)
          .map(([wsId, rec]) => ({ workspaceId: wsId, ...rec }));
        return sendJson(res, 200, jsonBuf({ ok: true, workspaces: entries }));
      }

      if (req.method === 'GET' && path.startsWith('/sessions/') && path.endsWith('/acl')) {
        // ACL 详情:可读即可见(owner/admin/被分享者)——供 UI 徽章与共享对话框
        const id = safeDecode(path.split('/')[2] ?? '');
        if (id === null) return deny(res, 400, 'tenancy: malformed session id');
        if (!(await readable(principal, id))) {
          audit.record({ actor: principal.user, action: 'acl.deny', target: 'get', sessionId: id || null, decision: 403 });
          return deny(res, 403, 'tenancy: session not readable');
        }
        const rec = (await store.all()).sessions[id];
        return sendJson(res, rec ? 200 : 404, jsonBuf(rec ?? { error: 'no-acl-record' }));
      }

      if (req.method === 'POST' && path.startsWith('/sessions/') && path.endsWith('/acl')) {
        // P3:owner 本人或 admin 可改自己会话的 ACL(共享对话框);他人拒绝
        const id = safeDecode(path.split('/')[2] ?? '');
        if (id === null) return deny(res, 400, 'tenancy: malformed session id');
        const rec = (await store.all()).sessions[id];
        const isOwner = rec?.owner === principal.user;
        if (!admin && !isOwner) {
          audit.record({ actor: principal.user, action: 'acl.deny', target: 'set', sessionId: id || null, decision: 403 });
          return deny(res, 403, 'tenancy: owner or admin only');
        }
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        await store.mutate((db) => {
          db.sessions[id] = {
            owner: body.owner ?? db.sessions[id]?.owner ?? principal.user,
            mode: body.mode ?? db.sessions[id]?.mode ?? config.defaultAccess,
            readers: body.readers ?? db.sessions[id]?.readers ?? [],
            writers: body.writers ?? db.sessions[id]?.writers ?? [],
            updatedBy: principal.user, updatedAt: Date.now()
          };
        });
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
              mode: config.defaultAccess, readers: [], writers: [],
              ...db.sessions[id],
              owner, updatedBy: principal.user, updatedAt: Date.now()
            };
          }
        });
        audit.record({ actor: principal.user, action: 'acl.claim', owner, count: ids.length });
        return sendJson(res, 200, jsonBuf({ ok: true, claimed: ids.length, owner }));
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
   * 扫描 sessionRoot 下所有 project/session 目录,删除满足以下条件的会话文件夹:
   *   ① 目录 mtime 超过 1 天;
   *   ② 会话无真实对话(session.jsonl 仅有 header 行,或无该文件)。
   * 有对话(≥2 行)的会话不受影响。删除前先清理 pendingSessions 中的残留条目。
   */
  async function cleanupStaleSessions() {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
      const { readdir, stat, rm, readFile } = await import('node:fs/promises');
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

          // 检查是否有真实对话:session.jsonl 存在且行数 > 1(header + ≥1 事件)
          const jsonlPath = join(sessionPath, 'session.jsonl');
          let hasConversation = false;
          try {
            const content = await readFile(jsonlPath, 'utf8');
            const lines = content.trim().split('\n');
            hasConversation = lines.length > 1;
          } catch { /* 无 jsonl = 无对话 */ }

          if (!hasConversation) {
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
      }
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
      kind: 'exact', path: SESSION_EXPORT_PATH,
      handler: async (req, res) => {
        if (!trustedApiRequest(req)) return denyUntrusted(res);
        const p = principalOf(req);
        if (!p) return denyBadSecret(res);
        const sid = new URL(req.url, 'http://x').searchParams.get('sessionId');
        if (!(await readable(p, sid))) return deny(res, 403, 'tenancy: session not readable');
        const upstream = await forward(req, await readBody(req));
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
          isTrusted: trustedApiRequest
        })
      }));
    }

    // P3:respond 硬化——rpcId 必须在事件帧索引中且会话对主体可写。
    // rpcId 为服务端铸造的 UUID,只会经 mux 帧(question/approval)到达客户端;
    // 帧过滤后不可见会话的 rpcId 根本不会出现在成员浏览器里,此处是纵深防御。
    if (config.hardenRespond) {
      disposers.push(ctx.webServer.register({
        kind: 'exact', path: '/api/respond',
        handler: async (req, res) => {
          try {
            if (!trustedApiRequest(req)) return denyUntrusted(res);
            const principal = principalOf(req);
            if (!principal) {
              audit.record({ actor: '?', action: 'respond.deny', decision: 401, reason: 'bad-secret' });
              return denyBadSecret(res);
            }
            let rpcId = null; let raw = {};
            try {
              const parsed = JSON.parse((await readBody(req)).toString('utf8') || '{}');
              raw = parsed.payload ?? {};
              rpcId = typeof raw.rpcId === 'string' ? raw.rpcId : (typeof parsed.rpcId === 'string' ? parsed.rpcId : null);
            } catch { /* 交由上游 schema 报错 */ }
            const hit = rpcId !== null ? rpcIndex.get(rpcId) : undefined;
            if (!hit) {
              audit.record({ actor: principal.user, action: 'respond.deny', decision: 403, rpcId, reason: 'rpcid-unknown-or-expired' });
              return deny(res, 403, 'tenancy: unknown or expired rpcId');
            }
            if (!(await writable(principal, hit.sessionId))) {
              audit.record({ actor: principal.user, action: 'respond.deny', decision: 403, rpcId, sessionId: hit.sessionId, reason: 'not-writable' });
              return deny(res, 403, 'tenancy: session not writable');
            }
            const upstream = await forward(req, await readBody(req));
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

    // P2:client-connection 补丁在 WS 升级时调用 principal(req) 记录主体,
    // 并在 downlink pump 循环里对每帧调用 filterFrame(同步,见 patches/ 下的补丁)。
    globalThis.__dshTenancy = {
      version: 2,
      principal: principalOf, // (req) => principal | null;null = 密钥校验失败
      deny: (principal, frame) => filterFrame(principal, frame) === null,
      filterFrame
    };

    // P7:启动无对话会话扫盘清理(首次 1 分钟后执行,之后每 6 小时一次)。
    let cleanupIntervalId = null;
    const cleanupTimeoutId = setTimeout(() => {
      cleanupStaleSessions();
      cleanupIntervalId = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
    }, 60000);

    return () => {
      clearTimeout(cleanupTimeoutId);
      if (cleanupIntervalId) clearInterval(cleanupIntervalId);
      delete globalThis.__dshTenancy;
      for (const d of disposers) d();
    };
  }, 'tenancy: shadow routes + management api');


  ctx.inject(['apiProxy'], () => {
    ctx.logger?.info?.('tenancy: apiProxy available — gates active');
  });
}

export default { name, inject, Config, apply };
