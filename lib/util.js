// AI 生成声明:本模块由 AI 生成,可能存在错误或安全隐患,使用前请 review 并实测。
//
// tenancy 纯函数工具(P4):路径围栏 + 邀请码/用户名校验。
// 不依赖任何运行时服务(node:crypto/path 除外),便于离线自测(scripts/selftest.mjs)。

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstatSync, readlinkSync, realpathSync as fsRealpathSync, realpathSync } from 'node:fs';

//#region 路径围栏(成员工作空间限制)

/**
 * 展开 '~' 与 '~/...' 前缀为绝对路径,并 realpath 归一(homedir 缺失时原样 resolve)。
 *
 * 围栏根为何必须归一:confineToRoot 除词法判定外还比 realpath 后的落点,
 * 所以下游路径一律以**真实路径**为词——若 root 停在符号链接形式(如 `~/dsh -> /data/dsh`),
 * 成员按真实前缀 `/data/dsh/...` 发的请求会被词法判定全部误拒(可用性缺陷),
 * 错误消息里还会泄露未解析的词法根。归一后 root 与请求路径同一坐标系,判定才一致。
 * 目录尚不存在(realpath 失败)时退回词法路径,由调用方 mkdir 后再次归一。
 */
export function expandHomeDir(p, homedir) {
  if (typeof p !== 'string' || p.trim() === '') return null;
  const trimmed = p.trim();
  let resolved = null;
  if (trimmed === '~') resolved = homedir || null;
  else if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) resolved = homedir ? resolve(join(homedir, trimmed.slice(2))) : null;
  else resolved = resolve(trimmed);
  if (resolved === null) return null;
  try {
    return realpathSync(resolved);
  } catch {
    return resolved; // 尚不存在:保持词法绝对路径
  }
}

/**
 * 把目标路径约束在 root 内;返回约束后的绝对路径,越界返回 null。
 * 三道检查:
 *  ① 词法:resolve 后 relative(root, target) 不得以 '..' 开头(不得绝对化);
 *  ② 实体:沿 target 自深向浅找第一个真实存在的组件,lstat 命中符号链接时
 *     解析其真实落点(悬空链接一律拒绝),realpath 必须仍落在 root 内
 *     —— 挡掉 root 内符号链接指向外部的情况;
 *  ③ 不存在的尾部视为新建路径放行(其存在前缀已过 ②)。
 * root 自身应已 realpath(见 index.js 的 memberRoot 初始化)。
 */
export function confineToRoot(root, target) {
  if (typeof root !== 'string' || root === '' || typeof target !== 'string' || target.trim() === '') return null;
  const abs = resolve(target);
  const rel = relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;

  const within = (p) => {
    const r = relative(root, p);
    return !(r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r));
  };

  let cur = abs;
  for (;;) {
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      st = null; // 不存在:继续向上找存在祖先
    }
    if (st) {
      let raw; // 符号链接的原始落点(相对其所在目录展开)
      let real; // 完全解析后的真实路径
      try {
        if (st.isSymbolicLink()) raw = resolve(resolve(cur, '..'), readlinkSync(cur));
        real = fsRealpathSync(cur);
      } catch {
        // 悬空符号链接(realpath 失败)按原始落点判;其他解析失败保守拒绝
        if (raw !== undefined) return within(raw) ? abs : null;
        return null;
      }
      if (!within(raw ?? real) || !within(real)) return null;
      break;
    }
    const parent = resolve(cur, '..');
    if (parent === cur) break; // 到顶仍未命中存在路径:只剩词法判定
    cur = parent;
  }
  return abs;
}

/** 单段目录名(供 host.createDirectory 的 name 兜底清洗)。 */
export function safeSegment(name) {
  const s = String(name ?? '').trim();
  if (s === '' || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) return null;
  return s;
}

//#endregion

//#region browser-trust 围栏(影子路由的来源可信判定)

/** 是否 loopback 主机名(带括号的 IPv6 字面量也接受)。 */
export function isLoopbackHost(hostname) {
  const h = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

/**
 * 核心 dsh-client-connection 里 isTrustedApiRequest 的同构重写(那个包未导出此函数)。
 * exact 影子路由优先级高于核心的 /api 前缀路由,被本插件接管的请求**永不经过核心那道
 * 围栏**,所以必须自己卡住两类 confused-deputy:
 *   ① DNS rebinding —— Host 是攻击者域名但 socket 递到本机 HTTP 入方;
 *   ② 跨站请求 —— 恶意页面代发的 fetch。
 * 判定:Host 可解析且为 loopback 或 `trustedHosts` 条目(hostname 或 host:port 两种形式);
 * `sec-fetch-site: cross-site` 直接拒;带 Origin 时必须与 Host 同源。
 *
 * @param headers - node:http 的 req.headers(或任何同名小写键的普通对象)。
 * @param trustedHosts - 预先归一(小写、去空)后的 Set/数组。
 */
export function isTrustedApiRequest(headers, trustedHosts) {
  const host = headers?.['host'];
  if (typeof host !== 'string' || host === '') return false;
  const origin = headers['origin'];
  let hostUrl; let originUrl = null;
  try {
    hostUrl = new URL(`http://${host}`);
    if (typeof origin === 'string' && origin !== '') originUrl = new URL(origin);
  } catch {
    return false; // 不可解析的 Host/Origin 一律不信
  }
  const hostname = hostUrl.hostname.toLowerCase();
  const trusted = trustedHosts instanceof Set ? trustedHosts : new Set(trustedHosts ?? []);
  if (!isLoopbackHost(hostname) && !trusted.has(hostname) && !trusted.has(hostUrl.host)) return false;
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  return originUrl === null || originUrl.host === hostUrl.host;
}

/** 路径段解码容错:`%zz` 这类畸形转义抛错会让请求变成 500,这里返回 null 交给调用方拒绝。 */
export function safeDecode(text) {
  if (typeof text !== 'string') return null;
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

//#endregion

//#region 注册校验(纯部分;IO 在 register.js)

export const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{2,31}$/; // 总长 3–32
export const RESERVED_USERNAMES = new Set(['local', 'admin', 'administrator', 'root', 'authelia']);

/** 用户名合法性;返回 null(合法)或错误码。 */
export function checkUsername(name) {
  if (typeof name !== 'string' || USERNAME_RE.test(name) === false) return 'username-invalid';
  if (RESERVED_USERNAMES.has(name.toLowerCase())) return 'username-taken';
  return null;
}

/** 密码策略;返回 null 或错误码。 */
export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) return 'password-weak';
  return null;
}

/**
 * 清洗进 YAML 双引号标量的自由文本:去掉引号/反斜杠/控制符,限长。
 * email 另做极简格式把关。
 */
export function sanitizeYamlScalar(text, maxLen = 64) {
  const cleaned = String(text ?? '')
    .replace(/["\\\r\n\0\t]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return cleaned.slice(0, maxLen);
}

export function checkEmail(email) {
  if (email == null || email === '') return null; // 选填
  if (typeof email !== 'string' || email.length > 254) return 'email-invalid';
  if (!/^[^\s@"]+@[^\s@"]+\.[^\s@"]+$/.test(email)) return 'email-invalid';
  return null;
}

/** 归一化邀请码:去分隔符与空白、统一大写。 */
export function normalizeInviteCode(code) {
  return String(code ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/** users.yml 中是否已有该用户(顶层两空格缩进的键,大小写不敏感)。 */
export function usersYmlHasUser(usersYmlText, username) {
  if (typeof usersYmlText !== 'string') return false;
  const re = new RegExp(`^  ${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'im');
  return re.test(usersYmlText);
}

/** 组装追加到 users.yml 的用户块(首字符为换行,调用方直接 append)。 */
export function buildUserBlock(username, displayName, email, argon2Hash, group) {
  const lines = [
    '',
    `  ${username}:`,
    '    disabled: false',
    `    displayname: "${sanitizeYamlScalar(displayName || username)}"`,
    `    password: "${argon2Hash}"`,
    ...(email ? [`    email: ${sanitizeYamlScalar(email, 254)}`] : []),
    '    groups:',
    `      - ${group}`
  ];
  return `${lines.join('\n')}\n`;
}

//#endregion
