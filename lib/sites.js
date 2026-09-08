// AI 生成声明:本模块由 AI 生成,可能存在错误或安全隐患,使用前请 review 并实测。
//
// 公开站点服务(P11):pub.example.com/<user>/<projectName> → 成员个人工作区
// memberWorkspaceRoot/<user>/<projectName>/<publicBuildDir>(默认 dist)的静态发布。
// 纯匿名、无鉴权、只读:由部署方把公开域名转发到独立端口(默认 127.0.0.1:3089),
// 与主站的 SPA 回落/影子路由完全隔离(不注册 webServer 路由,不碰身份头)。
//
// 安全要点:
//   · 只服务 <project>/<buildDir> 的构建产物,绝不暴露源码/依赖/隐藏文件;
//   · 逐段解码校验:拒 '../'、编码分隔符(%2F/%5C)、NUL、隐藏段、node_modules;
//   · realpath 落点双重围栏:buildRoot 必须落在 memberRoot 内,请求文件必须落在
//     buildRoot 内(符号链接外逃一律 404,含「dist → 兄弟项目」这类根内错位);
//   · 可选 Host 白名单(publicSitesHosts),生产建议设为公开域名;
//   · 仅 GET/HEAD;目录缺省 index.html;无扩展名未命中可回落 index.html(SPA 路由)。

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { statSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

//#region 路径解析(纯函数,便于离线自测)

const SEG_MAX = 128;
const BLOCKED_SEGMENTS = new Set(['node_modules', '.git', '.DS_Store']);

/**
 * 单段路径校验:解码后的段不允许为空/点段/分隔符/NUL/隐藏前缀/黑名单名。
 * 返回清洗后的段,非法返回 null。
 */
export function safeUrlSegment(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.length > SEG_MAX) return null;
  if (raw === '.' || raw === '..') return null;
  if (raw.includes('/') || raw.includes('\\') || raw.includes('\0')) return null;
  if (raw.startsWith('.')) return null; // 隐藏文件/目录一律不服务
  if (BLOCKED_SEGMENTS.has(raw)) return null;
  return raw;
}

/**
 * 解析公开站点路径(pathname,不含 query),如 /alice/myapp/assets/x.js
 * → { user: 'alice', project: 'myapp', rest: ['assets', 'x.js'] }。
 * 不足两段或任一段非法 → null。先按 '/' 切分再逐段解码校验:编码的分隔符
 * (%2F、%5C)、NUL(%00)、点段(%2e%2e)解码后都会被 safeUrlSegment 拒绝,
 * 不存在「解码后语义变化」的绕过;WHATWG URL 已在解析时归一化裸 '../'(含
 * %2e%2e),这里再拦一道是纵深防御(本函数也独立可测)。
 */
export function parseSitePath(pathname) {
  if (typeof pathname !== 'string' || pathname === '' || !pathname.startsWith('/')) return null;
  const segs = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue; // 首尾/连续斜杠
    let dec;
    try {
      dec = decodeURIComponent(raw);
    } catch {
      return null; // 畸形转义:直接拒,不给上游当 500
    }
    const seg = safeUrlSegment(dec);
    if (seg === null) return null;
    segs.push(seg);
  }
  if (segs.length < 2) return null;
  return { user: segs[0], project: segs[1], rest: segs.slice(2) };
}

/** 扩展名 → Content-Type(小写;缺省二进制)。 */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject'
};

export function contentTypeFor(name) {
  return CONTENT_TYPES[extname(String(name)).toLowerCase()] ?? 'application/octet-stream';
}

//#endregion

//#region 落点解析与双重围栏

/**
 * 沿 target 自深向浅找第一个真实存在的组件并 realpath,再拼回不存在的尾部。
 * 全部不存在(到根)返回 null。这样「构建目录尚在写入中」等场景也能得到
 * 与真实路径同一坐标系的落点。
 */
function realTarget(target) {
  const tail = [];
  let cur = target;
  for (;;) {
    try {
      return resolve(realpathSync(cur), ...tail);
    } catch { /* 不存在:继续向上找存在祖先 */ }
    const parent = resolve(cur, '..');
    if (parent === cur) return null;
    tail.unshift(basename(cur));
    cur = parent;
  }
}

/** p 是否在 root 内(两者均为绝对路径;root 须已 realpath 归一)。 */
function within(root, p) {
  const rel = relative(root, p);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * 计算 buildRoot 与请求文件的真实落点,做两级围栏:
 *   ① buildRootReal 必须落在 memberRoot 内(挡 user/project 目录符号链接外逃,
 *      如 ~/dsh/alice → /etc);
 *   ② targetReal 必须落在 buildRootReal 内(挡 buildDir/内部符号链接外逃,
 *      如 dist → 兄弟项目或根外目录)。
 * 构建产物目录不存在/不是目录 → null(未发布)。
 * 返回 { buildRootReal, targetReal } 或 null。
 */
export function resolveSiteTarget(memberRoot, buildDir, parsed) {
  if (typeof memberRoot !== 'string' || memberRoot === '' || !parsed) return null;
  const buildRootLex = resolve(memberRoot, parsed.user, parsed.project, buildDir);
  const buildRootReal = realTarget(buildRootLex);
  if (!buildRootReal || !within(memberRoot, buildRootReal)) return null;
  let st;
  try {
    st = statSync(buildRootReal);
  } catch {
    return null; // 构建产物目录尚不存在 = 未发布
  }
  if (!st.isDirectory()) return null;
  const targetLex = parsed.rest.length === 0
    ? buildRootLex
    : resolve(buildRootLex, ...parsed.rest);
  const targetReal = realTarget(targetLex);
  if (!targetReal || !within(buildRootReal, targetReal)) return null;
  return { buildRootReal, targetReal };
}

//#endregion

//#region HTTP 服务

const NOT_FOUND = 'not found';
const text404 = (res) => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end(NOT_FOUND);
};

/** 流式下发文件(HEAD 只带头);失败返回 false(调用方转 404)。 */
function streamFile(res, filePath, method, cacheControl, status = 200) {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const headers = {
    'content-type': contentTypeFor(filePath),
    'content-length': String(st.size),
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff'
  };
  res.writeHead(status, headers);
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

/**
 * 启动公开站点 HTTP 服务(独立端口,匿名,只读)。
 * @param options.memberRoot  个人工作区根(memberWorkspaceRoot,已 realpath 归一)
 * @param options.buildDir    项目内构建输出子目录名(默认 dist)
 * @param options.port        监听端口(0 = 系统分配)
 * @param options.host        监听地址(默认 127.0.0.1;勿绑 0.0.0.0)
 * @param options.hostAllowlist Host 白名单(小写 hostname 或 host:port);空 = 任意
 * @param options.spaFallback 未命中文件且末段无扩展名时回落 index.html
 * @param options.cacheControl Cache-Control 头值
 * @param options.audit       审计日志(可选;仅记录形似攻击的路径拒绝)
 * @param options.logger      日志(可选)
 * @returns Promise<{ port, dispose }>;listen 失败 reject
 */
export async function createPublicSitesServer(options) {
  const memberRoot = options.memberRoot;
  const buildDir = options.buildDir || 'dist';
  const spaFallback = options.spaFallback !== false;
  const cacheControl = options.cacheControl || 'public, max-age=300';
  const audit = options.audit ?? null;
  const logger = options.logger ?? null;
  const allowlist = new Set((options.hostAllowlist ?? [])
    .map((h) => String(h).trim().toLowerCase()).filter(Boolean));

  // 只审计安全相关拒绝(畸形/穿越路径、Host 错配):「未发布/未命中/无 index」等
  // 普通 404 对公网端口是常态(扫描器噪音),写审计会轮转掉真正的安全事件。
  const AUDIT_REASONS = new Set(['bad-url', 'bad-path', 'host-not-allowed']);

  const deny = (res, reason, pathname) => {
    if (AUDIT_REASONS.has(reason)) {
      audit?.record?.({ actor: 'anonymous', action: 'sites.deny', target: pathname, decision: 404, reason });
    }
    text404(res);
  };

  const handle = async (req, res) => {
    // 方法闸:公开站点只读
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    // 可选 Host 白名单(防御纵深:防代理侧 Host 错配)
    if (allowlist.size > 0) {
      const host = String(req.headers?.host ?? '').trim().toLowerCase();
      const hostname = host.split(':')[0];
      if (!allowlist.has(host) && !allowlist.has(hostname)) {
        deny(res, 'host-not-allowed', req.url ?? '/');
        return;
      }
    }
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://sites.local');
    } catch {
      deny(res, 'bad-url', req.url ?? '/');
      return;
    }
    const parsed = parseSitePath(url.pathname);
    if (!parsed) {
      deny(res, 'bad-path', url.pathname);
      return;
    }
    const target = resolveSiteTarget(memberRoot, buildDir, parsed);
    if (!target) {
      // 未发布先 404,再做尾斜杠 301:任何两段路径(包括被外层代理误转到本
      // 端口的插件路由,如 /deepseek-balance/settings)都不会先吃到一个掩盖
      // 真实 404 的重定向,响应语义保持诚实,排障不再被 301 误导。
      deny(res, 'not-published', url.pathname);
      return;
    }
    // 已发布站点、无尾斜杠的根目录请求 → 301:页面内相对资源(./assets/x)依赖尾斜杠才解析正确
    if (parsed.rest.length === 0 && !url.pathname.endsWith('/')) {
      res.writeHead(301, { location: `${url.pathname}/${url.search || ''}` });
      res.end();
      return;
    }

    const { buildRootReal, targetReal } = target;
    let st = null;
    try {
      st = statSync(targetReal);
    } catch { /* 不存在:走 SPA 回落或 404 */ }

    if (st?.isDirectory()) {
      // 目录 → 目录内 index.html;没有则 SPA 回落(若开启且末段非文件形态)
      if (streamFile(res, resolve(targetReal, 'index.html'), req.method, cacheControl)) return;
      const last = parsed.rest[parsed.rest.length - 1];
      if (spaFallback && last !== undefined && !last.includes('.')) {
        if (streamFile(res, resolve(buildRootReal, 'index.html'), req.method, cacheControl)) return;
      }
      deny(res, 'no-index', url.pathname);
      return;
    }

    if (st?.isFile()) {
      streamFile(res, targetReal, req.method, cacheControl) || deny(res, 'read-failed', url.pathname);
      return;
    }

    // 未命中:无扩展名的「路由形态」路径 → SPA 回落 index.html;其余 404
    const last = parsed.rest[parsed.rest.length - 1];
    if (spaFallback && last !== undefined && !last.includes('.')) {
      if (streamFile(res, resolve(buildRootReal, 'index.html'), req.method, cacheControl)) return;
    }
    deny(res, 'miss', url.pathname);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger?.error?.(`tenancy: public sites handler failure: ${error?.stack ?? error}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('internal error');
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (e) => rejectListen(e);
    server.once('error', onError);
    server.listen(options.port ?? 3089, options.host ?? '127.0.0.1', () => {
      server.off('error', onError);
      resolveListen();
    });
  });
  server.on('error', (error) => logger?.error?.(`tenancy: public sites server error: ${error?.message ?? error}`));

  return {
    port: server.address().port,
    dispose() {
      return new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
    }
  };
}

//#endregion
