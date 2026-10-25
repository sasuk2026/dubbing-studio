'use strict';

/* global io, AudioKit, VoiceChat */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

// 安全事件绑定：元素缺失时跳过而非抛异常（防止单个元素问题拖垮整个脚本）
function on(id, evt, fn) {
  const el = $(id);
  if (el) el.addEventListener(evt, fn);
}

const LS_TOKEN = 'dub_token';

// 安全存储封装：Safari 隐私模式 / 禁用 DOM 存储的浏览器访问 localStorage 会抛异常，
// 若在顶层直接调用会导致整个脚本加载失败（所有按钮失灵）。统一 try/catch 兜底。
const store = {
  get(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  },
  set(key, val) {
    try { window.localStorage.setItem(key, val); return true; } catch (e) { return false; }
  },
  remove(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
  },
};

const SAMPLE_SCRIPT = [
  '旁白：夜幕降临，小镇的灯火依次亮起。',
  '小明：终于放学啦！今天作业好多啊。',
  '小红：别抱怨啦，我们去图书馆把作业写完吧。',
  '小明：好主意！听说图书馆新到了一批漫画。',
  '小红：写完作业才可以看漫画哦。',
  '小明：好吧好吧，听你的。',
  '旁白：两个小伙伴肩并肩，走进了明亮的图书馆。',
].join('\n');

function toast(msg, type = 'info', ms = 3200) {
  const box = $('toasts');
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  div.textContent = msg;
  box.appendChild(div);
  setTimeout(() => {
    div.classList.add('out');
    setTimeout(() => div.remove(), 300);
  }, ms);
}

/* ---------------- 全局状态 ---------------- */

const state = {
  token: store.get(LS_TOKEN) || '',
  account: null,    // {id, username, color}
  roomId: null,
  room: null,       // {id, name, lines[], chat[]}
  users: [],
  socket: null,
  voice: null,
  speaking: {},     // sid -> bool
  selectedLineId: null,
  editingLineId: null,
  rec: null,        // {lineId, rec, blob, duration}
  playAll: null,
  audioEl: null,
  inviteDismissed: 0,
  authMode: 'login',
};

/* ---------------- 网络工具 ---------------- */

async function api(url, method, body, opts = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  // 免费服务冷启动时首请求可能很慢，默认 60s 超时，避免"点了没反应"
  const timeoutMs = opts.timeout || 60000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    // 登录/注册接口自身的 401 是"凭据错误"，不应触发会话过期流程
    const isAuthEndpoint = url.startsWith('/api/auth/');
    if (r.status === 401 && !isAuthEndpoint) {
      handleAuthExpired(opts.silent);
      return null;
    }
    const d = await r.json().catch(() => ({}));
    if (d.error && !opts.silent) toast(d.error, 'error');
    return d;
  } catch (e) {
    if (e.name === 'AbortError') {
      // 超时必须反馈，不受 silent 限制——这是"点了没反应"的主要嫌疑
      toast('服务响应超时（免费服务唤醒需要 30-60 秒），请再试一次', 'error', 6000);
    } else if (!opts.silent) {
      toast('网络错误，请稍后重试', 'error');
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function authFetch(url) {
  const headers = {};
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  return fetch(url, { headers });
}

/* ---------------- 账号：登录 / 注册 ---------------- */

function showAuthError(msg) {
  const el = $('auth-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

function showAuth() {
  $('auth-panel').hidden = false;
  $('lobby-panel').hidden = true;
  showAuthError('');
}

function showLobby() {
  if (!state.account) return showAuth();
  $('auth-panel').hidden = true;
  $('lobby-panel').hidden = false;
  const a = $('account-avatar');
  a.textContent = state.account.username.slice(0, 1);
  a.style.background = state.account.color;
  $('account-name').textContent = state.account.username;
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.auth === mode));
  const btn = $('btn-auth-submit');
  if (btn) {
    btn.textContent = mode === 'login' ? '登录' : '注册并登录';
    btn.classList.toggle('register-mode', mode === 'register');
  }
  $('auth-panel').classList.toggle('mode-register', mode === 'register');
  showAuthError('');
}

async function submitAuth() {
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  showAuthError('');
  if (!username) return showAuthError('请输入用户名');
  if (!password) return showAuthError('请输入密码');
  const btn = $('btn-auth-submit');
  const isLogin = state.authMode === 'login';
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = isLogin ? '登录中…' : '注册中…';
  const d = await api(`/api/auth/${isLogin ? 'login' : 'register'}`, 'POST', { username, password }, { silent: true });
  btn.disabled = false;
  btn.classList.remove('loading');
  btn.textContent = originalText;
  if (d && d.token && d.user) {
    state.token = d.token;
    state.account = d.user;
    store.set(LS_TOKEN, d.token);
    $('auth-password').value = '';
    showLobby();
    toast(`${isLogin ? '欢迎回来' : '注册成功，欢迎加入'}，${d.user.username}`, 'ok');
    maybeAutoEnterRoom();
  } else {
    showAuthError((d && d.error) || '操作失败，请重试（若等待很久没响应，可能是服务正在唤醒，稍等几秒再试）');
  }
}

function handleAuthExpired(silent) {
  const wasInRoom = !!state.roomId;
  cleanupRoom();
  state.token = '';
  state.account = null;
  store.remove(LS_TOKEN);
  $('room-view').hidden = true;
  $('home-view').hidden = false;
  showAuth();
  if (!silent) toast('登录已过期，请重新登录', 'warn');
  else if (wasInRoom) showAuthError('登录已过期，请重新登录');
}

async function logout() {
  await api('/api/auth/logout', 'POST', null, { silent: true });
  cleanupRoom();
  state.token = '';
  state.account = null;
  store.remove(LS_TOKEN);
  $('room-view').hidden = true;
  $('home-view').hidden = false;
  history.pushState(null, '', '/');
  showAuth();
  toast('已退出登录', 'info');
}

function maybeAutoEnterRoom() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{3,12})$/);
  if (m) enterRoom(decodeURIComponent(m[1]).toUpperCase());
}

function initAuthUI() {
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => setAuthMode(tab.dataset.auth));
  });
  on('btn-auth-submit', 'click', submitAuth);
  on('auth-password', 'keydown', (e) => {
    if (e.key === 'Enter') submitAuth();
  });
  on('auth-username', 'keydown', (e) => {
    if (e.key === 'Enter') $('auth-password').focus();
  });
  on('btn-logout', 'click', logout);
}

/* ---------------- 大厅 ---------------- */

function initLobbyUI() {
  on('btn-create', 'click', async () => {
    const d = await api('/api/rooms', 'POST', {
      name: `${state.account.username}的配音室`,
      script: $('script-input').value,
    });
    if (d && d.room) enterRoom(d.room.id);
  });

  on('btn-join', 'click', () => {
    const id = $('join-id').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,10}$/.test(id)) return toast('房间号格式不正确（4-10 位字母数字）', 'warn');
    enterRoom(id);
  });

  on('join-id', 'keydown', (e) => {
    if (e.key === 'Enter') $('btn-join').click();
  });

  const sampleBtn = document.querySelector('[data-sample]');
  if (sampleBtn) {
    sampleBtn.addEventListener('click', () => {
      $('script-input').value = SAMPLE_SCRIPT;
    });
  }
}

/* ---------------- 进入配音室 ---------------- */

function enterRoom(roomId) {
  if (!state.account) {
    $('join-id').value = roomId;
    showAuthError('请先登录后再进入配音室');
    return;
  }
  state.roomId = roomId;
  state.inviteDismissed = 0;
  state.selectedLineId = null;
  history.pushState(null, '', '/r/' + roomId);
  $('home-view').hidden = true;
  $('room-view').hidden = false;
  $('room-missing').hidden = true;
  $('header-account-name').textContent = state.account.username;
  connectSocket();
  // 免费服务冷启动提示
  clearTimeout(state.coldStartTimer);
  state.coldStartTimer = setTimeout(() => {
    if (!state.socket || !state.socket.connected) {
      toast('服务器冷启动中（免费服务约需 30-60 秒），请稍候…', 'info', 8000);
    }
  }, 3500);
}

function connectSocket() {
  if (state.socket) {
    state.socket.emit('room:join', { roomId: state.roomId, token: state.token });
    return;
  }
  const socket = io({ transports: ['polling', 'websocket'] });
  state.socket = socket;

  socket.on('connect', () => {
    $('conn-status').textContent = '已连接';
    $('conn-status').className = 'conn ok';
    socket.emit('room:join', { roomId: state.roomId, token: state.token });
  });
  socket.on('disconnect', () => {
    $('conn-status').textContent = '连接断开，重连中…';
    $('conn-status').className = 'conn bad';
  });
  socket.on('connect_error', () => {
    $('conn-status').textContent = '连接失败';
    $('conn-status').className = 'conn bad';
  });

  socket.on('room:error', (msg) => {
    if (/不存在|解散/.test(msg)) {
      $('room-missing').hidden = false;
    } else {
      toast(msg, 'error');
    }
  });
  socket.on('auth:expired', () => handleAuthExpired());

  socket.on('room:state', ({ room, users }) => {
    state.room = room;
    state.users = users || [];
    state.selectedLineId = null;
    renderAll();
  });

  socket.on('line:added', (line) => {
    if (!state.room || state.room.lines.some((l) => l.id === line.id)) return;
    state.room.lines.push(line);
    renderLines();
    updateCounts();
  });
  socket.on('line:updated', (line) => applyLine(line));
  socket.on('line:removed', ({ lineId }) => {
    if (!state.room) return;
    state.room.lines = state.room.lines.filter((l) => l.id !== lineId);
    renderLines();
    updateCounts();
  });
  socket.on('line:error', (msg) => toast(msg, 'warn'));
  socket.on('room:renamed', ({ name }) => {
    if (!state.room) return;
    state.room.name = name;
    renderShell();
  });

  socket.on('presence:update', (users) => {
    state.users = users || [];
    renderUsers();
  });
  socket.on('chat:message', (msg) => appendChat(msg));

  /* 语音 */
  state.voice = new VoiceChat({ socket, onError: (m) => toast(m, 'error') });
  state.voice.onChange = () => renderVoiceUsers();
  socket.on('voice:peers', (d) => state.voice.handlePeers(d));
  socket.on('voice:signal', (d) => state.voice.handleSignal(d));
  socket.on('voice:peer-joined', () => {});
  socket.on('voice:peer-left', ({ sid }) => {
    state.voice.handlePeerLeft(sid);
    delete state.speaking[sid];
    renderVoiceUsers();
  });
  socket.on('voice:speaking', ({ sid, speaking }) => {
    state.speaking[sid] = speaking;
    renderVoiceUsers();
  });
}

function applyLine(line) {
  if (!state.room) return;
  const idx = state.room.lines.findIndex((l) => l.id === line.id);
  if (idx >= 0) state.room.lines[idx] = line;
  renderLines();
  renderDubZone();
  updateCounts();
}

/* ---------------- 渲染 ---------------- */

function renderAll() {
  renderShell();
  renderLines();
  renderUsers();
  renderDubZone();
  updateCounts();
  const list = $('chat-list');
  list.innerHTML = '';
  (state.room.chat || []).forEach(appendChat);
}

function renderShell() {
  if (!state.room) return;
  $('room-name').textContent = state.room.name;
  $('room-id').textContent = state.room.id;
  $('invite-link').value = location.origin + '/r/' + state.room.id;
  document.title = `${state.room.name} · 配音工坊`;
}

function lineStatus(line) {
  if (line.take) return { cls: 'done', text: `✅ ${line.take.byName} 已录制` };
  return { cls: 'todo', text: '待录制' };
}

function renderLines() {
  if (!state.room) return;
  const wrap = $('lines-list');
  wrap.innerHTML = '';
  const lines = state.room.lines;
  $('lines-empty').hidden = lines.length > 0;
  lines.forEach((line, i) => {
    const st = lineStatus(line);
    const selected = state.selectedLineId === line.id;
    const card = document.createElement('div');
    card.className = `line-card ${st.cls}${selected ? ' selected' : ''}`;
    card.dataset.lineId = line.id;

    if (state.editingLineId === line.id) {
      card.innerHTML = `
        <div class="line-edit">
          <input class="edit-speaker" value="${esc(line.speaker)}" placeholder="角色（可选）" maxlength="12">
          <textarea class="edit-text" rows="2" maxlength="500">${esc(line.text)}</textarea>
          <div class="line-edit-actions">
            <button class="btn primary sm" data-action="save-edit">保存</button>
            <button class="btn ghost sm" data-action="cancel-edit">取消</button>
          </div>
        </div>`;
    } else {
      card.innerHTML = `
        <div class="line-no">${i + 1}</div>
        <div class="line-body">
          <div class="line-meta">
            ${line.speaker ? `<span class="speaker">${esc(line.speaker)}</span>` : ''}
            <span class="badge ${st.cls}">${st.text}</span>
            ${line.take ? `<span class="dur">时长 ${AudioKit.fmtTime(line.take.duration)}</span>` : ''}
          </div>
          <div class="line-text">${esc(line.text)}</div>
        </div>
        <div class="line-actions">
          ${line.take ? '<button class="btn icon" data-action="play" title="播放录音">▶</button>' : ''}
          <button class="btn ghost icon" data-action="edit" title="编辑台词">✎</button>
          <button class="btn ghost icon" data-action="delete" title="删除台词">✕</button>
        </div>`;
    }
    wrap.appendChild(card);
  });
}

/* ---------- 选中配音 ---------- */

function selectLine(lineId) {
  state.selectedLineId = state.selectedLineId === lineId ? null : lineId;
  renderLines();
  renderDubZone();
}

function renderDubZone() {
  if (!state.room) return;
  const hint = $('dub-hint');
  const target = $('dub-target');
  const line = state.room.lines.find((l) => l.id === state.selectedLineId);
  if (!line) {
    hint.hidden = false;
    target.hidden = true;
    return;
  }
  hint.hidden = true;
  target.hidden = false;
  const no = state.room.lines.indexOf(line) + 1;
  const preview = line.text.length > 24 ? line.text.slice(0, 24) + '…' : line.text;
  $('dub-target-label').textContent = `第 ${no} 条${line.speaker ? ' · ' + line.speaker : ''}：${preview}`;
  $('btn-dub').textContent = line.take ? '↻ 重新配音' : '🎙 开始配音';
}

on('btn-dub', 'click', () => {
  const line = state.room.lines.find((l) => l.id === state.selectedLineId);
  if (line) startRecording(line);
});

function renderUsers() {
  const wrap = $('user-avatars');
  wrap.innerHTML = '';
  state.users.forEach((u) => {
    const a = document.createElement('div');
    a.className = 'avatar' + (u.voice ? ' in-voice' : '');
    a.style.background = u.color;
    a.textContent = (u.name || '?').slice(0, 1);
    a.title = `${u.name}${u.voice ? (u.muted ? '（语音中 · 静音）' : '（语音中）') : ''}`;
    wrap.appendChild(a);
  });
  const n = state.users.length;
  $('invite-count').textContent = n;
  const bar = $('invite-bar');
  if (n >= 2 && state.inviteDismissed < n) bar.hidden = false;
  else bar.hidden = true;
  renderVoiceUsers();
}

function renderVoiceUsers() {
  const wrap = $('voice-users');
  if (!wrap) return;
  wrap.innerHTML = '';
  const inVoice = state.users.filter((u) => u.voice);
  if (!inVoice.length) {
    wrap.innerHTML = '<div class="empty">语音室里还没有人，点击上方按钮加入</div>';
    return;
  }
  inVoice.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'voice-user' + (state.speaking[u.sid] ? ' speaking' : '');
    row.innerHTML = `
      <span class="avatar" style="background:${esc(u.color)}">${esc((u.name || '?').slice(0, 1))}</span>
      <span class="vname">${esc(u.name)}${u.id === state.account.id ? '（你）' : ''}</span>
      <span class="vstate">${u.muted ? '🔇' : state.speaking[u.sid] ? '🎙️' : ''}</span>`;
    wrap.appendChild(row);
  });
}

function updateCounts() {
  if (!state.room) return;
  const total = state.room.lines.length;
  const done = state.room.lines.filter((l) => l.take).length;
  $('done-count').textContent = done;
  $('total-count').textContent = total;
  $('lines-count').textContent = `(${total})`;
}

/* ---------------- 台词操作 ---------------- */

on('lines-list', 'click', async (e) => {
  const card = e.target.closest('.line-card');
  if (!card || !state.room) return;
  const lineId = card.dataset.lineId;
  const line = state.room.lines.find((l) => l.id === lineId);
  if (!line) return;
  const btn = e.target.closest('[data-action]');

  // 点击卡片本体：选中/取消选中该句
  if (!btn) {
    if (state.editingLineId !== lineId) selectLine(lineId);
    return;
  }

  const action = btn.dataset.action;
  if (action === 'play') playTake(line);
  else if (action === 'edit') { state.editingLineId = lineId; renderLines(); }
  else if (action === 'cancel-edit') { state.editingLineId = null; renderLines(); }
  else if (action === 'save-edit') {
    const speaker = card.querySelector('.edit-speaker').value.trim();
    const text = card.querySelector('.edit-text').value.trim();
    if (!text) return toast('台词不能为空', 'warn');
    await api(`/api/rooms/${state.roomId}/lines/${lineId}`, 'PATCH', { speaker, text });
    state.editingLineId = null;
  } else if (action === 'delete') {
    const no = state.room.lines.indexOf(line) + 1;
    if (!confirm(`删除第 ${no} 条台词${line.take ? '（含已录制的录音）' : ''}？`)) return;
    if (state.selectedLineId === lineId) state.selectedLineId = null;
    await api(`/api/rooms/${state.roomId}/lines/${lineId}`, 'DELETE');
    renderDubZone();
  }
});

on('btn-add-line', 'click', () => {
  const wrap = $('lines-list');
  if ($('add-line-form')) return;
  const form = document.createElement('div');
  form.className = 'line-card';
  form.id = 'add-line-form';
  form.innerHTML = `
    <div class="line-edit">
      <input id="new-speaker" placeholder="角色（可选）" maxlength="12">
      <textarea id="new-text" rows="2" maxlength="500" placeholder="输入台词内容…"></textarea>
      <div class="line-edit-actions">
        <button class="btn primary sm" id="new-save">添加</button>
        <button class="btn ghost sm" id="new-cancel">取消</button>
      </div>
    </div>`;
  wrap.prepend(form);
  $('new-text').focus();
  $('new-cancel').onclick = () => form.remove();
  $('new-save').onclick = async () => {
    const text = $('new-text').value.trim();
    if (!text) return toast('台词不能为空', 'warn');
    const d = await api(`/api/rooms/${state.roomId}/lines`, 'POST', {
      speaker: $('new-speaker').value.trim(),
      text,
    });
    if (d) form.remove();
  };
});

/* ---------------- 录音 ---------------- */

async function startRecording(line) {
  if (line.take) {
    const no = state.room.lines.indexOf(line) + 1;
    if (!confirm(`第 ${no} 条已有 ${line.take.byName} 的配音，重新录制将覆盖它，确定？`)) return;
  }
  await openRecorder(line);
}

async function openRecorder(line) {
  const modal = $('recorder-modal');
  $('rec-speaker').textContent = line.speaker || '旁白';
  $('rec-text').textContent = line.text;
  $('rec-preview').hidden = true;
  $('rec-preview').removeAttribute('src');
  $('btn-rec-save').hidden = true;
  $('btn-rec-retry').hidden = true;
  $('btn-rec-stop').hidden = false;
  $('btn-rec-stop').disabled = false;
  $('rec-state').textContent = '正在录音…';
  $('rec-timer').textContent = '00:00';
  modal.hidden = false;

  const rec = new AudioKit.TakeRecorder();
  state.rec = { lineId: line.id, rec, blob: null, duration: 0 };
  rec.onTick = (ms) => { $('rec-timer').textContent = AudioKit.fmtTime(ms / 1000); };
  rec.onLevel = (lv) => drawMeter(lv);
  rec.onStop = ({ blob, duration }) => {
    state.rec.blob = blob;
    state.rec.duration = duration;
    $('rec-state').textContent = `录音完成（${AudioKit.fmtTime(duration)}），可试听或保存`;
    $('rec-timer').textContent = AudioKit.fmtTime(duration);
    $('btn-rec-stop').hidden = true;
    $('btn-rec-save').hidden = false;
    $('btn-rec-save').disabled = false;
    $('btn-rec-save').textContent = '💾 保存录音';
    $('btn-rec-retry').hidden = false;
    const p = $('rec-preview');
    p.src = URL.createObjectURL(blob);
    p.hidden = false;
    stopMeter();
  };

  try {
    await rec.start();
  } catch (e) {
    modal.hidden = true;
    state.rec = null;
    toast(e.message || '录音启动失败', 'error');
  }
}

let meterCtx = null;

function drawMeter(level) {
  const cv = $('rec-meter');
  if (!meterCtx) meterCtx = cv.getContext('2d');
  const ctx = meterCtx;
  const w = cv.width;
  const h = cv.height;
  ctx.clearRect(0, 0, w, h);
  const bars = 28;
  const bw = w / bars - 2;
  for (let i = 0; i < bars; i++) {
    const t = i / bars;
    const v = Math.max(0.05, level * (0.55 + 0.45 * Math.sin(t * Math.PI)) * (1 - t * 0.35));
    const bh = Math.max(3, v * (h - 8));
    ctx.fillStyle = level > 0.02 ? '#6c8cff' : '#2a3040';
    ctx.fillRect(i * (bw + 2), h - bh - 4, bw, bh);
  }
}

function stopMeter() {
  const cv = $('rec-meter');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
}

on('btn-rec-stop', 'click', () => {
  if (state.rec && state.rec.rec) state.rec.rec.stop();
});

on('btn-rec-retry', 'click', async () => {
  const lineId = state.rec && state.rec.lineId;
  const line = state.room.lines.find((l) => l.id === lineId);
  if (!line) return;
  $('recorder-modal').hidden = true;
  state.rec = null;
  await openRecorder(line);
});

on('btn-rec-cancel', 'click', () => {
  if (state.rec && state.rec.rec) state.rec.rec.cancel();
  state.rec = null;
  $('recorder-modal').hidden = true;
  stopMeter();
});

on('btn-rec-save', 'click', async () => {
  if (!state.rec || !state.rec.blob) return;
  const { lineId, blob, duration } = state.rec;
  const btn = $('btn-rec-save');
  btn.disabled = true;
  btn.textContent = '上传中…';
  try {
    const b64 = await AudioKit.blobToBase64(blob);
    const d = await api(`/api/rooms/${state.roomId}/lines/${lineId}/take`, 'POST', {
      duration,
      mime: blob.type || 'audio/webm',
      data: b64,
    });
    if (d) {
      toast('录音已保存 🎉', 'ok');
      $('recorder-modal').hidden = true;
      state.rec = null;
      stopMeter();
    } else {
      btn.disabled = false;
      btn.textContent = '💾 保存录音';
    }
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = '💾 保存录音';
  }
});

/* ---------------- 播放 ---------------- */

function playTake(line) {
  if (!line.take) return;
  stopPlayAll();
  if (state.audioEl) { try { state.audioEl.pause(); } catch (e) { /* 忽略 */ } }
  const audio = new Audio(line.take.url);
  state.audioEl = audio;
  audio.play().catch(() => toast('播放失败', 'error'));
}

on('btn-play-all', 'click', () => {
  if (state.playAll) { stopPlayAll(); return; }
  const lines = state.room.lines.filter((l) => l.take);
  if (!lines.length) return toast('还没有已录制的台词', 'warn');
  let idx = 0;
  $('btn-play-all').textContent = '⏹ 停止连播';
  const playNext = () => {
    if (idx >= lines.length) { stopPlayAll(); return; }
    const line = lines[idx];
    const audio = new Audio(line.take.url);
    state.playAll = { audio, idx };
    audio.onended = () => { idx += 1; playNext(); };
    audio.onerror = () => { idx += 1; playNext(); };
    audio.play().catch(() => { idx += 1; playNext(); });
    document.querySelectorAll('.line-card.playing').forEach((c) => c.classList.remove('playing'));
    const card = document.querySelector(`.line-card[data-line-id="${line.id}"]`);
    if (card) {
      card.classList.add('playing');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };
  playNext();
});

function stopPlayAll() {
  if (state.playAll) { try { state.playAll.audio.pause(); } catch (e) { /* 忽略 */ } }
  state.playAll = null;
  $('btn-play-all').textContent = '▶ 连播';
  document.querySelectorAll('.line-card.playing').forEach((c) => c.classList.remove('playing'));
}

/* ---------------- 导出 ---------------- */

on('btn-export-all', 'click', async () => {
  const lines = state.room.lines.filter((l) => l.take);
  if (!lines.length) return toast('还没有已录制的台词', 'warn');
  const btn = $('btn-export-all');
  btn.disabled = true;
  try {
    const blobs = [];
    for (let i = 0; i < lines.length; i++) {
      toast(`正在解码第 ${i + 1}/${lines.length} 条…`, 'info', 1500);
      const r = await authFetch(lines[i].take.url);
      if (!r.ok) throw new Error(`第 ${i + 1} 条录音下载失败`);
      blobs.push(await r.blob());
    }
    const wav = await AudioKit.mergeTakes(blobs, 300);
    const name = `${state.room.name}-配音合成-${new Date().toISOString().slice(0, 10)}.wav`;
    AudioKit.downloadBlob(wav, name);
    toast('合成导出完成 🎉', 'ok');
  } catch (e) {
    toast('合成导出失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

on('btn-export-parts', 'click', async () => {
  const lines = state.room.lines.filter((l) => l.take);
  if (!lines.length) return toast('还没有已录制的台词', 'warn');
  const btn = $('btn-export-parts');
  btn.disabled = true;
  try {
    const files = [];
    for (let i = 0; i < lines.length; i++) {
      toast(`正在打包第 ${i + 1}/${lines.length} 条…`, 'info', 1500);
      const r = await authFetch(lines[i].take.url);
      if (!r.ok) throw new Error(`第 ${i + 1} 条录音下载失败`);
      const blob = await r.blob();
      const ext = AudioKit.extFor(blob.type);
      const speaker = lines[i].speaker ? lines[i].speaker + '-' : '';
      const safe = (speaker + lines[i].text).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
      files.push({ name: `${String(i + 1).padStart(2, '0')}_${safe}.${ext}`, blob });
    }
    const zip = await AudioKit.makeZip(files);
    AudioKit.downloadBlob(zip, `${state.room.name}-分段录音.zip`);
    toast('分段导出完成 🎉', 'ok');
  } catch (e) {
    toast('分段导出失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- 聊天 ---------------- */

on('chat-form', 'submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !state.socket) return;
  state.socket.emit('chat:message', { text });
  input.value = '';
});

function appendChat(msg) {
  const list = $('chat-list');
  const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 60;
  const div = document.createElement('div');
  if (msg.system) {
    div.className = 'chat-msg system';
    div.textContent = msg.text;
  } else {
    div.className = 'chat-msg';
    div.innerHTML = `<span class="chat-name" style="color:${esc(msg.color)}">${esc(msg.byName)}</span><span class="chat-text">${esc(msg.text)}</span>`;
  }
  list.appendChild(div);
  while (list.children.length > 300) list.removeChild(list.firstChild);
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

/* ---------------- 侧栏 Tab ---------------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    $('tab-chat').hidden = which !== 'chat';
    $('tab-voice').hidden = which !== 'voice';
  });
});

/* ---------------- 语音 UI ---------------- */

on('btn-voice-join', 'click', async () => {
  $('btn-voice-join').disabled = true;
  await state.voice.join();
  if (state.voice.joined) {
    $('btn-voice-join').hidden = true;
    $('voice-room').hidden = false;
  }
  $('btn-voice-join').disabled = false;
});

on('btn-voice-leave', 'click', () => {
  state.voice.leave();
  state.speaking = {};
  $('btn-voice-join').hidden = false;
  $('voice-room').hidden = true;
  $('btn-voice-mute').textContent = '🔇 静音';
  renderVoiceUsers();
});

on('btn-voice-mute', 'click', () => {
  const muted = state.voice.toggleMute();
  $('btn-voice-mute').textContent = muted ? '🔊 取消静音' : '🔇 静音';
});

/* ---------------- 邀请 ---------------- */

on('btn-copy-invite', 'click', async () => {
  const link = $('invite-link').value;
  try {
    await navigator.clipboard.writeText(link);
    toast('邀请链接已复制，发给小伙伴吧', 'ok');
  } catch (e) {
    $('invite-link').select();
    document.execCommand('copy');
    toast('邀请链接已复制', 'ok');
  }
});

on('btn-close-invite', 'click', () => {
  state.inviteDismissed = state.users.length;
  $('invite-bar').hidden = true;
});

on('btn-copy-id', 'click', async () => {
  try {
    await navigator.clipboard.writeText(state.roomId);
    toast('房间号已复制：' + state.roomId, 'ok');
  } catch (e) { /* 忽略 */ }
});

/* ---------------- 退出 / 清理 ---------------- */

function cleanupRoom() {
  stopPlayAll();
  if (state.voice) state.voice.destroy();
  if (state.socket) state.socket.disconnect();
  state.socket = null;
  state.voice = null;
  state.room = null;
  state.roomId = null;
  state.users = [];
  state.speaking = {};
  state.rec = null;
  state.editingLineId = null;
  state.selectedLineId = null;
}

function leaveRoom() {
  cleanupRoom();
  $('room-view').hidden = true;
  $('home-view').hidden = false;
  if (state.account) {
    history.pushState(null, '', '/');
    showLobby();
  } else {
    showAuth();
  }
}

on('btn-leave', 'click', leaveRoom);

on('btn-missing-home', 'click', () => {
  $('room-missing').hidden = true;
  leaveRoom();
});

/* ---------------- 启动 ---------------- */

// 全局兜底：任何未捕获错误都给出可见反馈，杜绝"点了没反应"式的静默失败
window.addEventListener('error', (e) => {
  console.error('全局错误:', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('未处理的 Promise 拒绝:', e.reason);
});

// 页面加载即唤醒服务（Render 免费版 15 分钟无访问会休眠）
(function warmupService() {
  const ping = () => fetch('/healthz').catch(() => {});
  ping();
  setInterval(ping, 4 * 60 * 1000); // 每 4 分钟保活一次
})();

(async function boot() {
  try {
    initAuthUI();
    initLobbyUI();

    const roomFromUrl = (() => {
      const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{3,12})$/);
      return m ? decodeURIComponent(m[1]).toUpperCase() : null;
    })();

    if (state.token) {
      const d = await api('/api/auth/me', 'GET', null, { silent: true });
      if (d && d.user) {
        state.account = d.user;
        showLobby();
        if (roomFromUrl) enterRoom(roomFromUrl);
        return;
      }
      state.token = '';
      store.remove(LS_TOKEN);
    }
    if (roomFromUrl) {
      $('join-id').value = roomFromUrl;
      showAuthError(`登录后即可进入配音室 ${roomFromUrl}`);
    }
    showAuth();
  } catch (e) {
    // 启动失败也必须让用户看到，而不是白屏/无反应
    console.error('启动失败:', e);
    showAuth();
    showAuthError('页面加载出现问题，请刷新重试');
  }
})();
