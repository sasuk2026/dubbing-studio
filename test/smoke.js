'use strict';

/**
 * 冒烟测试：启动真实服务器，验证账号体系 + 双客户端协作全流程
 * 运行：npm test
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request(`${BASE}${urlPath}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8') || '{}'); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dub-test-'));
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));

  const io = require('socket.io-client');

  try {
    await sleep(1200);

    console.log('\n[1] 账号体系');
    const health = await req('GET', '/healthz');
    check('健康检查', health.status === 200 && health.json && health.json.ok);

    const noAuth = await req('GET', '/api/auth/me');
    check('未登录访问 /me 返回 401', noAuth.status === 401);

    const reg = await req('POST', '/api/auth/register', { username: '小明', password: 'pass1234' });
    check('注册成功并返回令牌', reg.status === 200 && reg.json && reg.json.token && reg.json.user.username === '小明');
    const tokenA = reg.json.token;
    check('注册时种下 HttpOnly Cookie', /dub_token=/.test(reg.headers['set-cookie'] || ''));

    const dup = await req('POST', '/api/auth/register', { username: '小明', password: 'pass1234' });
    check('重复用户名注册返回 409', dup.status === 409);

    const weak = await req('POST', '/api/auth/register', { username: '小红', password: '123' });
    check('弱密码注册返回 400', weak.status === 400);

    const badLogin = await req('POST', '/api/auth/login', { username: '小明', password: 'wrongpass' });
    check('错误密码登录返回 401', badLogin.status === 401);

    const regB = await req('POST', '/api/auth/register', { username: '小红', password: 'pass1234' });
    check('第二个账号注册成功', regB.status === 200 && regB.json.token);
    const tokenB = regB.json.token;

    const me = await req('GET', '/api/auth/me', null, tokenA);
    check('带令牌访问 /me', me.status === 200 && me.json.user.username === '小明');

    const roomNoAuth = await req('POST', '/api/rooms', { name: 'x' });
    check('未登录创建房间返回 401', roomNoAuth.status === 401);

    console.log('\n[2] REST API');
    const created = await req('POST', '/api/rooms', {
      name: '测试配音室',
      script: '旁白：你好世界\n小明：第二条台词',
    }, tokenA);
    check('创建房间', created.status === 200 && created.json && created.json.room);
    const room = created.json.room;
    check('台词本解析（角色：台词）', room.lines.length === 2
      && room.lines[0].speaker === '旁白'
      && room.lines[1].text === '第二条台词');

    const added = await req('POST', `/api/rooms/${room.id}/lines`, { speaker: '小红', text: '新台词' }, tokenA);
    check('添加台词', added.status === 200 && added.json && added.json.line.text === '新台词');
    const lineId = added.json.line.id;

    console.log('\n[3] 双客户端实时协作');
    const a = io(BASE, { transports: ['websocket'], forceNew: true });
    const b = io(BASE, { transports: ['websocket'], forceNew: true });
    await Promise.all([
      new Promise((r) => a.on('connect', r)),
      new Promise((r) => b.on('connect', r)),
    ]);

    // 未带令牌加入 → auth:expired
    let expiredSeen = false;
    a.on('auth:expired', () => { expiredSeen = true; });
    a.emit('room:join', { roomId: room.id });
    await sleep(400);
    check('无令牌加入房间被拒绝', expiredSeen);

    let bState = null;
    b.on('room:state', (s) => { bState = s; });
    let chatOnB = null;
    b.on('chat:message', (m) => { if (!m.system) chatOnB = m; });
    let presenceOnB = null;
    b.on('presence:update', (u) => { presenceOnB = u; });

    a.emit('room:join', { roomId: room.id, token: tokenA });
    await sleep(300);
    b.emit('room:join', { roomId: room.id, token: tokenB });
    await sleep(500);
    check('B 收到完整房间状态（3 条台词）', bState && bState.room.lines.length === 3);
    check('B 看到 2 位在线用户', presenceOnB && presenceOnB.length === 2);
    check('用户身份来自账号（小明/小红）', presenceOnB
      && presenceOnB.some((u) => u.name === '小明')
      && presenceOnB.some((u) => u.name === '小红'));

    a.emit('chat:message', { text: '大家好呀' });
    await sleep(300);
    check('B 收到文字聊天', chatOnB && chatOnB.text === '大家好呀' && chatOnB.byName === '小明');

    console.log('\n[4] 录音上传与下载');
    const wavB64 = Buffer.from(
      'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=', 'base64'
    ).toString('base64');
    const up = await req('POST', `/api/rooms/${room.id}/lines/${lineId}/take`, {
      duration: 3, mime: 'audio/wav', data: wavB64,
    }, tokenA);
    check('上传录音（录制者取自账号）', up.status === 200 && up.json && up.json.line.take
      && up.json.line.take.byName === '小明' && up.json.line.take.by === reg.json.user.id);
    const dl = await req('GET', up.json.line.take.url, null, tokenA);
    check('下载录音文件', dl.status === 200 && dl.raw.length >= 44 && dl.raw.toString('base64') === wavB64);
    const dlCookie = await req('GET', up.json.line.take.url);
    check('无令牌下载录音返回 401', dlCookie.status === 401);

    console.log('\n[5] 语音信令转发');
    let sigOnB = null;
    b.on('voice:signal', (d) => { sigOnB = d; });
    a.emit('voice:join');
    await sleep(200);
    a.emit('voice:signal', { to: b.id, type: 'ice', data: { candidate: 'test-candidate' } });
    await sleep(300);
    check('offer/answer/ice 信令转发', sigOnB && sigOnB.from === a.id && sigOnB.type === 'ice');

    console.log('\n[6] 断线清理');
    let sysOnB = null;
    b.on('chat:message', (m) => { if (m.system) sysOnB = m; });
    let removedOnB = null;
    b.on('line:removed', (d) => { removedOnB = d; });
    const del = await req('DELETE', `/api/rooms/${room.id}/lines/${room.lines[0].id}`, null, tokenA);
    check('删除台词', del.status === 200);
    await sleep(300);
    check('B 收到删除广播', removedOnB && removedOnB.lineId === room.lines[0].id);
    await sleep(200);
    a.close();
    await sleep(700);
    check('A 断线后广播离开通知', !!sysOnB);
    b.close();

    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('测试异常:', e);
    process.exitCode = 1;
  } finally {
    server.kill();
    process.exit(process.exitCode || 0);
  }
}

main();
