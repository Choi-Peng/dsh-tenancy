// AI 生成声明:本模块由 AI 生成,可能存在错误或安全隐患,使用前请 review 并实测。
//
// P12:注册用户 ↔ Linux 系统用户(1:1)自动开通。
//   · 新成员注册成功后,以同一用户名创建系统账号:`useradd -M -s nologin`,
//     不设密码(shadow 固有 '!' 锁定)、不在任何管理组、shell 为 nologin
//     —— 即「不可登录服务器」;
//   · 该账号的**唯一**文件权限是其个人工作区(memberWorkspaceRoot/<user>,
//     默认 /root/dsh/<user>):插件递归 chown + 目录 0700;
//   · 幂等:已存在同名账号时校验 home/shell 是否与本插件约定一致——一致视为
//     本插件所建(继续 chown),不一致视为冲突(不 chown,交运维裁决);
//   · 全部外部命令经 execFile 参数数组传递(用户名已过 checkUsername,仍不进 shell);
//   · exec/exists 可注入,离线自测不真实建号。
//
// 明确不做:不设/不重置系统口令、不加 sudo/wheel、不动 /root 等祖先目录权限
//   (仅在其阻止穿越时告警并给出建议命令,由运维裁决)。

import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { chmod, lchown, readdir, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** 单条外部命令超时:passwd/group 库操作是毫秒级,15s 足够宽裕。 */
const EXEC_TIMEOUT_MS = 15_000;

/** 递归 chown 的条目数上限(防失控树拖死注册路径;超过记错误并停止)。 */
const CHOWN_MAX_ENTRIES = 50_000;

//#region 基础工具

/** promisified execFile(参数数组,不经 shell;注入点:自测传 fake)。 */
export function execFileP(file, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, ...opts }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout ?? '');
        error.stderr = String(stderr ?? '');
        return rejectPromise(error);
      }
      return resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** 解析 getent passwd 输出行(name:x:uid:gid:gecos:home:shell);畸形行返回 null。 */
export function parsePasswdLine(line) {
  if (typeof line !== 'string') return null;
  const f = line.trim().split(':');
  if (f.length < 7) return null;
  const uid = Number(f[2]);
  const gid = Number(f[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
  return { user: f[0], uid, gid, home: f[5], shell: f[6] };
}

/** 是否「不可登录」shell(nologin / false 家族)。 */
export function isNoLoginShell(shell) {
  const s = String(shell ?? '');
  return s.endsWith('/nologin') || s === '/bin/false' || s === 'nologin' || s === 'false';
}

/**
 * 解析实际可用的 nologin shell:配置路径存在则用之;否则按常见路径回落,
 * 全部缺失(极简容器)返回 null(调用方放弃创建并告警)。
 */
export function resolveNologinShell(configured, exists = existsSync) {
  const candidates = [configured, '/usr/sbin/nologin', '/sbin/nologin', '/bin/false']
    .filter((p) => typeof p === 'string' && p !== '');
  for (const p of candidates) {
    try { if (exists(p)) return p; } catch { /* 探测失败换下一个 */ }
  }
  return null;
}

//#endregion

//#region 账号查询与创建

/**
 * getent passwd 查询账号;不存在返回 null,查询机制异常抛错。
 * getent 退出码约定:0=命中,2=不存在(其余视为异常)。
 */
export async function accountLookup(username, exec = execFileP) {
  let out;
  try {
    out = await exec('getent', ['passwd', String(username)]);
  } catch (e) {
    if (e?.code === 2) return null;
    throw new Error(`getent passwd failed: ${e?.message ?? e}`);
  }
  const line = String(out.stdout ?? '').split('\n')[0] ?? '';
  return parsePasswdLine(line);
}

/**
 * 幂等确保系统用户存在(不存在则 useradd)。
 * 返回:{status:'created'|'exists', uid, gid, home, shell} 或
 *       {status:'conflict', ...现有信息}(同名账号但 home/shell 与约定不符,不接管)或
 *       {status:'error', reason, message}。
 *
 * 设计要点:
 *   · `-M`(不建 home):home 由插件按围栏根创建,与 useradd 的 skel 逻辑无关;
 *   · 不传 -p:shadow 固有 '!' 密码锁定 —— 密码登录/SSH 公钥(无授权键)均不可用;
 *   · 先 `-U`(建同名主组,RHEL/Debian 通用);组名被占等失败再以 `-N` 回落;
 *   · 「已存在」仅当 home 与 shell 都与约定一致才视为本插件所建,防误接管
 *     运维手工建的同名账号后把其目录 chown 掉。
 */
export async function ensureSystemUser({
  username, homeDir, shell, comment = '', timeoutMs, exec = execFileP
}) {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { status: 'error', reason: 'not-root', message: '创建系统用户需要 root 权限(dsh 需以 root 运行)' };
  }
  const info = await accountLookup(username, exec);
  if (info) {
    if (info.home === homeDir && isNoLoginShell(info.shell)) {
      return { status: 'exists', ...info };
    }
    return { status: 'conflict', ...info };
  }
  // useradd:密码缺省锁定;注释用 -c(可含空格,由 execFile 保证不拆参)
  const base = ['--no-create-home', '--home-dir', homeDir, '--shell', shell, '--comment', comment];
  const opts = timeoutMs ? { timeout: timeoutMs } : {};
  try {
    await exec('useradd', [...base, '--user-group', username], opts);
  } catch (firstError) {
    // 组名冲突等:回落「不建同名组」再试一次(主组用发行版默认)
    try {
      await exec('useradd', [...base, '--no-user-group', username], opts);
    } catch (e) {
      return {
        status: 'error', reason: 'useradd-failed',
        message: String(e?.stderr || firstError?.stderr || e?.message || firstError?.message || 'useradd failed').trim().slice(0, 300)
      };
    }
  }
  const created = await accountLookup(username, exec);
  if (!created) return { status: 'error', reason: 'verify-failed', message: 'useradd 后 getent 查不到账号' };
  return { status: 'created', ...created };
}

//#endregion

//#region 文件归属(个人工作区 → 系统用户)

/**
 * 递归 chown(不跟随符号链接,lchown 语义);返回 {count, errors:[{path,message}]}。
 * 纯 node 实现:不依赖 chown 二进制的 PATH/位置,也杜绝把路径拼进 shell 的注入面。
 * 条目数超 CHOWN_MAX_ENTRIES 即停止并记一条 limit 错误(防异常巨树拖死注册路径)。
 */
export async function chownRecursive(root, uid, gid) {
  const errors = [];
  let count = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      errors.push({ path: dir, message: String(e?.message ?? e) });
      return;
    }
    for (const entry of entries) {
      if (count >= CHOWN_MAX_ENTRIES) {
        errors.push({ path: root, message: `entry-limit-reached(${CHOWN_MAX_ENTRIES})` });
        return;
      }
      const full = resolve(dir, entry.name);
      count += 1;
      try {
        await lchown(full, uid, gid);
      } catch (e) {
        errors.push({ path: full, message: String(e?.message ?? e) });
      }
      if (entry.isDirectory()) await walk(full);
    }
  };
  try {
    await lchown(root, uid, gid);
    count += 1;
  } catch (e) {
    errors.push({ path: root, message: String(e?.message ?? e) });
    // 根都不存在:整树无从谈起,直接返回(避免 walk 再记一条重复 ENOENT)
    if (e?.code === 'ENOENT') return { count, errors };
  }
  await walk(root);
  return { count, errors };
}

/** 目录置 0700(仅 owner+root 可入;配合 chown 即「只有本人和 root 能进」)。 */
export async function chmodPrivateDir(root) {
  return chmod(root, 0o700);
}

/**
 * 检查 homeDir 的祖先链上是否存在「其他用户无执行位」的目录(如 /root 0750)。
 * 命中则系统用户即使拥有 home 也无法穿越抵达——返回这些祖先路径数组供告警。
 * 保守口径:只认 o+x;属主/组恰好放行的情形不特判(宁可多提醒,不静默漏提醒)。
 */
export function traversalBlockers(homeDir, lstatImpl = lstatSync) {
  const blockers = [];
  let cur = dirname(resolve(homeDir));
  for (;;) {
    try {
      const st = lstatImpl(cur);
      if (st.isDirectory() && !(st.mode & 0o001)) blockers.push(cur);
    } catch { /* 不存在/不可探测:跳过 */ }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return blockers.reverse(); // 自浅至深,读起来更直观(/root → …)
}

//#endregion
