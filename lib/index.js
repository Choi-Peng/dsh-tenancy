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
// 明确不做:特权方法(settings./credentials./agentPreset.read 等)不影子注册——
// 它们由核心围栏处理(团队入口 403;管理员流量经 Caddy 重写为 loopback 后放行)。
// 注:影子路由本身不再重复基础围栏(Host/Origin/sec-fetch-site)检查——身份提取
// 即本插件的围栏;直连 loopback 的调用方按 local principal 处理(dsh 同哲学)。

import z from '@deepseek-ai/schemastery';
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy';
import { statSync, readFileSync } from 'node:fs';

//#region config

/** 插件配置(schema 默认 → cordis.patch.yml 的 base 层)。 */
export const Config = z.object({
  /** Caddy copy_headers 注入的用户名头(小写)。 */
  identityHeader: z.string().default('remote-user'),
  /** 组头(Authelia Remote-Groups 为逗号分隔字符串)。 */
  groupsHeader: z.string().default('remote-groups'),
  /** 共享密钥:Caddy 注入 X-Dsh-Tenancy-Key;非空则强制校验。空=仅限纯内网调试。 */
  sharedSecret: z.string().default(''),
  adminGroups: z.array(z.string()).default(['dsh-admins']),
  /** 无身份头的请求(SSH 隧道直连 loopback)视为此主体。 */
  localPrincipal: z.string().default('local'),
  localIsAdmin: z.boolean().default(true),
  defaultAccess: z.union(['private', 'team-read', 'team-rw']).default('private'),
  hideEmptyWorkspaces: z.boolean().default(true),
  /** 空 → $DSH_HOME/tenancy/acl.json */
  dbPath: z.string().default('')
});

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
/** 需 admin 主体才放行的工作区变更 + 主机目录浏览。 */
const ADMIN_ONLY = new Set([
  'workspace.create', 'workspace.rename', 'workspace.delete', 'workspace.insertBefore',
  'host.listDirectory', 'host.createDirectory'
]);
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

  /**
   * 同步快照(供 WS pump 的帧过滤使用)。新鲜度:migrate/mutate 与任何
   * HTTP 路径的 all() 都会刷新;绕过 API 手改文件需重启或触发一次 API 调用。
   */
  viewSync() { return this.#cache ?? { version: 1, sessions: {}, workspaces: {} }; }
}

//#endregion

//#region plugin

export const inject = ['webServer'];
export const name = 'tenancy';

export function apply(ctx, config) {
  const dbPath = config.dbPath || `${resolveDshHome()}/tenancy/acl.json`;
  const store = new AclStore(dbPath);
  const adminSet = new Set(config.adminGroups);

  //#region principal & policy

  function principalOf(req) {
    const presented = req.headers['x-dsh-tenancy-key'];
    if (config.sharedSecret && presented !== undefined && presented !== config.sharedSecret) {
      return null; // 带了密钥但不对:拒绝且不回退 local
    }
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

  /** 事件帧钩子用的轻量判定(同步;读 store 的启动快照,见 AclStore.viewSync)。 */
  const canSeeUser = (user, sessionId) => {
    if (!sessionId) return true;
    if (adminSet.has(user) || (config.localIsAdmin && user === config.localPrincipal)) return true;
    const rec = store.viewSync().sessions[String(sessionId)];
    if (!rec) return false;
    return rec.owner === user || rec.mode === 'team-read' || rec.mode === 'team-rw'
      || (rec.readers?.includes(user) ?? false);
  };

  /** 帧过滤:返回原帧(放行)、null(丢弃)或克隆后的裁剪帧(绝不原地改——broadcast 把同一信封推给所有队列)。 */
  const filterFrame = (principal, frame) => {
    if (principal === null) return null; // 密钥错误的升级连接:全帧丢弃
    const payload = frame?.payload;
    if (payload == null || typeof payload !== 'object') return frame;
    if (isAdminOf(principal)) return frame;

    const sid = payload.sessionId;
    if (sid !== undefined && sid !== null) return canSeeUser(principal.user, sid) ? frame : null;

    // 无顶层 sessionId 的主机状态帧,可能内嵌会话 ID 集合(workspace 视图 / 归档列表)
    let out = payload; let changed = false;
    const ws = payload.workspace;
    if (ws != null && typeof ws === 'object'
      && (Array.isArray(ws.sessionIds) || Array.isArray(ws.archivedSessionIds))) {
      out = { ...out, workspace: { ...ws } };
      for (const key of ['sessionIds', 'archivedSessionIds']) {
        if (Array.isArray(out.workspace[key])) {
          out.workspace[key] = out.workspace[key].filter((id) => canSeeUser(principal.user, id));
          changed = true;
        }
      }
    }
    if (Array.isArray(out.archivedSessionIds)) {
      if (out === payload) out = { ...payload };
      out.archivedSessionIds = out.archivedSessionIds.filter((id) => canSeeUser(principal.user, id));
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

  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > TENANCY_MAX_BODY_BYTES) throw new Error('body too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
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
      const lists = Array.isArray(value) ? value
        : [value.workspaces, value.rows].find(Array.isArray) ?? [];
      const kept = [];
      for (const ws of lists) {
        if (!ws || typeof ws !== 'object') { kept.push(ws); continue; }
        for (const key of ['sessionIds', 'archivedSessionIds']) {
          if (Array.isArray(ws[key])) {
            const filtered = [];
            for (const sid of ws[key]) if (await readable(p, sid)) filtered.push(sid);
            ws[key] = filtered;
          }
        }
        const remaining = [...(ws.sessionIds ?? []), ...(ws.archivedSessionIds ?? [])];
        if (!(config.hideEmptyWorkspaces && remaining.length === 0)) kept.push(ws);
      }
      if (Array.isArray(value)) body.result.value = kept;
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
      const principal = principalOf(req);
      if (!principal) return deny(res, 401, 'tenancy: bad proxy secret');
      if (ADMIN_ONLY.has(method) && !isAdminOf(principal)) {
        return deny(res, 403, 'tenancy: admin only');
      }

      const bodyBuf = await readBody(req);
      let payload = {};
      try {
        payload = JSON.parse(bodyBuf.toString('utf8') || '{}').payload ?? {};
      } catch { /* schema 校验交给上游 */ }

      const sid = sessionIdOf(payload);
      if (READ_BY_SESSION.has(method) && !(await readable(principal, sid))) {
        return deny(res, 403, 'tenancy: session not readable');
      }
      if (WRITE_BY_SESSION.has(method) && !(await writable(principal, sid))) {
        return deny(res, 403, 'tenancy: session not writable');
      }

      const upstream = await forward(req, bodyBuf);
      const buf = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get('content-type') ?? 'application/json';

      if (!contentType.includes('json')) return sendJson(res, upstream.status, buf, contentType);

      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch { /* 透传原文 */ }

      if (body == null) return sendJson(res, upstream.status, buf, contentType);

      // session.create / session.fork 成功后登记 ACL(fork 子会话继承父 access)
      if ((method === 'session.create' || method === 'session.fork')
        && upstream.ok && body?.result?.ok !== false) {
        const newId = body?.result?.value?.sessionId;
        if (newId) {
          const parentRec = method === 'session.fork' && sid ? (await store.all()).sessions[sid] : null;
          await store.mutate((db) => {
            db.sessions[newId] = {
              owner: principal.user,
              mode: parentRec?.mode ?? config.defaultAccess,
              readers: parentRec?.readers ?? [],
              writers: parentRec?.writers ?? [],
              updatedBy: principal.user,
              updatedAt: Date.now()
            };
          });
        }
      }

      if (LIST_FILTERED.has(method) || method === 'workspace.list') {
        body = await filterBody(method, body, principal);
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
      const principal = principalOf(req);
      if (!principal) return deny(res, 401, 'tenancy: bad proxy secret');
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

      if (req.method === 'POST' && !admin) return deny(res, 403, 'tenancy: admin only');

      if (req.method === 'POST' && path.startsWith('/sessions/')) {
        const id = decodeURIComponent(path.split('/')[2] ?? '');
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
        return sendJson(res, 200, jsonBuf({ ok: true }));
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
        return sendJson(res, 200, jsonBuf({ ok: true, claimed: ids.length, owner }));
      }

      return deny(res, 404, 'tenancy: unknown route');
    } catch (error) {
      ctx.logger?.error?.(`tenancy: admin route failure: ${error?.stack ?? error}`);
      return deny(res, 500, 'tenancy: internal error');
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
        const p = principalOf(req);
        if (!p) return deny(res, 401, 'tenancy: bad proxy secret');
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

    // P2:client-connection 补丁在 WS 升级时调用 principal(req) 记录主体,
    // 并在 downlink pump 循环里对每帧调用 filterFrame(同步,见 patches/ 下的补丁)。
    globalThis.__dshTenancy = {
      version: 2,
      principal: principalOf, // (req) => principal | null;null = 密钥校验失败
      deny: (principal, frame) => filterFrame(principal, frame) === null,
      filterFrame
    };

    return () => {
      delete globalThis.__dshTenancy;
      for (const d of disposers) d();
    };
  }, 'tenancy: shadow routes + management api');


  ctx.inject(['apiProxy'], () => {
    ctx.logger?.info?.('tenancy: apiProxy available — gates active');
  });
}

export default { name, inject, Config, apply };
