// AI 生成声明:本模块由 AI 生成,可能存在错误或安全隐患,使用前请 review 并实测。
//
// P4:邀请码注册(Authelia file 后端用户库直写)。
//   · InviteStore —— $DSH_HOME/tenancy/invites.json 旁车存储(原子写+文件锁),
//     只存邀请码的 SHA-256(明码仅在生成响应中出现一次);
//   · 邀请码一次性:消费在 withFileLock 临界区内完成(查未用→写用户库→标记已用);
//   · 用户库写入用 O_APPEND 单次 write(保 inode);Authelia 侧须开启
//     authentication_backend.file.watch: true 才会动态重载(该选项默认 false!)
//   · GET /register 出静态页;POST /register/api 受每 IP 固定窗口限流。
//
// 明确不做:邮件验证、密码找回、防机器人的图形验证码(内部小团队场景)。

import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, readFile, stat } from 'node:fs/promises';
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write';
import {
  buildUserBlock,
  checkEmail,
  checkPassword,
  checkUsername,
  normalizeInviteCode,
  usersYmlHasUser
} from './util.js';

const INVITE_BYTES = 16; // → 16 个 base32 字符 = 128 bit 熵
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const REGISTER_BODY_LIMIT = 8 * 1024;
/** 每 IP 每 10 分钟最多 10 次 POST(含失败尝试)。 */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 10;

//#region 邀请码

function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 邀请码指纹:归一化后取 SHA-256(存储与查找必须同源)。 */
function codeHash(code) {
  return sha256hex(normalizeInviteCode(code));
}

/** 生成形如 XXXX-XXXX-XXXX-XXXX 的一次性邀请码(128bit 熵,无易混字符)。 */
export function generateInviteCode() {
  const bytes = randomBytes(INVITE_BYTES);
  let raw = '';
  for (let i = 0; i < bytes.length; i += 1) {
    raw += BASE32[bytes[i] % 32]; // 取模偏差 < 2^-4/字节,对邀请码强度无实际影响
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export class InviteStore {
  #path; #cache = null; #mtimeMs = 0;

  constructor(path) { this.#path = path; }

  async #load() {
    try {
      const st = await stat(this.#path);
      if (this.#cache && st.mtimeMs === this.#mtimeMs) return this.#cache;
      this.#cache = { version: 1, invites: {}, ...JSON.parse(await readFile(this.#path, 'utf8')) };
      this.#mtimeMs = st.mtimeMs;
    } catch {
      this.#cache = { version: 1, invites: {} };
    }
    return this.#cache;
  }

  async #persist(db) {
    await writeFileAtomic(this.#path, JSON.stringify(db, null, 2), { dirMode: 0o700, mode: 0o600 });
    this.#cache = db;
    try { this.#mtimeMs = (await stat(this.#path)).mtimeMs; } catch {}
  }

  /** 读-改-写全程持锁。 */
  async mutate(mutator) {
    const { mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(this.#path), { recursive: true });
    return withFileLock(`${this.#path}.lock`, async () => {
      const db = await this.#load();
      const result = mutator(db);
      await this.#persist(db);
      return result;
    });
  }

  get lockPath() { return `${this.#path}.lock`; }
  async all() { return this.#load(); }

  /**
   * 消费邀请码(标记 usedBy/usedAt)。⚠ 调用方必须已持有本 store 的文件锁
   * (withFileLock 不可重入——注册临界区内绝不能再走 mutate/再抢同一把锁,
   * 否则必然等锁超时)。同进程互斥由外层锁保证;跨进程由文件锁保证。
   */
  async consumeLocked(id, username) {
    const db = await this.#load();
    const rec = db.invites[String(id)];
    if (!rec || rec.usedBy || rec.revoked) return false;
    rec.usedBy = username;
    rec.usedAt = Date.now();
    await this.#persist(db);
    return true;
  }

  /** 管理端列表(id=哈希前缀,不含完整码)。 */
  async list() {
    const db = await this.all();
    return Object.entries(db.invites)
      .map(([id, rec]) => ({
        id,
        createdAt: rec.createdAt ?? null,
        note: rec.note ?? '',
        createdBy: rec.createdBy ?? null,
        usedBy: rec.usedBy ?? null,
        usedAt: rec.usedAt ?? null,
        revoked: Boolean(rec.revoked)
      }))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  /** 批量生成;返回明码(仅此一次)+ id。 */
  async create(count, createdBy, note) {
    const out = [];
    await this.mutate((db) => {
      for (let i = 0; i < count; i += 1) {
        const code = generateInviteCode();
        const hash = codeHash(code);
        const id = hash.slice(0, 12);
        db.invites[id] = {
          hash,
          createdAt: Date.now(),
          createdBy: createdBy ?? null,
          note: note ?? ''
        };
        out.push({ code, id });
      }
    });
    return out;
  }

  async revoke(id) {
    let done = false;
    await this.mutate((db) => {
      const rec = db.invites[String(id)];
      if (rec && !rec.usedBy && !rec.revoked) {
        rec.revoked = true;
        rec.revokedAt = Date.now();
        done = true;
      }
    });
    return done;
  }

  /**
   * 按明码取记录(不消费);返回 {id,rec} 或错误码。
   * 消费方(registerUser)负责在同一把锁内完成"检查→写用户库→标记已用"。
   */
  async peek(code) {
    const hash = codeHash(code);
    const db = await this.all();
    for (const [id, rec] of Object.entries(db.invites)) {
      if (rec.hash === hash) {
        if (rec.usedBy) return { error: 'invite-used' };
        if (rec.revoked) return { error: 'invite-revoked' };
        return { id, rec };
      }
    }
    return { error: 'invite-invalid' };
  }
}

//#endregion

//#region Authelia 用户库写入

/** 经 authelia CLI 生成 argon2id 哈希;密码经环境变量传递,不进 argv。 */
export function hashArgon2(autheliaBin, password) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('/bin/sh', ['-c', 'exec "$AUTHELIA_BIN" crypto hash generate argon2 --password "$REG_PW"'], {
      env: { ...process.env, AUTHELIA_BIN: autheliaBin, REG_PW: String(password) },
      timeout: 20_000
    }, (error, stdout) => {
      if (error) return rejectPromise(new Error(`authelia hash failed: ${error.message}`));
      // 完整 argon2 编码:v/m/t/p 参数段含逗号(旧字符类漏逗号导致哈希被截断、登录必败),
      // 末尾两段为 base64(salt) 与 base64(digest)
      const m = /\$argon2[a-z0-9]{0,2}\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+/.exec(String(stdout));
      if (!m) return rejectPromise(new Error('authelia hash unparsable'));
      return resolvePromise(m[0]);
    });
  });
}

/**
 * 追加用户到 users.yml:O_APPEND 单次 write 保 inode(Authelia 的文件监听不断)。
 * 失败抛错由上层兜底;成功返回写入字节数。
 */
export async function appendUserToUsersYml(usersPath, block) {
  const handle = await open(usersPath, 'a', 0o644);
  try {
    const { bytesWritten } = await handle.write(Buffer.from(block, 'utf8'), 0, undefined, null);
    return bytesWritten;
  } finally {
    await handle.close();
  }
}

//#region 修改密码(用户中心;Authelia file 后端用户库原地改写)

/**
 * 经 authelia CLI 校验旧密码:密码与哈希都经环境变量传递,不进 argv。
 * 返回布尔(exit 0 = 匹配)。
 */
export function verifyAutheliaPassword(autheliaBin, password, hash) {
  return new Promise((resolvePromise) => {
    execFile('/bin/sh', ['-c', 'exec "$AUTHELIA_BIN" crypto hash validate --password "$REG_PW" -- "$REG_HASH"'], {
      env: { ...process.env, AUTHELIA_BIN: autheliaBin, REG_PW: String(password), REG_HASH: String(hash) },
      timeout: 20_000
    }, (error, stdout) => {
      if (error) return resolvePromise(false);
      const text = String(stdout ?? '');
      // ⚠ authelia CLI 对「密码不匹配」仍返回 exit 0,只能靠输出文本区分
      return resolvePromise(/matches the digest/.test(text) && !/does not match/.test(text));
    });
  });
}

/** 从 users.yml 文本中取出该用户当前 password 哈希(块内 4 空格缩进;取不到返回 null)。 */
export function extractUserPasswordHash(usersYmlText, username) {
  if (typeof usersYmlText !== 'string') return null;
  const esc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^  ' + esc + ':\\s*\\n((?:^    [^\\n]*\\n)*?)^    password:\\s*"?([^"\\n]+)"?\\s*$', 'm');
  const m = re.exec(usersYmlText);
  return m ? m[2] : null;
}

/**
 * 替换 users.yml 文本中该用户块内的 password 行(纯函数;块内首个 4 空格 password 行)。
 * 返回 { text, replaced }。
 */
export function replaceUserPasswordInYml(text, username, newHash) {
  const lines = String(text ?? '').split('\n');
  const key = `  ${username}:`;
  const out = [];
  let inBlock = false;
  let replaced = false;
  for (const line of lines) {
    if (!inBlock && line === key) { inBlock = true; out.push(line); continue; }
    if (inBlock) {
      // 非 4 空格缩进的非空行 = 下一用户的键,块结束
      if (line.trim() !== '' && !line.startsWith('    ')) inBlock = false;
      else if (!replaced && /^    password:\s*/.test(line)) {
        out.push(`    password: "${newHash}"`);
        replaced = true;
        continue;
      }
    }
    out.push(line);
  }
  return { text: out.join('\n'), replaced };
}

/** 原地重写文件(保 inode,Authelia 文件监听不断):先写新内容再截断,失败回滚旧内容。 */
async function rewriteFilePreservingInode(filePath, newText, oldText) {
  const handle = await open(filePath, 'r+', 0o644);
  try {
    const buf = Buffer.from(newText, 'utf8');
    await handle.write(buf, 0, buf.length, 0);
    await handle.truncate(buf.length);
    await handle.sync();
  } catch (error) {
    try {
      const rollback = Buffer.from(oldText, 'utf8');
      await handle.truncate(0);
      await handle.write(rollback, 0, rollback.length, 0);
      await handle.sync();
    } catch { /* 回滚失败:文件可能损坏,由运维介入 */ }
    throw error;
  } finally {
    await handle.close();
  }
}

/**
 * 修改密码事务:持同一把邀请码库文件锁(与注册追加串行),读 users.yml →
 * 校验旧密码 → 生成新哈希 → 原地改写(保 inode)。返回 {ok:true} 或 {ok:false,error}。
 */
export async function changeUserPassword(deps, input) {
  const { store, audit, autheliaUsersPath, autheliaBin, actorHint } = deps;
  const username = String(input?.username ?? '').trim();
  const currentPassword = input?.currentPassword;
  const newPassword = input?.newPassword;

  if (username === '') return { ok: false, error: 'username-invalid' };
  const pwErr = checkPassword(newPassword);
  if (pwErr) return { ok: false, error: pwErr };
  if (typeof currentPassword !== 'string' || currentPassword === '') {
    return { ok: false, error: 'current-password-required' };
  }

  // argon2 生成/校验约 100~500ms,量级小,直接整体放锁内保证与注册追加互斥
  const outcome = await withFileLock(store.lockPath, async () => {
    let usersText;
    try {
      usersText = await readFile(autheliaUsersPath, 'utf8');
    } catch {
      return { ok: false, error: 'server-error' };
    }
    if (!usersYmlHasUser(usersText, username)) return { ok: false, error: 'user-not-found' };
    const currentHash = extractUserPasswordHash(usersText, username);
    if (!currentHash) return { ok: false, error: 'server-error' };
    const valid = await verifyAutheliaPassword(autheliaBin, currentPassword, currentHash);
    if (!valid) return { ok: false, error: 'current-password-wrong' };

    let hash;
    try {
      hash = await hashArgon2(autheliaBin, newPassword);
    } catch (e) {
      audit.record({ actor: username, action: 'password.change-fail', reason: 'hash-error', detail: String(e?.message ?? e).slice(0, 200) });
      return { ok: false, error: 'server-error' };
    }

    const replaced = replaceUserPasswordInYml(usersText, username, hash);
    if (!replaced.replaced) return { ok: false, error: 'server-error' };
    try {
      await rewriteFilePreservingInode(autheliaUsersPath, replaced.text, usersText);
    } catch (e) {
      audit.record({ actor: username, action: 'password.change-fail', reason: 'users-write-failed', detail: String(e?.message ?? e).slice(0, 200) });
      return { ok: false, error: 'server-error' };
    }
    return { ok: true };
  });

  if (outcome.ok) {
    audit.record({ actor: username, action: 'password.change', via: actorHint });
  } else if (outcome.error !== 'current-password-wrong') {
    audit.record({ actor: username, action: 'password.change-fail', reason: outcome.error, via: actorHint });
  }
  return outcome;
}

//#endregion

/**
 * 完整注册事务:校验→生成哈希→持锁(查邀请未用→查用户不存在→追加 users.yml→标记邀请已用)。
 * 返回 {ok:true} 或 {ok:false,error}。users.yml 不存在时直接报 server-error(部署问题)。
 */
export async function registerUser(deps, input) {
  const { store, audit, autheliaUsersPath, autheliaBin, group, actorHint } = deps;
  const username = String(input?.username ?? '').trim();
  const displayName = typeof input?.displayName === 'string' ? input.displayName.trim() : '';
  const email = typeof input?.email === 'string' ? input.email.trim() : '';
  const password = input?.password;
  const code = input?.invite;

  const userErr = checkUsername(username);
  if (userErr) return { ok: false, error: userErr };
  const pwErr = checkPassword(password);
  if (pwErr) return { ok: false, error: pwErr };
  const mailErr = checkEmail(email);
  if (mailErr) return { ok: false, error: mailErr };
  if (typeof code !== 'string' || normalizeInviteCode(code).length < 8) return { ok: false, error: 'invite-invalid' };

  // 哈希放在锁外(argon2 约 100~500ms,别占着全局注册锁)
  let hash;
  try {
    hash = await hashArgon2(autheliaBin, password);
  } catch (e) {
    audit.record({ actor: username, action: 'register.fail', reason: 'hash-error', detail: String(e?.message ?? e).slice(0, 200) });
    return { ok: false, error: 'server-error' };
  }

  const outcome = await withFileLock(store.lockPath, async () => {
    // ① 邀请码必须存在且未被消费/撤销
    const hit = await store.peek(code);
    if (hit.error) return { ok: false, error: hit.error };

    // ② 用户名不得已存在(锁内重读,防并发双写)
    let usersText;
    try {
      usersText = await readFile(autheliaUsersPath, 'utf8');
    } catch {
      return { ok: false, error: 'server-error' };
    }
    if (usersYmlHasUser(usersText, username)) return { ok: false, error: 'username-taken' };

    // ③ 追加用户库 → 成功后才标记邀请已用(崩溃窗口=邀请仍可用,重试会撞 username-taken,安全方向正确)
    try {
      await appendUserToUsersYml(autheliaUsersPath, buildUserBlock(username, displayName, email, hash, group));
    } catch (e) {
      audit.record({ actor: username, action: 'register.fail', reason: 'users-write-failed', detail: String(e?.message ?? e).slice(0, 200) });
      return { ok: false, error: 'server-error' };
    }
    await store.consumeLocked(hit.id, username);
    return { ok: true, inviteId: hit.id };
  });

  if (outcome.ok) {
    audit.record({ actor: username, action: 'register.success', inviteId: outcome.inviteId, via: actorHint });
  } else if (outcome.error !== 'invite-invalid' && outcome.error !== 'invite-used' && outcome.error !== 'invite-revoked'
    && outcome.error !== 'username-taken') {
    audit.record({ actor: username, action: 'register.fail', reason: outcome.error });
  }
  return outcome;
}

//#endregion

//#region 每 IP 限流

const rateMap = new Map(); // ip → { count, resetAt }
let lastSweep = 0;
const RATE_MAX_KEYS = 4096; // 假 IP 洪水下的内存上限(超限立即清过期桶,仍超限则折中重建)

export function rateLimitCheck(ip, now = Date.now()) {
  if (!ip) ip = '?';
  if (now - lastSweep > RATE_WINDOW_MS) {
    lastSweep = now;
    for (const [k, v] of rateMap) if (v.resetAt <= now) rateMap.delete(k);
  }
  let bucket = rateMap.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    if (rateMap.size >= RATE_MAX_KEYS) {
      for (const [k, v] of rateMap) if (v.resetAt <= now) rateMap.delete(k);
      // 全是新鲜桶(极端假 IP 洪水)时清空重来:宁可短暂失去限流史,也不能无界吃内存
      if (rateMap.size >= RATE_MAX_KEYS) rateMap.clear();
    }
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateMap.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count <= RATE_MAX;
}

/**
 * 注册请求的限流键。⚠ 不取 XFF 最左值——那是完全由客户端控制的字段(nginx 的
 * $proxy_add_x_forwarded_for 只会把它拼在链首),每次换一个就能绕过限流。
 * 优先用本机 nginx/Caddy 追加的真实 IP(X-Real-IP,不可被链上伪造值影响),
 * 其次回退到 socket 地址(经 Caddy 反代后恒为 127.0.0.1 —— 粗,但安全方向正确)。
 */
export function clientIpOf(req) {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim() !== '') return real.trim().slice(0, 64);
  return req.socket?.remoteAddress ?? '?';
}

//#endregion

//#region HTTP 层(GET /register 页面 + POST /register/api)

const ERROR_TEXT_ZH = {
  'invite-invalid': '邀请码无效',
  'invite-used': '邀请码已被使用',
  'invite-revoked': '邀请码已被撤销',
  'username-invalid': '用户名需以字母开头,3–32 位字母/数字/-/_',
  'username-taken': '用户名已被占用',
  'password-weak': '密码长度需为 8–128 位',
  'email-invalid': '邮箱格式不正确',
  'rate-limited': '尝试过于频繁,请稍后再试',
  'server-error': '服务器开小差了,请联系管理员'
};

const ERROR_TEXT_EN = {
  'invite-invalid': 'Invalid invite code',
  'invite-used': 'This invite code has already been used',
  'invite-revoked': 'This invite code has been revoked',
  'username-invalid': 'Username must start with a letter; 3–32 chars of letters/digits/-/_',
  'username-taken': 'Username is already taken',
  'password-weak': 'Password must be 8–128 characters',
  'email-invalid': 'Invalid e-mail address',
  'rate-limited': 'Too many attempts, please retry later',
  'server-error': 'Server error, please contact the administrator'
};

/** 注入页面的错误文案表 {code:[zh,en]}(JSON 内联)。 */
const ERR_TEXTS_JSON = JSON.stringify(
  Object.fromEntries(Object.keys(ERROR_TEXT_ZH).map((k) => [k, [ERROR_TEXT_ZH[k], ERROR_TEXT_EN[k] ?? k]]))
);

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>注册 · DSH</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; }
  @media (prefers-color-scheme: dark) { body { background: #17181c; color: #e8eaed; } }
  .card { width: min(400px, calc(100vw - 40px)); background: #fff; border-radius: 14px;
          padding: 28px 26px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) { .card { background: #232529; box-shadow: 0 8px 30px rgba(0,0,0,.45); } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { font-size: 13px; opacity: .65; margin: 0 0 18px; }
  label { display: block; font-size: 13px; margin-bottom: 12px; opacity: .9; }
  input { display: block; width: 100%; margin-top: 5px; padding: 8px 10px; font-size: 14px;
          border: 1px solid rgba(127,127,127,.45); border-radius: 8px; background: transparent; color: inherit; }
  input:focus { outline: 2px solid #4f6ef7; outline-offset: -1px; border-color: transparent; }
  button { width: 100%; padding: 10px 0; font-size: 14px; font-weight: 600; cursor: pointer;
           border: 0; border-radius: 8px; background: #4f6ef7; color: #fff; margin-top: 4px; }
  button:disabled { opacity: .55; cursor: default; }
  .msg { font-size: 13px; min-height: 18px; margin: 12px 0 0; }
  .msg.err { color: #d54941; } .msg.ok { color: #2e9e5b; }
  .login { font-size: 13px; opacity: .75; margin-top: 14px; text-align: center; }
  a { color: #4f6ef7; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <h1>DSH 注册</h1>
  <p class="sub">本站采用邀请制,邀请码一次性有效。</p>
  <form id="reg">
    <label data-i="inviteLabel">邀请码<input name="invite" required autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX" spellcheck="false"></label>
    <label data-i="userLabel">用户名<input name="username" required autocomplete="username" spellcheck="false" pattern="[a-zA-Z][a-zA-Z0-9_-]{1,31}" title="以字母开头,3–32 位字母/数字/-/_"></label>
    <label data-i="displayLabel">显示名(选填)<input name="displayName" autocomplete="nickname" maxlength="64"></label>
    <label data-i="emailLabel">邮箱(选填)<input type="email" name="email" autocomplete="email" maxlength="254"></label>
    <label data-i="pwLabel">密码(至少 8 位)<input type="password" name="password" required minlength="8" maxlength="128" autocomplete="new-password"></label>
    <label data-i="pw2Label">确认密码<input type="password" name="password2" required minlength="8" autocomplete="new-password"></label>
    <button type="submit" data-i="submitLabel">注 册</button>
    <p class="msg" id="msg"></p>
  </form>
  <p class="login"><span data-i="haveAccount">已有账号?</span> <a href="/auth/?rd=%2F" data-i="toLogin">直接登录</a></p>
</div>
<script>
(function () {
  var zh = navigator.language && navigator.language.indexOf('zh') === 0;
  var T = {
    inviteLabel: ['邀请码', 'Invite code'],
    userLabel: ['用户名', 'Username'],
    displayLabel: ['显示名(选填)', 'Display name (optional)'],
    emailLabel: ['邮箱(选填)', 'E-mail (optional)'],
    pwLabel: ['密码(至少 8 位)', 'Password (min 8 chars)'],
    pw2Label: ['确认密码', 'Confirm password'],
    submitLabel: ['注 册', 'Sign up'],
    haveAccount: ['已有账号?', 'Already registered?'],
    toLogin: ['直接登录', 'Sign in'],
    pwMismatch: ['两次输入的密码不一致', 'Passwords do not match'],
    registering: ['提交中…', 'Submitting…'],
    success: ['注册成功!正在前往登录…', 'Success! Taking you to sign in…']
  };
  if (!zh) {
    document.querySelectorAll('[data-i]').forEach(function (el) {
      var pair = T[el.getAttribute('data-i')];
      if (pair) el.firstChild.textContent = pair[1];
    });
    document.title = 'Sign up \\u00b7 DSH';
    document.querySelector('.sub').textContent = 'Registration is invite-only; each code works once.';
  }
  var msg = document.getElementById('msg');
  function say(text, cls) { msg.textContent = text; msg.className = 'msg ' + (cls || ''); }
  document.getElementById('reg').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = ev.target;
    if (f.password.value !== f.password2.value) { say(T.pwMismatch[zh ? 0 : 1], 'err'); return; }
    var btn = f.querySelector('button');
    btn.disabled = true; say(T.registering[zh ? 0 : 1], '');
    fetch('/register/api', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invite: f.invite.value, username: f.username.value,
        displayName: f.displayName.value, email: f.email.value,
        password: f.password.value
      })
    }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (d) {
      if (d && d.ok) {
        // 注册成功 → 自动 continue(1.2s 停留展示成功提示后跳转登录页);
        // 按钮保持禁用,防止跳转前的重复提交。replace() 让后退键不回到已消费邀请码的表单页。
        say(T.success[zh ? 0 : 1], 'ok');
        setTimeout(function () { window.location.replace('/auth/?rd=%2F'); }, 1200);
      } else {
        var code = d && d.error ? d.error : 'server-error';
        var pair = ERRTEXTS[code] || [code, code];
        say(pair[zh ? 0 : 1], 'err');
      }
      btn.disabled = false;
    }).catch(function () { say(ERRTEXTS['server-error'][zh ? 0 : 1], 'err'); btn.disabled = false; });
  });
})();
</script>
<script>var ERRTEXTS=${ERR_TEXTS_JSON};</script>
</body>
</html>
`;

/** prefix '/register' 的处理器工厂。 */
export function createRegisterRoutes(deps) {
  // deps: { config, store, audit, logger, isTrusted }
  return async function registerRoutes(req, res) {
    try {
      // 该路径在 Caddy 侧不走 forward_auth(无身份),但来源仍需过 browser-trust 围栏;
      // 未注入判定函数时 fail-closed,绝不默认放行。
      if (deps.isTrusted?.(req) !== true) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        return void res.end('tenancy: untrusted request origin');
      }
      const url = new URL(req.url, 'http://tenancy.internal');
      const pathname = url.pathname.replace(/^\/register/, '') || '/';

      if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname.startsWith('/?'))) {
        const buf = Buffer.from(PAGE_HTML, 'utf8');
        res.writeHead(req.method === 'HEAD' ? 200 : 200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(buf.length),
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex'
        });
        return void res.end(req.method === 'HEAD' ? undefined : buf);
      }

      if (req.method === 'POST' && pathname === '/api') {
        const ip = clientIpOf(req);
        if (!rateLimitCheck(ip)) {
          deps.audit.record({ actor: ip, action: 'register.fail', reason: 'rate-limited' });
          res.writeHead(429, { 'content-type': 'application/json' });
          return void res.end(JSON.stringify({ ok: false, error: 'rate-limited' }));
        }
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > REGISTER_BODY_LIMIT) break;
          chunks.push(chunk);
        }
        let payload = null;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 落到 invalid */ }
        const result = payload
          ? await registerUser({
            store: deps.store,
            audit: deps.audit,
            autheliaUsersPath: deps.config.autheliaUsersPath,
            autheliaBin: deps.config.autheliaBin,
            group: deps.config.registerGroup,
            actorHint: `ip:${ip}`
          }, payload)
          : { ok: false, error: 'invite-invalid' };
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return void res.end(JSON.stringify(result.ok ? { ok: true } : { ok: false, error: result.error }));
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return void res.end('not found');
    } catch (error) {
      deps.logger?.error?.(`tenancy: register route failure: ${error?.stack ?? error}`);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      return void res.end('internal error');
    }
  };
}

//#endregion
