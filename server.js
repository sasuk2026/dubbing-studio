'use strict';

/**
 * 配音工坊 · 服务端
 * Express + Socket.io
 * - 账号系统（注册 / 登录 / 令牌会话）
 * - 配音室（房间）创建 / 加入 / 持久化
 * - 台词本增删改、选中配音（无锁定，先选句再录音）
 * - 分段录音上传 / 下载
 * - 文字聊天、在线状态
 * - WebRTC 语音信令转发
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TAKES_DIR = path.join(DATA_DIR, 'takes');
const MAX_TAKE_MB = 20;

fs.mkdirSync(TAKES_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: `${MAX_TAKE_MB + 5}mb` }));
// 静态资源始终重新验证（no-cache）：避免浏览器缓存旧版 HTML/JS 组合，
// 导致"新版 JS 找不到旧版 HTML 里的元素"而使整个页面脚本失效（按钮全部失灵）
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));

/* ================= 账号系统 ================= */

const users = new Map();  // userId -> {id, username, salt, passHash, createdAt}
const tokens = new Map(); // token -> {userId, at}

const USERNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,20}$/;
const USER_COLORS = ['#6c8cff', '#9b6cff', '#3ecf8e', '#ffc861', '#ff8a65', '#4dd0e1', '#f06292', '#aed581'];

function colorFromId(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length];
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function publicUser(u) {
  return { id: u.id, username: u.username, color: colorFromId(u.id), createdAt: u.createdAt };
}

function resolveToken(token) {
  if (!token) return null;
  const entry = tokens.get(String(token));
  if (!entry) return null;
  return users.get(entry.userId) || null;
}

function issueToken(user) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { userId: user.id, at: Date.now() });
  persistUsersSoon();
  return token;
}

let persistUsersTimer = null;

function persistUsersSoon() {
  if (persistUsersTimer) return;
  persistUsersTimer = setTimeout(() => {
    persistUsersTimer = null;
    try {
      const dump = {
        accounts: [...users.values()].map((u) => ({
          id: u.id, username: u.username, salt: u.salt, passHash: u.passHash, createdAt: u.createdAt,
        })),
        tokens: Object.fromEntries(tokens),
      };
      fs.writeFileSync(path.join(DATA_DIR, 'users.json'), JSON.stringify(dump));
    } catch (e) {
      console.error('[persist-users] 失败:', e.message);
    }
  }, 400);
}

function loadUsers() {
  try {
    const dump = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8'));
    for (const a of dump.accounts || []) users.set(a.id, a);
    for (const [t, v] of Object.entries(dump.tokens || {})) tokens.set(t, v);
    if (users.size) console.log(`[init] 已恢复 ${users.size} 个账号`);
  } catch (e) {
    /* 首次启动无存档，忽略 */
  }
}

loadUsers();

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token && req.headers.cookie) {
    const m = req.headers.cookie.match(/(?:^|;\s*)dub_token=([^;]+)/);
    if (m) token = decodeURIComponent(m[1]);
  }
  const account = resolveToken(token);
  if (!account) return res.status(401).json({ error: '未登录或登录已过期' });
  req.account = account;
  next();
}

function setAuthCookie(res, token) {
  res.cookie('dub_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie('dub_token', { path: '/' });
}

const authRouter = express.Router();

authRouter.post('/register', (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: '用户名需为 2-20 位字母、数字、中文或下划线' });
  }
  if (password.length < 6 || password.length > 64) {
    return res.status(400).json({ error: '密码长度需为 6-64 位' });
  }
  if ([...users.values()].some((u) => u.username === username)) {
    return res.status(409).json({ error: '用户名已被注册，换一个试试' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: 'usr-' + crypto.randomBytes(8).toString('hex'),
    username,
    salt,
    passHash: hashPassword(password, salt),
    createdAt: Date.now(),
  };
  users.set(user.id, user);
  persistUsersSoon();
  const token = issueToken(user);
  setAuthCookie(res, token);
  res.json({ token, user: publicUser(user) });
});

authRouter.post('/login', (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  const user = [...users.values()].find((u) => u.username === username);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  const expected = Buffer.from(user.passHash, 'hex');
  const actual = crypto.scryptSync(password, user.salt, 64);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = issueToken(user);
  setAuthCookie(res, token);
  res.json({ token, user: publicUser(user) });
});

authRouter.post('/logout', authRequired, (req, res) => {
  const header = req.headers.authorization || '';
  tokens.delete(header.startsWith('Bearer ') ? header.slice(7) : '');
  persistUsersSoon();
  clearAuthCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', authRequired, (req, res) => {
  res.json({ user: publicUser(req.account) });
});

app.use('/api/auth', authRouter);

/* ================= 房间存储 ================= */

const rooms = new Map(); // roomId -> room

const ROOM_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function genRoomId() {
  for (let i = 0; i < 50; i++) {
    let id = '';
    for (let j = 0; j < 6; j++) id += ROOM_ID_ALPHABET[crypto.randomInt(ROOM_ID_ALPHABET.length)];
    if (!rooms.has(id)) return id;
  }
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function parseScript(text) {
  if (!text) return [];
  return String(text)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 300)
    .map((raw) => {
      const m = raw.match(/^([^：:]{1,12})[：:]\s*(.+)$/);
      return m ? { speaker: m[1].trim(), text: m[2].trim() } : { speaker: '', text: raw };
    });
}

function createRoom({ name } = {}) {
  const id = genRoomId();
  const room = {
    id,
    name: (name || '').toString().slice(0, 40) || `配音室 ${id}`,
    createdAt: Date.now(),
    lines: [],
    chat: [],
    users: new Map(),
  };
  rooms.set(id, room);
  persistSoon();
  return room;
}

function takeExt(mime) {
  if (!mime) return 'webm';
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

const MIME_BY_EXT = { webm: 'audio/webm', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav' };

function roomState(room) {
  return {
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    lines: room.lines.map((l) => ({
      ...l,
      take: l.take ? { ...l.take, url: `/api/rooms/${room.id}/take/${l.id}` } : null,
    })),
    chat: room.chat.slice(-100),
  };
}

function usersOf(room) {
  const byUser = new Map();
  for (const u of room.users.values()) {
    if (!byUser.has(u.id)) byUser.set(u.id, { ...u });
    else byUser.get(u.id).voice = byUser.get(u.id).voice || u.voice;
  }
  return [...byUser.values()].map((u) => ({
    id: u.id,
    name: u.name,
    color: u.color,
    voice: !!u.voice,
    muted: !!u.muted,
    sid: u.sid,
  }));
}

function broadcastUsers(room) {
  io.to(room.id).emit('presence:update', usersOf(room));
}

function pushChat(room, msg) {
  room.chat.push(msg);
  if (room.chat.length > 500) room.chat.splice(0, room.chat.length - 500);
  persistSoon();
}

function findLine(room, lineId) {
  return room ? room.lines.find((l) => l.id === lineId) : null;
}

/* ================= 持久化 ================= */

let persistTimer = null;

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const dump = {};
      for (const [id, room] of rooms) {
        dump[id] = {
          id: room.id,
          name: room.name,
          createdAt: room.createdAt,
          lines: room.lines,
          chat: room.chat.slice(-100),
        };
      }
      fs.writeFileSync(path.join(DATA_DIR, 'rooms.json'), JSON.stringify(dump));
    } catch (e) {
      console.error('[persist] 失败:', e.message);
    }
  }, 400);
}

function loadRooms() {
  try {
    const dump = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rooms.json'), 'utf8'));
    for (const [id, r] of Object.entries(dump)) {
      rooms.set(id, {
        id: r.id || id,
        name: r.name || `配音室 ${id}`,
        createdAt: r.createdAt || Date.now(),
        lines: Array.isArray(r.lines) ? r.lines : [],
        chat: Array.isArray(r.chat) ? r.chat : [],
        users: new Map(),
      });
    }
    if (rooms.size) console.log(`[init] 已恢复 ${rooms.size} 个配音室`);
  } catch (e) {
    /* 首次启动无存档文件，忽略 */
  }
}

loadRooms();

/* ================= REST API（需登录） ================= */

const api = express.Router();

// 创建配音室（可粘贴台词本）
api.post('/rooms', (req, res) => {
  const room = createRoom({ name: req.body && req.body.name });
  const lines = parseScript(req.body && req.body.script).map((l) => ({
    id: crypto.randomUUID(),
    speaker: l.speaker,
    text: l.text,
    take: null,
  }));
  room.lines = lines;
  persistSoon();
  res.json({ room: roomState(room) });
});

// 配音室信息
api.get('/rooms/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: '房间不存在或已解散' });
  res.json({ room: roomState(room), users: usersOf(room) });
});

// 添加台词
api.post('/rooms/:roomId/lines', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  const text = (req.body.text || '').toString().trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: '台词不能为空' });
  const line = {
    id: crypto.randomUUID(),
    speaker: (req.body.speaker || '').toString().slice(0, 20),
    text,
    take: null,
  };
  room.lines.push(line);
  persistSoon();
  io.to(room.id).emit('line:added', line);
  res.json({ line });
});

// 修改台词
api.patch('/rooms/:roomId/lines/:lineId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  const line = findLine(room, req.params.lineId);
  if (!room || !line) return res.status(404).json({ error: '台词不存在' });
  if (req.body.text != null) line.text = String(req.body.text).slice(0, 500);
  if (req.body.speaker != null) line.speaker = String(req.body.speaker).slice(0, 20);
  persistSoon();
  io.to(room.id).emit('line:updated', line);
  res.json({ line });
});

// 删除台词
api.delete('/rooms/:roomId/lines/:lineId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  const idx = room ? room.lines.findIndex((l) => l.id === req.params.lineId) : -1;
  if (!room || idx < 0) return res.status(404).json({ error: '台词不存在' });
  const [line] = room.lines.splice(idx, 1);
  if (line.take) {
    const dir = path.join(TAKES_DIR, room.id);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(line.id + '.')) fs.unlinkSync(path.join(dir, f));
      }
    } catch (e) { /* 目录可能不存在 */ }
  }
  persistSoon();
  io.to(room.id).emit('line:removed', { lineId: line.id });
  res.json({ ok: true });
});

// 重命名配音室
api.post('/rooms/:roomId/rename', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: '房间不存在' });
  room.name = String(req.body.name || '').slice(0, 40) || room.name;
  persistSoon();
  io.to(room.id).emit('room:renamed', { name: room.name });
  res.json({ name: room.name });
});

// 上传某条台词的录音
api.post('/rooms/:roomId/lines/:lineId/take', (req, res) => {
  const room = rooms.get(req.params.roomId);
  const line = findLine(room, req.params.lineId);
  if (!room || !line) return res.status(404).json({ error: '台词不存在' });
  const { duration, mime, data } = req.body || {};
  const account = req.account;
  if (!data || typeof data !== 'string') return res.status(400).json({ error: '缺少音频数据' });
  const buf = Buffer.from(data, 'base64');
  if (!buf.length || buf.length > MAX_TAKE_MB * 1024 * 1024) {
    return res.status(400).json({ error: `音频大小超出限制（最大 ${MAX_TAKE_MB}MB）` });
  }
  const ext = takeExt(mime);
  const dir = path.join(TAKES_DIR, room.id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(line.id + '.')) fs.unlinkSync(path.join(dir, f));
    }
  } catch (e) { /* 忽略 */ }
  const takeId = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, `${line.id}.${takeId}.${ext}`), buf);
  line.take = {
    id: takeId,
    by: account.id,
    byName: account.username,
    at: Date.now(),
    duration: Math.round(Number(duration) || 0),
    mime: mime || MIME_BY_EXT[ext],
    url: `/api/rooms/${room.id}/take/${line.id}`,
  };
  persistSoon();
  io.to(room.id).emit('line:updated', line);
  res.json({ line });
});

// 下载某条台词的录音
api.get('/rooms/:roomId/take/:lineId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  const line = findLine(room, req.params.lineId);
  if (!room || !line || !line.take) return res.status(404).json({ error: '录音不存在' });
  const dir = path.join(TAKES_DIR, room.id);
  let file = null;
  try {
    file = fs.readdirSync(dir).find((f) => f.startsWith(line.id + '.'));
  } catch (e) { /* 忽略 */ }
  if (!file) return res.status(404).json({ error: '录音文件缺失' });
  const ext = file.split('.').pop();
  res.setHeader('Content-Type', MIME_BY_EXT[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(dir, file));
});

app.use('/api', authRequired, api);

app.get('/healthz', (req, res) => {
  res.json({ ok: true, rooms: rooms.size, users: users.size, uptime: Math.round(process.uptime()) });
});

// SPA 路由：首页与配音室页
app.get(['/', '/r/:roomId'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ error: err.message || '服务器错误' });
});

/* ================= WebSocket ================= */

io.on('connection', (socket) => {
  socket.on('room:join', ({ roomId, token } = {}) => {
    const room = rooms.get(String(roomId || ''));
    if (!room) {
      socket.emit('room:error', '房间不存在或已解散');
      return;
    }
    const account = resolveToken(token);
    if (!account) {
      socket.emit('auth:expired', '登录已过期，请重新登录');
      return;
    }
    const me = {
      sid: socket.id,
      id: account.id,
      name: account.username,
      color: colorFromId(account.id),
      voice: false,
      muted: false,
    };
    room.users.set(socket.id, me);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.userId = me.id;

    const sysMsg = { id: crypto.randomUUID(), system: true, text: `${me.name} 加入了配音室`, at: Date.now() };
    pushChat(room, sysMsg);
    io.to(room.id).emit('chat:message', sysMsg);
    broadcastUsers(room);
    socket.emit('room:state', { room: roomState(room), users: usersOf(room), me });
  });

  // 文字聊天
  socket.on('chat:message', ({ text } = {}) => {
    const room = rooms.get(socket.data.roomId);
    const me = room && room.users.get(socket.id);
    if (!room || !me) return;
    const t = String(text || '').trim().slice(0, 500);
    if (!t) return;
    const msg = { id: crypto.randomUUID(), by: me.id, byName: me.name, color: me.color, text: t, at: Date.now() };
    pushChat(room, msg);
    io.to(room.id).emit('chat:message', msg);
  });

  /* ---- 语音聊天（WebRTC Mesh 信令） ---- */

  socket.on('voice:join', () => {
    const room = rooms.get(socket.data.roomId);
    const me = room && room.users.get(socket.id);
    if (!room || !me || me.voice) return;
    me.voice = true;
    me.muted = false;
    const peers = [...room.users.values()]
      .filter((u) => u.voice && u.sid !== socket.id)
      .map((u) => ({ sid: u.sid, name: u.name }));
    socket.emit('voice:peers', { peers });
    socket.to(room.id).emit('voice:peer-joined', { sid: socket.id, name: me.name });
    broadcastUsers(room);
  });

  socket.on('voice:leave', () => {
    const room = rooms.get(socket.data.roomId);
    const me = room && room.users.get(socket.id);
    if (!room || !me || !me.voice) return;
    me.voice = false;
    socket.to(room.id).emit('voice:peer-left', { sid: socket.id });
    broadcastUsers(room);
  });

  socket.on('voice:mute', ({ muted } = {}) => {
    const room = rooms.get(socket.data.roomId);
    const me = room && room.users.get(socket.id);
    if (!room || !me) return;
    me.muted = !!muted;
    broadcastUsers(room);
  });

  socket.on('voice:signal', ({ to, type, data } = {}) => {
    if (!to || !type) return;
    io.to(to).emit('voice:signal', { from: socket.id, type, data });
  });

  socket.on('voice:speaking', ({ speaking } = {}) => {
    const room = rooms.get(socket.data.roomId);
    const me = room && room.users.get(socket.id);
    if (!room || !me || !me.voice) return;
    socket.to(room.id).emit('voice:speaking', { sid: socket.id, speaking: !!speaking });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.users) return;
    const me = room.users.get(socket.id);
    if (!me) return;
    room.users.delete(socket.id);

    // 同一账号还有其他标签页在场，则不广播离开
    const stillHere = [...room.users.values()].some((u) => u.id === me.id);
    if (!stillHere) {
      const sysMsg = { id: crypto.randomUUID(), system: true, text: `${me.name} 离开了配音室`, at: Date.now() };
      pushChat(room, sysMsg);
      io.to(room.id).emit('chat:message', sysMsg);
    }
    if (me.voice) socket.to(room.id).emit('voice:peer-left', { sid: socket.id });
    broadcastUsers(room);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`🎬 配音工坊已启动: http://${HOST}:${PORT}`);
});
