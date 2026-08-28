#!/usr/bin/env node
// AI 生成声明:本脚本由 AI 生成,使用前请 review。
//
// 离线自测(P4):不依赖运行中的 dsh。
//   ① 路径围栏纯函数(confineToRoot / expandHomeDir / safeSegment)
//   ② 注册字段校验 + users.yml 文本工具
//   ③ InviteStore + registerUser 完整事务(argon2 哈希用真实 authelia CLI;
//      users.yml 写入临时目录,绝不触碰 /etc/authelia)
//   ④ 安全边界回归:围栏根 realpath 归一 + 注册限流键/内存上限 + browser-trust 围栏
// 用法:node scripts/selftest.mjs [--skip-slow](跳过 argon2 实测)

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confineToRoot, expandHomeDir, safeSegment, checkUsername, checkPassword, checkEmail,
  sanitizeYamlScalar, normalizeInviteCode, usersYmlHasUser, buildUserBlock,
  isTrustedApiRequest, isLoopbackHost, safeDecode } from '../lib/util.js';
import { InviteStore, registerUser, rateLimitCheck, clientIpOf } from '../lib/register.js';
import { AuditLog } from '../lib/audit.js';

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

const skipSlow = process.argv.includes('--skip-slow');

//#region ① 路径围栏

console.log('① 路径围栏');
{
  const dir = mkdtempSync(join(tmpdir(), 'tenancy-selftest-'));
  const root = join(dir, 'pool'); // 不预先创建:验证"沿不存在路径向上找存在祖先"
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  const realRoot = realpathSync(root);
  symlinkSync(join(dir, 'outside'), join(root, 'a', 'b', 'escape')); // 指向 root 外
  mkdirSync(join(root, 'inside-link-target'), { recursive: true });
  symlinkSync('inside-link-target', join(root, 'a', 'oklink'));

  const rp = (p) => { try { return realpathSync(p); } catch { return undefined; } };

  assert(confineToRoot(realRoot, join(root, 'a', 'b')) === join(root, 'a', 'b'), '根内普通路径放行并返回绝对路径');
  assert(confineToRoot(realRoot, join(root, '..', 'evil')) === null, '../ 越界拒绝');
  assert(confineToRoot(realRoot, '/etc/passwd') === null, '绝对路径越界拒绝');
  assert(confineToRoot(realRoot, '') === null, '空路径拒绝');
  assert(confineToRoot(realRoot, join(root, 'a', 'b', 'c', 'd')) === join(root, 'a', 'b', 'c', 'd'), '根内尚不存在的新目录放行(向上找存在祖先)');
  assert(confineToRoot(realRoot, join(root, 'a', 'b', 'escape')) === null, '符号链接逃逸拒绝');
  assert(confineToRoot(realRoot, join(root, 'a', 'oklink')) === join(root, 'a', 'oklink'), '指向根内的符号链接放行');
  assert(confineToRoot(realRoot, realRoot) === realRoot, '根自身放行');
  assert(expandHomeDir('~', '/home/u') === '/home/u', '~/ 展开');
  assert(expandHomeDir('~/dsh', '/home/u') === '/home/u/dsh', '~/dsh 展开');
  assert(safeSegment('..') === null && safeSegment('a/b') === null && safeSegment('ok-dir') === 'ok-dir', 'safeSegment 白名单语义');

  rmSync(dir, { recursive: true, force: true });
}

//#endregion

//#region ② 注册字段校验

console.log('② 注册字段校验');
{
  assert(checkUsername('alice') === null, '合法用户名');
  assert(checkUsername('1abc') === 'username-invalid', '数字开头拒绝');
  assert(checkUsername('ab') === 'username-invalid', '过短拒绝');
  assert(checkUsername('a'.repeat(33)) === 'username-invalid', '过长拒绝');
  assert(checkUsername('Admin') === 'username-taken', '保留名(大小写不敏感)拒绝');
  assert(checkPassword('short') === 'password-weak', '弱口令拒绝');
  assert(checkPassword('x'.repeat(8)) === null, '8 位口令通过');
  assert(checkEmail('a@b.cn') === null && checkEmail('bad-mail') === 'email-invalid', 'email 校验');
  assert(sanitizeYamlScalar('he"llo\nworld\\') === 'helloworld', 'YAML 标量清洗引号/换行/反斜杠(删除语义)');
  assert(normalizeInviteCode(' ab-cd ') === 'ABCD', '邀请码归一化去分隔符+大写');
  const yml = 'users:\n  alice:\n    disabled: false\n';
  assert(usersYmlHasUser(yml, 'alice') === true, 'users.yml 命中已存在用户');
  assert(usersYmlHasUser(yml, 'bob') === false, 'users.yml 未命中新用户');
  assert(usersYmlHasUser(yml, 'alic') === false, '前缀同名不误报');
}

//#endregion

//#region ③ 邀请码存储与注册事务

console.log('③ 邀请码存储与注册事务');
{
  const dir = mkdtempSync(join(tmpdir(), 'tenancy-selftest-reg-'));
  const store = new InviteStore(join(dir, 'invites.json'));
  const audit = new AuditLog(join(dir, 'audit.log'));
  const usersPath = join(dir, 'users.yml');
  writeFileSync(usersPath, '# test\nusers:\n  admin:\n    disabled: false\n    displayname: "admin"\n    password: "$argon2id$x"\n    groups:\n      - dsh-admins\n');

  const codes = await store.create(2, 'tester', 'selftest');
  assert(codes.length === 2 && codes.every((c) => /^[-A-Z2-7]{19}$/.test(c.code)), `批量生成明码(${codes[0].code})`);
  assert((await store.list()).length === 2, '列表可见两条');

  if (!skipSlow) {
    const deps = {
      store, audit,
      autheliaUsersPath: usersPath,
      autheliaBin: process.env.AUTHELIA_BIN || '/opt/authelia/authelia',
      group: 'dsh-team',
      actorHint: 'selftest'
    };

    const r1 = await registerUser(deps, { username: 'alice', displayName: 'Alice "A"', email: 'a@b.cn', password: 'correct horse', invite: codes[0].code });
    assert(r1.ok === true, '正常注册成功');
    const text = readFileSync(usersPath, 'utf8');
    assert(text.includes('  alice:') && text.includes('$argon2id$') && text.includes('- dsh-team'), 'users.yml 已追加用户块(argon2id + 组)');
    assert(/displayname: "Alice A"/.test(text), 'displayname 引号已被清洗');

    const r2 = await registerUser(deps, { username: 'bob', password: 'another-pass-123', invite: codes[0].code });
    assert(r2.ok === false && r2.error === 'invite-used', '同一邀请码二次使用被拒(invite-used)');

    const r3 = await registerUser(deps, { username: 'alice', password: 'another-pass-123', invite: codes[1].code });
    assert(r3.ok === false && r3.error === 'username-taken', '重名注册被拒(username-taken)');

    const r4 = await registerUser(deps, { username: 'bob', password: 'another-pass-123', invite: 'AAAA-BBBB-CCCC-DDDD' });
    assert(r4.ok === false && r4.error === 'invite-invalid', '无效邀请码被拒');

    assert(await store.revoke(codes[1].slice ? codes[1].id : codes[1].id) === true, '撤销未用邀请码');
    const r5 = await registerUser(deps, { username: 'carol', password: 'another-pass-123', invite: codes[1].code });
    assert(r5.ok === false && r5.error === 'invite-revoked', '已撤销邀请码被拒');
    assert(!readFileSync(usersPath, 'utf8').includes('  carol:'), '被拒注册未写用户库');

    // buildUserBlock 输出可被 YAML 缩进结构肉眼校验
    const block = buildUserBlock('dave', 'Dave', '', '$argon2id$k', 'dsh-team');
    assert(block.startsWith('\n  dave:\n') && block.includes('    groups:\n      - dsh-team') && !block.includes('email'), 'buildUserBlock 结构正确(email 空则省略)');
  }

  rmSync(dir, { recursive: true, force: true });
}

//#endregion

//#region ④ 安全边界回归

console.log('④ 安全边界回归');
{
  const dir = mkdtempSync(join(tmpdir(), 'tenancy-selftest-root-'));
  mkdirSync(join(dir, 'real'), { recursive: true });
  symlinkSync(join(dir, 'real'), join(dir, 'link'));

  // 围栏根必须 realpath 归一:否则 `~/dsh -> /` 这类配置会把整个文件系统当作「根内」
  assert(expandHomeDir(join(dir, 'link')) === realpathSync(join(dir, 'real')), '围栏根经符号链接时归一为真实路径');
  assert(expandHomeDir(join(dir, 'not-exist-yet')) === join(dir, 'not-exist-yet'), '目录尚不存在时退回词法路径(mkdir 后由启动流程二次归一)');
  assert(expandHomeDir('~/x', realpathSync(dir)) === join(realpathSync(dir), 'x'), '~/ 展开仍可用(目标不存在时保持词法路径)');

  // 限流键绝不取客户端可控的 XFF 最左值(每次换一个就能绕过)
  const spoof = clientIpOf({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: { remoteAddress: '127.0.0.1' } });
  assert(spoof === '127.0.0.1', 'clientIpOf 不信 XFF 最左值,回退 socket 地址');
  assert(clientIpOf({ headers: { 'x-real-ip': '9.9.9.9' }, socket: { remoteAddress: '127.0.0.1' } }) === '9.9.9.9', 'clientIpOf 取 nginx 追加的 X-Real-IP');

  const t0 = 1_700_000_000_000;
  let allowed = 0;
  for (let i = 0; i < 30; i += 1) if (rateLimitCheck('203.0.113.7', t0 + i)) allowed += 1;
  assert(allowed === 10, `同一 IP 窗口内限 10 次(实际 ${allowed})`);
  assert(rateLimitCheck('203.0.113.8', t0) === true, '其他 IP 不受影响');

  // browser-trust 围栏(影子路由自己的那道):挡 DNS rebinding 与跨站请求
  const TH = new Set(['dsh.example.com']);
  const trust = (host, extra = {}) => isTrustedApiRequest({ ...(host === null ? {} : { host }), ...extra }, TH);
  assert(trust('localhost:3088') === true, 'loopback Host 可信(Caddy 重写的特权路径)');
  assert(trust('127.0.0.1') === true && trust('[::1]:3088') === true, 'IPv4/IPv6 loopback 均可信');
  assert(trust('dsh.example.com', { origin: 'https://dsh.example.com' }) === true, '可信域名 + 同源 Origin');
  assert(trust('dsh.example.com:8443', { origin: 'https://dsh.example.com:8443' }) === true, '带端口条目同源可信');
  assert(trust('dsh.example.com', { origin: 'https://evil.test' }) === false, 'Origin 与 Host 不同源 → 拒');
  assert(trust('attacker.example', { origin: 'http://attacker.example' }) === false, 'Host 不在可信列表 → 拒(同源也不行)');
  assert(trust('evil.test', { 'sec-fetch-site': 'cross-site' }) === false, 'sec-fetch-site: cross-site → 拒');
  assert(trust(null) === false && trust('') === false && trust('exa mple') === false, '缺 Host / 不可解析 Host → 拒');
  assert(isLoopbackHost('LOCALHOST') === true && isLoopbackHost('127.8.9.1') === true && isLoopbackHost('example.com') === false, 'isLoopbackHost 判定');
  assert(safeDecode('%zz') === null && safeDecode('a%20b') === 'a b', 'safeDecode 容错畸形转义(不致 500)');

  // 围栏根是指向根外目录的符号链接时的回归。结论修正:confineToRoot 的 within(real)
  // 本来就会拒掉「符号链接根 + 真实前缀」的组合,所以根是指向盘符的链接时**不会**
  // 逃逸文件系统;但成员按真实路径发请求会被全部误拒(可用性缺陷),错误消息还会
  // 泄露未解析的词法根。归一后两者都对:真实前缀放行,根外路径仍拒。
  const d2 = mkdtempSync(join(tmpdir(), 'tenancy-selftest-f3-'));
  mkdirSync(join(d2, 'outside'), { recursive: true });
  mkdirSync(join(d2, 'pool'), { recursive: true });
  symlinkSync(join(d2, 'outside'), join(d2, 'pool', 'fence'));
  const lexicalRoot = join(d2, 'pool', 'fence');
  const realRoot = expandHomeDir(lexicalRoot); // 插件现在使用的归一根
  assert(realRoot === realpathSync(join(d2, 'outside')) && realRoot !== lexicalRoot, '围栏根解析到符号链接目标(与词法根不同)');
  assert(confineToRoot(lexicalRoot, join(lexicalRoot, 'etc')) === null, '词法根下根外真实路径被误拒(旧行为:符号链接根破坏可用性)');
  assert(confineToRoot(realRoot, join(realRoot, 'etc')) === join(realRoot, 'etc'), '归一根下同一语义路径正常放行');
  assert(confineToRoot(realRoot, join(realRoot, '..')) === null, '归一根后根外路径仍然被拒');
  assert(confineToRoot(realRoot, join(lexicalRoot, 'sub')) === null, '符号链接前缀被词法判定拒绝(安全方向)');
  rmSync(d2, { recursive: true, force: true });

  rmSync(dir, { recursive: true, force: true });
}

//#endregion

console.log(`\n结果:${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
