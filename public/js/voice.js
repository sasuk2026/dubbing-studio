'use strict';

/**
 * VoiceChat —— WebRTC Mesh 语音聊天
 * 加入房间后与房内其他语音成员两两建立 P2P 连接，
 * 信令（offer / answer / ice）通过 Socket.io 服务端转发。
 */

class VoiceChat {
  constructor({ socket, onError }) {
    this.socket = socket;
    this.onError = onError || (() => {});
    this.pcs = new Map();      // sid -> {pc, audio}
    this.localStream = null;
    this.joined = false;
    this.muted = false;
    this.analyser = null;
    this.audioCtx = null;
    this.speaking = false;
    this._speakTimer = null;
    this.onChange = null;      // UI 刷新回调
  }

  async join() {
    if (this.joined) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.onError('当前浏览器不支持语音聊天（需 HTTPS 或 localhost 环境）');
      return;
    }
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.onError('无法访问麦克风：' + (e.message || e.name || '权限被拒绝'));
      return;
    }
    this.joined = true;
    this.socket.emit('voice:join');
    this.setupSpeakingDetection();
    if (this.onChange) this.onChange();
  }

  leave() {
    if (!this.joined) return;
    this.joined = false;
    this.socket.emit('voice:leave');
    for (const [, entry] of this.pcs) {
      this._closeEntry(entry);
    }
    this.pcs.clear();
    if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    if (this._speakTimer) { clearInterval(this._speakTimer); this._speakTimer = null; }
    this.speaking = false;
    if (this.onChange) this.onChange();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    }
    this.socket.emit('voice:mute', { muted: this.muted });
    if (this.onChange) this.onChange();
    return this.muted;
  }

  _rtcConfig() {
    return {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    };
  }

  _closeEntry(entry) {
    try { entry.pc.close(); } catch (e) { /* 忽略 */ }
    if (entry.audio) {
      entry.audio.srcObject = null;
      entry.audio.remove();
    }
  }

  _ensurePC(sid) {
    if (this.pcs.has(sid)) return this.pcs.get(sid).pc;
    const pc = new RTCPeerConnection(this._rtcConfig());
    const entry = { pc, audio: null };
    this.pcs.set(sid, entry);
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) pc.addTrack(track, this.localStream);
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket.emit('voice:signal', { to: sid, type: 'ice', data: e.candidate });
    };
    pc.ontrack = (e) => {
      let audio = entry.audio;
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        audio.setAttribute('playsinline', '');
        document.body.appendChild(audio);
        entry.audio = audio;
      }
      audio.srcObject = e.streams[0];
      audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this._closeEntry(entry);
        this.pcs.delete(sid);
      }
    };
    return pc;
  }

  // 新人入房：向所有老成员发起 offer
  handlePeers({ peers }) {
    for (const p of peers || []) {
      const pc = this._ensurePC(p.sid);
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          this.socket.emit('voice:signal', { to: p.sid, type: 'offer', data: pc.localDescription });
        })
        .catch((e) => this.onError('语音连接发起失败：' + e.message));
    }
  }

  async handleSignal({ from, type, data }) {
    try {
      if (type === 'offer') {
        const pc = this._ensurePC(from);
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('voice:signal', { to: from, type: 'answer', data: answer });
      } else if (type === 'answer') {
        const entry = this.pcs.get(from);
        if (entry) await entry.pc.setRemoteDescription(new RTCSessionDescription(data));
      } else if (type === 'ice') {
        const entry = this.pcs.get(from);
        if (entry) await entry.pc.addIceCandidate(new RTCIceCandidate(data));
      }
    } catch (e) { /* 信令瞬时错误，忽略 */ }
  }

  handlePeerLeft(sid) {
    const entry = this.pcs.get(sid);
    if (entry) {
      this._closeEntry(entry);
      this.pcs.delete(sid);
    }
  }

  // 本地说话检测（音量阈值），状态变化时广播
  setupSpeakingDetection() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new Ctx();
      const src = this.audioCtx.createMediaStreamSource(this.localStream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      this._speakTimer = setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;
        const speaking = !this.muted && avg > 18;
        if (speaking !== this.speaking) {
          this.speaking = speaking;
          this.socket.emit('voice:speaking', { speaking });
          if (this.onChange) this.onChange();
        }
      }, 150);
    } catch (e) { /* 无说话检测也能正常语音 */ }
  }

  destroy() {
    this.leave();
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
    }
  }
}
