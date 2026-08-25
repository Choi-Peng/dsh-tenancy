// AI 生成声明:本脚本由 AI 生成,仅用于验收测试。
// 用法:node ws-probe.mjs <user|local|null> [durationMs]
// 连接 dsh 的 events.mux 下行,统计收到的帧类型与 sessionId 集合。
import { createRequire } from 'node:module';
const require = createRequire('/root/.nvm/versions/node/v22.22.0/lib/node_modules/@deepseek-ai/dsh/node_modules/ws/package.json');
const WebSocket = require('ws');

const SECRET = 'ef19cac7479ec2d9b2c4493711363c33e2033bdec696a2de47818c1e82aa730e';
const who = process.argv[2] ?? 'local';
const ms = Number(process.argv[3] ?? 4000);

const headers = {};
if (who === 'null') {
  headers['x-dsh-tenancy-key'] = 'WRONG-SECRET';
  headers['remote-user'] = 'testmember';
} else if (who !== 'local') {
  headers['x-dsh-tenancy-key'] = SECRET;
  headers['remote-user'] = who;
  headers['remote-groups'] = who === 'choi' ? 'dsh-team,dsh-admins' : 'dsh-team';
}

const ws = new WebSocket('ws://127.0.0.1:3088/api/events.mux', { headers });
const types = new Map();
const sids = new Set();
ws.on('open', () => console.error(`[probe] connected as ${who}`));
ws.on('message', (data) => {
  try {
    const f = JSON.parse(data.toString());
    const t = f?.payload?.type ?? '?';
    types.set(t, (types.get(t) ?? 0) + 1);
    if (f?.payload?.sessionId) sids.add(f.payload.sessionId);
    // 深扫一帧里出现的所有形如 session-… 的 ID(泄漏检测)
    const blob = JSON.stringify(f.payload ?? {});
    for (const m of blob.matchAll(/session-[0-9a-f-]{36}/g)) if (!sids.has(m[0])) sids.add(`(embedded)${m[0]}`);
  } catch {}
});
ws.on('error', (e) => { console.error('[probe] error', e.message); process.exit(1); });
setTimeout(() => {
  console.log(JSON.stringify({ who, frameTypes: Object.fromEntries(types), sessionIds: [...sids].sort() }, null, 2));
  process.exit(0);
}, ms);
