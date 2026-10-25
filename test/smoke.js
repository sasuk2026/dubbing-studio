'use strict';

/**
 * 冒烟测试：启动真实服务器，用两个 Socket.io 客户端验证核心流程
 * 运行：npm test
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      `${BASE}${urlPath}`,
      {
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(raw.toString('utf8') || '{}'); } catch (e) { /* 非 JSON */ }
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
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

function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}`);
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

    console.log('\n[1] REST API');
    const health = await req('GET', '/healthz');
    check('健康检查', health.status === 200 && health.json && health.json.ok);

    const created = await req('POST', '/api/rooms', {
      name: '测试配音室',
      script: '旁白：你好世界\n小明：第二条台词',
    });
    check('创建房间', created.status === 200 && created.json && created.json.room);
    const room = created.json.room;
    check('台词本解析（角色：台词）', room.lines.length === 2
      && room.lines[0].speaker === '旁白'
      && room.lines[1].text === '第二条台词');

    const added = await req('POST', `/api/rooms/${room.id}/lines`, { speaker: '小红', text: '新台词' });
    check('添加台词', added.status === 200 && added.json && added.json.line.text === '新台词');
    const lineId = added.json.line.id;

    console.log('\n[2] 双客户端实时协作');
    const a = io(BASE, { transports: ['websocket'], forceNew: true });
    const b = io(BASE, { transports: ['websocket'], forceNew: true });
    await Promise.all([
      new Promise((r) => a.on('connect', r)),
      new Promise((r) => b.on('connect', r)),
    ]);
    const userA = { id: 'ua', name: '小明', color: '#ff0000' };
    const userB = { id: 'ub', name: '小红', color: '#00ff00' };

    let bState = null;
    b.on('room:state', (s) => { bState = s; });
    let chatOnB = null;
    b.on('chat:message', (m) => { if (!m.system) chatOnB = m; });
    let presenceOnB = null;
    b.on('presence:update', (u) => { presenceOnB = u; });

    a.emit('room:join', { roomId: room.id, user: userA });
    await sleep(300);
    b.emit('room:join', { roomId: room.id, user: userB });
    await sleep(500);
    check('B 收到完整房间状态（3 条台词）', bState && bState.room.lines.length === 3);
    check('B 看到 2 位在线用户', presenceOnB && presenceOnB.length === 2);

    const lockRes = await new Promise((r) => a.emit('line:lock', { lineId }, (res) => r(res)));
    check('A 锁定台词成功', lockRes && lockRes.ok === true);

    const lockRes2 = await new Promise((r) => b.emit('line:lock', { lineId }, (res) => r(res)));
    check('B 锁定同一台词被拒绝', lockRes2 && lockRes2.ok === false && /锁定/.test(lockRes2.error || ''));

    a.emit('chat:message', { text: '大家好呀' });
    await sleep(300);
    check('B 收到文字聊天', chatOnB && chatOnB.text === '大家好呀' && chatOnB.byName === '小明');

    console.log('\n[3] 录音上传与下载');
    const wavB64 = Buffer.from(
      'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=', 'base64'
    ).toString('base64');
    const up = await req('POST', `/api/rooms/${room.id}/lines/${lineId}/take`, {
      userId: 'ua', userName: '小明', duration: 3, mime: 'audio/wav', data: wavB64,
    });
    check('上传录音', up.status === 200 && up.json && up.json.line.take && up.json.line.take.byName === '小明');
    check('保存后自动解除锁定', up.json && up.json.line.lockedBy === null);
    const dl = await req('GET', up.json.line.take.url);
    check('下载录音文件', dl.status === 200 && dl.raw.length >= 44 && dl.raw.toString('base64') === wavB64);

    console.log('\n[4] 语音信令转发');
    let sigOnB = null;
    b.on('voice:signal', (d) => { sigOnB = d; });
    a.emit('voice:join');
    await sleep(200);
    a.emit('voice:signal', { to: b.id, type: 'ice', data: { candidate: 'test-candidate' } });
    await sleep(300);
    check('offer/answer/ice 信令转发', sigOnB && sigOnB.from === a.id && sigOnB.type === 'ice');

    console.log('\n[5] 断线清理');
    let sysOnB = null;
    b.on('chat:message', (m) => { if (m.system) sysOnB = m; });
    let lineUpdOnB = null;
    b.on('line:updated', (l) => { if (l.id === room.lines[0].id) lineUpdOnB = l; });
    const lockAgain = await new Promise((r) => a.emit('line:lock', { lineId: room.lines[0].id }, (res) => r(res)));
    check('A 锁定另一条台词', lockAgain && lockAgain.ok === true);
    await sleep(200);
    a.close();
    await sleep(700);
    check('A 断线后锁定被自动释放', lineUpdOnB && lineUpdOnB.lockedBy === null);
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
