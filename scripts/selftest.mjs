#!/usr/bin/env node
// AI 生成声明:本脚本由 AI 生成,使用前请 review。
//
// 离线自测(P4):不依赖运行中的 dsh。
//   ① 路径围栏纯函数(confineToRoot / expandHomeDir / safeSegment)
//   ② 注册字段校验 + users.yml 文本工具
//   ③ InviteStore + registerUser 完整事务(argon2 哈希用真实 authelia CLI;
//      users.yml 写入临时目录,绝不触碰 /etc/authelia)
//   ④ 安全边界回归:围栏根 realpath 归一 + 注册限流键/内存上限 + browser-trust 围栏
//   ⑥ P7 pending 读穿回归(影子路由级):new session 首条 prompt 落盘前,创建者
//      的 models/history/selectModel 不再 403(修复「模型列表永卡 Refreshing…」
//      与「Failed to load history HTTP 403」),WS 帧过滤同窗读穿,且不水平越权
// 用法:node scripts/selftest.mjs [--skip-slow](跳过 argon2 实测)

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { confineToRoot, expandHomeDir, safeSegment, checkUsername, checkPassword, checkEmail,
  sanitizeYamlScalar, normalizeInviteCode, usersYmlHasUser, buildUserBlock,
  isTrustedApiRequest, isLoopbackHost, safeDecode, recordReadable, recordWritable,
  workspaceSharedUsers, workspaceCreatable, workspaceVisible } from '../lib/util.js';
import { InviteStore, registerUser, rateLimitCheck, clientIpOf,
  hashArgon2, verifyAutheliaPassword, extractUserPasswordHash, replaceUserPasswordInYml, changeUserPassword } from '../lib/register.js';
import { AuditLog } from '../lib/audit.js';
import { apply as applyTenancy } from '../lib/index.js';

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

/** 临时目录:系统 tmp 不可写(只读沙箱等)时退回仓库内 .selftest-tmp。 */
function tempDir(prefix) {
  const candidates = [tmpdir(), join(dirname(dirname(new URL(import.meta.url).pathname)), '.selftest-tmp')];
  for (const base of candidates) {
    try {
      mkdirSync(base, { recursive: true });
      return mkdtempSync(join(base, prefix));
    } catch { /* 换下一个候选 */ }
  }
  throw new Error('无可写临时目录(尝试过 ' + candidates.join(', ') + ')');
}

//#region ① 路径围栏

console.log('① 路径围栏');
{
  const dir = tempDir('tenancy-selftest-');
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
  const dir = tempDir('tenancy-selftest-reg-');
  const store = new InviteStore(join(dir, 'invites.json'));
  const audit = new AuditLog(join(dir, 'audit.log'));
  const usersPath = join(dir, 'users.yml');
  writeFileSync(usersPath, '# test\nusers:\n  admin:\n    disabled: false\n    displayname: "admin"\n    password: "$argon2id$x"\n    groups:\n      - dsh-admins\n');

  const codes = await store.create(2, 'tester', 'selftest');
  assert(codes.length === 2 && codes.every((c) => /^[-A-Z2-7]{19}$/.test(c.code)), `批量生成明码(${codes[0].code})`);
  assert((await store.list()).length === 2, '列表可见两条');

  if (!skipSlow) {
    let wsAutoUser = null;
    const deps = {
      store, audit,
      autheliaUsersPath: usersPath,
      autheliaBin: process.env.AUTHELIA_BIN || '/opt/authelia/authelia',
      group: 'dsh-team',
      actorHint: 'selftest',
      // P9:注册成功后自动建个人工作区;此处记录触发,验证钩子接线
      createPersonalWorkspace: async (u) => { wsAutoUser = u; return { workspaceId: 'ws-' + u, path: '/pool/' + u }; }
    };

    const r1 = await registerUser(deps, { username: 'alice', displayName: 'Alice "A"', email: 'a@b.cn', password: 'correct horse', invite: codes[0].code });
    assert(r1.ok === true, '正常注册成功');
    assert(wsAutoUser === 'alice', '注册成功后触发个人工作区创建(用户名为名)');
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
  const dir = tempDir('tenancy-selftest-root-');
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

  // 围栏根是指向根外目录的符号链接时的回归（见下方结论修正说明）。
  const d2 = tempDir('tenancy-selftest-f3-');
  mkdirSync(join(d2, 'outside'), { recursive: true });
  mkdirSync(join(d2, 'pool'), { recursive: true });
  symlinkSync(join(d2, 'outside'), join(d2, 'pool', 'fence'));
  const lexicalRoot = join(d2, 'pool', 'fence');
  const realRoot = expandHomeDir(lexicalRoot); // 插件现在使用的归一根
  const outside = realpathSync(join(d2, 'outside'));
  assert(realRoot === outside && realRoot !== lexicalRoot, '围栏根解析到符号链接目标(与词法根不同)');
  // 围栏根归一的真实效果（结论修正）：confineToRoot 的 within(real) 本来就会拒掉
  // “符号链接根 + 真实前缀”的组合，所以根是指向盘符的链接时不会逃逸文件系统；
  // 但成员按真实路径发请求会被全部误拒（可用性缺陷），且错误消息会泄露解析前的词法根。
  // 归一后两者都对：真实前缀放行，根外路径仍拒。
  assert(confineToRoot(lexicalRoot, join(lexicalRoot, 'etc')) === null, '词法根下根外真实路径被误拒(旧行为:符号链接根破坏可用性)');
  assert(confineToRoot(realRoot, join(realRoot, 'etc')) === join(realRoot, 'etc'), '归一根下同一语义路径正常放行');
  assert(confineToRoot(realRoot, join(realRoot, '..')) === null, '归一根后根外路径仍然被拒');
  assert(confineToRoot(realRoot, join(realRoot, 'sub')) === join(realRoot, 'sub'), '真实根前缀的根内路径仍正常放行');
  // 细节:归一后必须用**真实根前缀**发路径 —— 拿符号链接前缀(~/dsh/... 而 ~/dsh 是链)
  // 会被 confineToRoot 的词法判定拒掉，插件已在启动日志里把归一后的根告知运维。
  assert(confineToRoot(realRoot, join(lexicalRoot, 'sub')) === null, '符号链接前缀被词法判定拒绝(安全方向)' );
  rmSync(d2, { recursive: true, force: true });

  rmSync(dir, { recursive: true, force: true });
}

//#region ⑤ 修改密码(用户中心)

console.log('⑤ 修改密码');
{
  const dir = tempDir('tenancy-selftest-pw-');
  const usersPath = join(dir, 'users.yml');
  const sample = [
    'users:',
    '  alice:',
    '    disabled: false',
    '    displayname: "Alice"',
    '    password: "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$ZGlnZXN0"',
    '    groups:',
    '      - dsh-team',
    '  bob:',
    '    disabled: false',
    '    displayname: "Bob"',
    '    password: "$argon2id$v=19$m=65536,t=3,p=4$Ym9ic2FsdA$Ym9iZGlnZXN0"',
    '    groups:',
    '      - dsh-team',
    ''
  ].join('\n');
  writeFileSync(usersPath, sample);

  assert(extractUserPasswordHash(sample, 'alice') === '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$ZGlnZXN0', '提取用户当前哈希');
  assert(extractUserPasswordHash(sample, 'ghost') === null, '不存在用户返回 null');

  const rep = replaceUserPasswordInYml(sample, 'alice', '$argon2id$NEW');
  assert(rep.replaced === true && extractUserPasswordHash(rep.text, 'alice') === '$argon2id$NEW', '替换本用户 password 行');
  assert(extractUserPasswordHash(rep.text, 'bob') === '$argon2id$v=19$m=65536,t=3,p=4$Ym9ic2FsdA$Ym9iZGlnZXN0', '其他用户哈希不受影响');
  const rep2 = replaceUserPasswordInYml(sample, 'ghost', '$argon2id$NEW');
  assert(rep2.replaced === false, '不存在用户不替换');

  if (!skipSlow) {
    const store = new InviteStore(join(dir, 'invites.json'));
    const audit = new AuditLog(join(dir, 'audit.log'));
    const autheliaBin = process.env.AUTHELIA_BIN || '/opt/authelia/authelia';
    const deps = { store, audit, autheliaUsersPath: usersPath, autheliaBin, actorHint: 'selftest' };

    const initHash = await hashArgon2(autheliaBin, 'oldpass123');
    writeFileSync(usersPath, [
      'users:',
      '  alice:',
      '    disabled: false',
      '    displayname: "Alice"',
      '    password: "' + initHash + '"',
      '    groups:',
      '      - dsh-team',
      ''
    ].join('\n'));
    const inoBefore = statSync(usersPath).ino;

    const w1 = await changeUserPassword(deps, { username: 'alice', currentPassword: 'wrongpass', newPassword: 'newpass123' });
    assert(w1.ok === false && w1.error === 'current-password-wrong', '旧密码错误被拒');

    const w2 = await changeUserPassword(deps, { username: 'alice', currentPassword: 'oldpass123', newPassword: 'short' });
    assert(w2.ok === false && w2.error === 'password-weak', '弱新密码被拒');

    const w3 = await changeUserPassword(deps, { username: 'alice', currentPassword: 'oldpass123', newPassword: 'newpass123' });
    assert(w3.ok === true, '正确修改成功');

    const after = readFileSync(usersPath, 'utf8');
    assert(statSync(usersPath).ino === inoBefore, 'users.yml inode 不变(Authelia 文件监听不断)');
    const newHash = extractUserPasswordHash(after, 'alice');
    assert(newHash !== null && newHash !== initHash, '哈希已更新');
    const okV = await verifyAutheliaPassword(autheliaBin, 'newpass123', newHash);
    const badV = await verifyAutheliaPassword(autheliaBin, 'oldpass123', newHash);
    assert(okV === true && badV === false, '新密码可登录 / 旧密码被拒');
  }

  rmSync(dir, { recursive: true, force: true });
}

//#endregion

//#region ⑥ P7 pending 读穿回归(影子路由级)

console.log('⑥ P7 pending 读穿回归(影子路由级)');
{
  const dir = tempDir('tenancy-selftest-gate-');
  mkdirSync(join(dir, 'pool'), { recursive: true });

  const cfg = {
    identityHeader: 'remote-user',
    groupsHeader: 'remote-groups',
    sharedSecret: '',
    adminGroups: ['dsh-admins'],
    trustedHosts: [],
    localPrincipal: 'local',
    localIsAdmin: true,
    defaultAccess: 'private',
    hideEmptyWorkspaces: true,
    hardenRespond: false,
    auditPath: join(dir, 'tenancy', 'audit.log'),
    dbPath: join(dir, 'tenancy', 'acl.json'),
    memberWorkspaceRoot: join(dir, 'pool'),
    registerEnabled: false,
    registerGroup: 'dsh-team',
    autheliaUsersPath: join(dir, 'users.yml'),
    autheliaBin: '/nonexistent',
    invitesPath: join(dir, 'tenancy', 'invites.json')
  };

  // 上游 apiProxy 替身:fetch handler 只要求 invoke 返回 {rpcId, result} 窄形。
  const apiStub = {
    sessions: {
      create: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { sessionId: 'sess-1' } } }),
      history: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { events: [], hasMore: false } } }),
      models: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { current: { provider: 'dp', model: 'm1' }, routable: true, groups: [], failures: [] } } }),
      selectModel: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { selected: { provider: 'dp', model: 'm1' } } } }),
      prompt: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { accepted: true } } }),
      list: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { items: [] } } })
    }
  };

  const routes = new Map();
  let gateDispose = null;
  let rpcSeq = 0;
  const ctxStub = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return name === 'apiProxy' ? apiStub : undefined; },
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes('settings')) cb({ settings: { register() {} } });
      else if (cb) cb({});
    },
    effect(fn) { gateDispose = fn(); },
    webServer: {
      register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); }
    }
  };
  applyTenancy(ctxStub, cfg);

  function tenancyReq({ url, method = 'POST', body = null, user = 'alice', groups = 'dsh-team' }) {
    const headers = {
      host: 'localhost:3088',
      origin: 'http://localhost:3088',
      'content-type': 'application/json',
      'remote-user': user,
      'remote-groups': groups
    };
    const buf = body === null ? null : Buffer.from(JSON.stringify(body));
    return {
      method, url, headers,
      [Symbol.asyncIterator]() {
        let done = body === null;
        return { next: async () => (done ? { done: true, value: undefined } : (done = true, { done: false, value: buf })) };
      }
    };
  }
  function tenancyRes() {
    return {
      __status: 0, __headers: {}, body: '',
      setHeader(k, v) { this.__headers[String(k).toLowerCase()] = v; },
      writeHead(status, headers) { this.__status = status; if (headers) Object.assign(this.__headers, headers); return this; },
      end(chunk) { this.body = chunk ?? ''; }
    };
  }
  async function gateCall(path, method, payload, user = 'alice') {
    const req = tenancyReq({ url: path, body: { type: 'client-request', rpcId: `rpc-${++rpcSeq}`, method, payload }, user });
    const res = tenancyRes();
    await routes.get(path)(req, res);
    let parsed = null;
    try { parsed = JSON.parse(String(res.body)); } catch { /* text deny */ }
    return { status: res.__status, body: parsed ?? String(res.body) };
  }

  // 1) 成员创建新会话 → ACL 只进内存 pending,不落盘
  const c = await gateCall('/api/session.create', 'session.create', {});
  assert(c.status === 200 && c.body?.result?.value?.sessionId === 'sess-1', 'session.create 放行(pending 登记)');
  let aclOnDiskNow = null;
  try { aclOnDiskNow = JSON.parse(readFileSync(cfg.dbPath, 'utf8')); } catch {}
  assert(aclOnDiskNow === null || aclOnDiskNow.sessions['sess-1'] === undefined, 'P7 语义保持:create 后不立即落盘');

  // 2) 核心回归:首 prompt 前,创建者自己的读/写门必须放行
  const m = await gateCall('/api/session.models', 'session.models', { sessionId: 'sess-1' });
  assert(m.status === 200, 'pending 期 session.models 不再 403(模型选择器不卡「正在刷新模型列表…」)');
  const h = await gateCall('/api/session.history', 'session.history', { sessionId: 'sess-1' });
  assert(h.status === 200, 'pending 期 session.history 不再 403(新会话历史直接可读)');
  const sm = await gateCall('/api/session.selectModel', 'session.selectModel', { sessionId: 'sess-1', provider: 'dp', model: 'm1' });
  assert(sm.status === 200, 'pending 期 session.selectModel 可写(新会话即可选模型)');

  // 3) WS 帧过滤同窗读穿:创建者放行、他人丢弃
  const tenancy = globalThis.__dshTenancy;
  const pa = tenancy.principal({ headers: { 'remote-user': 'alice', 'remote-groups': 'dsh-team' } });
  const pb = tenancy.principal({ headers: { 'remote-user': 'bob', 'remote-groups': 'dsh-team' } });
  const frame = { payload: { type: 'session/event', sessionId: 'sess-1' } };
  assert(tenancy.filterFrame(pa, frame) !== null, 'pending 会话帧对创建者放行');
  assert(tenancy.filterFrame(pb, frame) === null, 'pending 会话帧对他人丢弃(不越权)');

  // 4) 无水平越权:他人读 pending 会话仍 403
  const hb = await gateCall('/api/session.history', 'session.history', { sessionId: 'sess-1' }, 'bob');
  assert(hb.status === 403, '他人读 pending 会话仍 403(fail-closed 方向不变)');

  // 5) /tenancy/sessions 列表可见性与 readable 同一(「能打开却不在列表」回归)
  const listReq = tenancyReq({ url: '/tenancy/sessions', method: 'GET' });
  const listRes = tenancyRes();
  await routes.get('/tenancy')(listReq, listRes);
  const listBody = JSON.parse(String(listRes.body));
  assert(listRes.__status === 200 && listBody.sessions.some((s) => s.sessionId === 'sess-1'), 'pending 期 /tenancy/sessions 含本人新会话');

  // 6) 首 prompt 落盘,落盘后一切照常;owner=创建者
  const p = await gateCall('/api/session.prompt', 'session.prompt', { sessionId: 'sess-1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] });
  assert(p.status === 200, '首条 session.prompt 放行');
  const aclAfter = JSON.parse(readFileSync(cfg.dbPath, 'utf8'));
  assert(aclAfter.sessions['sess-1']?.owner === 'alice', '首 prompt 后 ACL 落盘 owner=创建者');
  const h2 = await gateCall('/api/session.history', 'session.history', { sessionId: 'sess-1' });
  const hb2 = await gateCall('/api/session.history', 'session.history', { sessionId: 'sess-1' }, 'bob');
  assert(h2.status === 200 && hb2.status === 403, '落盘后本人可读、他人仍 403');

  // 7) 纯谓词回归(readable/writable 共用的判定核)
  assert(recordReadable({ owner: 'alice', mode: 'private' }, 'alice') === true, 'recordReadable owner 放行');
  assert(recordReadable({ owner: 'alice', mode: 'private' }, 'bob') === false, 'recordReadable private 拒他人');
  assert(recordReadable({ owner: 'alice', mode: 'team-read' }, 'bob') === true, 'recordReadable team-read 共享');
  assert(recordReadable({ owner: 'alice', mode: 'private', readers: ['bob'] }, 'bob') === true, 'recordReadable 显式 reader 放行');
  assert(recordWritable({ owner: 'alice', mode: 'team-read' }, 'bob') === false, 'recordWritable team-read 不可写');
  assert(recordWritable({ owner: 'alice', mode: 'private', writers: ['bob'] }, 'bob') === true, 'recordWritable 显式 writer 可写');
  assert(recordReadable(null, 'alice') === false && recordWritable(undefined, 'alice') === false, '无记录 fail-closed');

  if (gateDispose) gateDispose(); // 清定时器 + 路由 + globalThis 钩子
  rmSync(dir, { recursive: true, force: true });
}

//#endregion

//#region ⑦ 工作区共享(P9):owner/共享用户/仅共享会话 三类可见性与会话创建门

console.log('⑦ 工作区共享(P9)');
{
  const dir = tempDir('tenancy-selftest-ws-');
  mkdirSync(join(dir, 'pool'), { recursive: true });
  mkdirSync(join(dir, 'pool', 'alice'), { recursive: true });
  mkdirSync(join(dir, 'pool', 'bob'), { recursive: true });

  const cfg = {
    identityHeader: 'remote-user', groupsHeader: 'remote-groups',
    sharedSecret: '', adminGroups: ['dsh-admins'], trustedHosts: [],
    localPrincipal: 'local', localIsAdmin: true, defaultAccess: 'private',
    hideEmptyWorkspaces: false, hardenRespond: false,
    auditPath: join(dir, 'tenancy', 'audit.log'), dbPath: join(dir, 'tenancy', 'acl.json'),
    memberWorkspaceRoot: join(dir, 'pool'), registerEnabled: false,
    registerGroup: 'dsh-team', autheliaUsersPath: join(dir, 'users.yml'),
    autheliaBin: '/nonexistent', invitesPath: join(dir, 'tenancy', 'invites.json')
  };

  // 上游替身:session.create 带 workspaceId/cwd 时回显;workspace.create 附带真实 path。
  const apiStub = {
    sessions: {
      create: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { sessionId: 'sess-new' } } }),
      prompt: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { accepted: true } } }),
      list: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { items: [] } } })
    },
    workspace: {
      create: async (r) => {
        const path = r.payload && r.payload.path;
        const title = basename(path || '');
        return { rpcId: r.rpcId, result: { ok: true, value: { workspace: { workspaceId: 'ws-alice', path, title, sessionIds: [], archivedSessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, created: true } } };
      },
      list: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { items: [] } } })
    }
  };

  const routes = new Map();
  let gateDispose = null;
  let rpcSeq = 0;
  const ctxStub = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return name === 'apiProxy' ? apiStub : undefined; },
    inject(deps, cb) { if (Array.isArray(deps) && deps.includes('settings')) cb({ settings: { register() {} } }); else if (cb) cb({}); },
    effect(fn) { gateDispose = fn(); },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } }
  };
  applyTenancy(ctxStub, cfg);

  function tenancyReq({ url, method = 'POST', body = null, user = 'alice', groups = 'dsh-team' }) {
    const headers = { host: 'localhost:3088', origin: 'http://localhost:3088', 'content-type': 'application/json', 'remote-user': user, 'remote-groups': groups };
    const buf = body === null ? null : Buffer.from(JSON.stringify(body));
    return { method, url, headers, [Symbol.asyncIterator]() { let done = body === null; return { next: async () => (done ? { done: true, value: undefined } : (done = true, { done: false, value: buf })) }; } };
  }
  function tenancyRes() { return { __status: 0, __headers: {}, body: '', setHeader(k, v) { this.__headers[String(k).toLowerCase()] = v; }, writeHead(status, headers) { this.__status = status; if (headers) Object.assign(this.__headers, headers); return this; }, end(chunk) { this.body = chunk ?? ''; } }; }
  async function gateCall(path, method, payload, user = 'alice', groups = 'dsh-team') {
    const req = tenancyReq({ url: path, body: { type: 'client-request', rpcId: `rpc-${++rpcSeq}`, method, payload }, user, groups });
    const res = tenancyRes();
    await routes.get(path)(req, res);
    let parsed = null; try { parsed = JSON.parse(String(res.body)); } catch {}
    return { status: res.__status, body: parsed ?? String(res.body) };
  }

  // 1) 所有者创建个人工作区(经影子路由,旁车登记 owner+path+sharedUsers=[])。--skip-slow 用不上 workspaceRegistry,直接造 acl 记录更快
  //    这里直接经 workspace.create 影子路由,验证 owner+空 sharedUsers 登记。
  const wc = await gateCall('/api/workspace.create', 'workspace.create', { path: join(dir, 'pool', 'alice') }, 'alice');
  assert(wc.status === 200, 'owner 创建个人工作区放行');
  let acl = JSON.parse(readFileSync(cfg.dbPath, 'utf8'));
  assert(acl.workspaces['ws-alice']?.owner === 'alice' && Array.isArray(acl.workspaces['ws-alice']?.sharedUsers) && acl.workspaces['ws-alice']?.sharedUsers.length === 0, '旁车登记 owner + 空 sharedUsers');

  // 2) owner/admin 经 /tenancy/workspaces/<id>/share 设共享用户;他人 403
  const shareReq = tenancyReq({ url: '/tenancy/workspaces/ws-alice/share', method: 'POST', body: { sharedUsers: ['bob', ' carol ', 'bob'] } });
  const shareRes = tenancyRes();
  await routes.get('/tenancy')(shareReq, shareRes);
  const shareBody = JSON.parse(String(shareRes.body));
  assert(shareRes.__status === 200 && shareBody.sharedUsers.length === 2 && shareBody.sharedUsers.includes('bob') && shareBody.sharedUsers.includes('carol'), 'owner 设置共享用户(去重/去空白)');
  acl = JSON.parse(readFileSync(cfg.dbPath, 'utf8'));
  assert(acl.workspaces['ws-alice'].sharedUsers.includes('bob') && acl.workspaces['ws-alice'].sharedUsers.includes('carol'), '共享用户落盘');

  const shareDeny = tenancyReq({ url: '/tenancy/workspaces/ws-alice/share', method: 'POST', body: { sharedUsers: ['carol'] }, user: 'dave' });
  const shareDenyRes = tenancyRes();
  await routes.get('/tenancy')(shareDeny, shareDenyRes);
  assert(shareDenyRes.__status === 403, '非 owner/admin 改共享用户被拒');

  // 3) 共享用户可在共享工作区新增会话(workspaceId 形式)
  const cd = await gateCall('/api/session.create', 'session.create', { workspaceId: 'ws-alice' }, 'bob');
  assert(cd.status === 200, '共享用户在共享工作区新增会话放行');

  // 4) 仅被共享会话但工作区未共享 → 无法新增会话:先建一个未共享工作区 + 给 bob 共享会话
  const cd2 = await gateCall('/api/session.create', 'session.create', {}, 'carol');
  assert(cd2.status === 200, 'carol 建立自己会话(pending)');
  // carol 把自己的新会话共享给 bob(经 /tenancy/sessions/<id>/acl),且该会话不落任何已共享工作区
  const sessReq = tenancyReq({ url: '/tenancy/sessions/sess-new/acl', method: 'POST', body: { mode: 'private', readers: ['bob'], writers: [] }, user: 'carol' });
  const sessRes = tenancyRes();
  await routes.get('/tenancy')(sessReq, sessRes);
  assert(sessRes.__status === 200, 'carol 把会话共享给 bob');

  // 4) 无关用户(dave,非 owner/共享用户/无任何共享)经 workspaceId 在未共享工作区新增会话 → 403
  const cd3 = await gateCall('/api/session.create', 'session.create', { workspaceId: 'ws-alice' }, 'dave');
  assert(cd3.status === 403, '非 owner/共享用户经 workspaceId 在未共享工作区新增会话被拒');

  // 5) 共享用户(carol)同样放行,双向确认共享用户权限
  const cd4 = await gateCall('/api/session.create', 'session.create', { workspaceId: 'ws-alice' }, 'carol');
  assert(cd4.status === 200, '另一共享用户新增会话放行');

  // 5) 工作区列表过滤:workspace.list 对 bob(共享用户)应包含 ws-alice;
  //    对完全无关的 dave 应不含。
  const wlBob = await gateCall('/api/workspace.list', 'workspace.list', {}, 'bob');
  assert(wlBob.status === 200, 'workspace.list 对共享用户放行');

  // 6) 纯谓词回归
  assert(workspaceSharedUsers({ sharedUsers: ['x'] }).includes('x') && workspaceSharedUsers({}).length === 0, 'workspaceSharedUsers 缺省空表');
  assert(workspaceCreatable({ owner: 'alice', sharedUsers: ['bob'] }, 'bob') === true, '共享用户可创建工作区会话');
  assert(workspaceCreatable({ owner: 'alice', sharedUsers: [] }, 'bob') === false, '未共享用户不可创建工作区会话');
  assert(workspaceVisible({ owner: 'alice', sharedUsers: ['bob'] }, false, 'bob') === true, '共享用户工作区可见');
  assert(workspaceVisible({ owner: 'alice', sharedUsers: [] }, true, 'bob') === true, '工作区内可读会话时可见(仅共享会话)');
  assert(workspaceVisible({ owner: 'alice', sharedUsers: [] }, false, 'bob') === false, '无共享不可见');

  if (gateDispose) gateDispose();
  rmSync(dir, { recursive: true, force: true });
}

//#endregion

//#region ⑧ 成员文件访问收窄到个人根(P10):~/dsh/<user> 内可建,他人目录拒绝

console.log('⑧ 成员文件访问收窄到个人根(P10)');
{
  const dir = tempDir('tenancy-selftest-p10-');
  const pool = join(dir, 'pool');
  mkdirSync(join(pool, 'alice'), { recursive: true });
  mkdirSync(join(pool, 'bob'), { recursive: true });
  mkdirSync(join(pool, 'shared-ws'), { recursive: true });

  const cfg = {
    identityHeader: 'remote-user', groupsHeader: 'remote-groups',
    sharedSecret: '', adminGroups: ['dsh-admins'], trustedHosts: [],
    localPrincipal: 'local', localIsAdmin: true, defaultAccess: 'private',
    hideEmptyWorkspaces: false, hardenRespond: false,
    auditPath: join(dir, 'tenancy', 'audit.log'), dbPath: join(dir, 'tenancy', 'acl.json'),
    memberWorkspaceRoot: pool, registerEnabled: false,
    registerGroup: 'dsh-team', autheliaUsersPath: join(dir, 'users.yml'),
    autheliaBin: '/nonexistent', invitesPath: join(dir, 'tenancy', 'invites.json')
  };

  const apiStub = {
    sessions: {
      create: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { sessionId: 'sess-new' } } }),
      prompt: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { accepted: true } } }),
      list: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { items: [] } } })
    },
    workspace: {
      create: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { workspace: { workspaceId: 'ws-' + basename(r.payload.path), path: r.payload.path, title: basename(r.payload.path), sessionIds: [], archivedSessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, created: true } } }),
      list: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { items: [] } } })
    },
    host: {
      listDirectory: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { path: r.payload.path, home: '/real-home', crumbs: [], entries: [], truncated: false } } }),
      createDirectory: async (r) => ({ rpcId: r.rpcId, result: { ok: true, value: { path: join(r.payload.path, r.payload.name) } } })
    }
  };

  const routes = new Map();
  let gateDispose = null;
  let rpcSeq = 0;
  const ctxStub = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) { return name === 'apiProxy' ? apiStub : undefined; },
    inject(deps, cb) { if (Array.isArray(deps) && deps.includes('settings')) cb({ settings: { register() {} } }); else if (cb) cb({}); },
    effect(fn) { gateDispose = fn(); },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } }
  };
  applyTenancy(ctxStub, cfg);

  function tenancyReq({ url, method = 'POST', body = null, user = 'alice', groups = 'dsh-team' }) {
    const headers = { host: 'localhost:3088', origin: 'http://localhost:3088', 'content-type': 'application/json', 'remote-user': user, 'remote-groups': groups };
    const buf = body === null ? null : Buffer.from(JSON.stringify(body));
    return { method, url, headers, [Symbol.asyncIterator]() { let done = body === null; return { next: async () => (done ? { done: true, value: undefined } : (done = true, { done: false, value: buf })) }; } };
  }
  function tenancyRes() { return { __status: 0, __headers: {}, body: '', setHeader(k, v) { this.__headers[String(k).toLowerCase()] = v; }, writeHead(status, headers) { this.__status = status; if (headers) Object.assign(this.__headers, headers); return this; }, end(chunk) { this.body = chunk ?? ''; } }; }
  async function gateCall(path, method, payload, user = 'alice', groups = 'dsh-team') {
    const req = tenancyReq({ url: path, body: { type: 'client-request', rpcId: `rpc-${++rpcSeq}`, method, payload }, user, groups });
    const res = tenancyRes();
    await routes.get(path)(req, res);
    let parsed = null; try { parsed = JSON.parse(String(res.body)); } catch {}
    return { status: res.__status, body: parsed ?? String(res.body) };
  }

  // 1) alice 在本人根(~/<pool>/alice)下新建工作区 → 放行,path 收窄在个人根内
  const wcOwn = await gateCall('/api/workspace.create', 'workspace.create', { path: join(pool, 'alice', 'proj-x') }, 'alice');
  assert(wcOwn.status === 200 && wcOwn.body?.result?.value?.workspace?.path === join(pool, 'alice', 'proj-x'), '成员在本人根下新建工作区放行');

  // 2) alice 尝试在他人(bob)根下新建工作区 → 403
  const wcOther = await gateCall('/api/workspace.create', 'workspace.create', { path: join(pool, 'bob', 'evil') }, 'alice');
  assert(wcOther.status === 403, '成员在他人根下新建工作区被拒');

  // 3) alice 浏览他人根 → 静默钳制回本人根;缺省也回本人根
  const lsOther = await gateCall('/api/host.listDirectory', 'host.listDirectory', { path: join(pool, 'bob') }, 'alice');
  assert(lsOther.status === 200 && lsOther.body?.result?.value?.path === join(pool, 'alice'), '浏览他人根被钳制回本人根');
  const lsDefault = await gateCall('/api/host.listDirectory', 'host.listDirectory', {}, 'alice');
  assert(lsDefault.status === 200 && lsDefault.body?.result?.value?.path === join(pool, 'alice'), '缺省浏览回本人根');
  assert(lsDefault.body?.result?.value?.home === join(pool, 'alice'), 'home 改写为本人根(非 memberRoot)');

  // 4) alice 在他人根下建目录 → 403;在本人根下建目录 → 放行
  const mkOther = await gateCall('/api/host.createDirectory', 'host.createDirectory', { path: join(pool, 'bob'), name: 'drop' }, 'alice');
  assert(mkOther.status === 403, '在他人根下建目录被拒');
  const mkOwn = await gateCall('/api/host.createDirectory', 'host.createDirectory', { path: join(pool, 'alice'), name: 'sub' }, 'alice');
  assert(mkOwn.status === 200, '在本人根下建目录放行');

  // 5) bob 经 cwd 指向共享工作区(在本人根外)→ 按 workspaceCreatable 放行
  //    共享工作区须在 alice 本人根内(alice 才能创建);经 cwd 跨到该路径对 bob 放行
  await gateCall('/api/workspace.create', 'workspace.create', { path: join(pool, 'alice', 'shared-ws') }, 'alice');
  const shr = tenancyReq({ url: '/tenancy/workspaces/ws-shared-ws/share', method: 'POST', body: { sharedUsers: ['bob'] }, user: 'alice' });
  const shrRes = tenancyRes();
  await routes.get('/tenancy')(shr, shrRes);
  assert(shrRes.__status === 200, 'alice 把共享工作区共享给 bob');
  const sessShared = await gateCall('/api/session.create', 'session.create', { cwd: join(pool, 'alice', 'shared-ws') }, 'bob');
  assert(sessShared.status === 200, '共享用户经 cwd 在共享工作区(本人根外)新建会话放行');
  const sessD = await gateCall('/api/session.create', 'session.create', { cwd: join(pool, 'alice', 'shared-ws') }, 'dave');
  assert(sessD.status === 403, '无关用户经 cwd 到共享工作区被拒');

  if (gateDispose) gateDispose();
  rmSync(dir, { recursive: true, force: true });
}

//#endregion

console.log(`\n结果:${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
