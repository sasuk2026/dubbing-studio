'use strict';

/**
 * AudioKit —— 浏览器端音频工具箱
 * 录音（MediaRecorder 压缩 / ScriptProcessor 无损 PCM + 电平表）、
 * WAV/MP3 合成导出（支持语速与句间间隔）、ZIP 打包、下载
 */

/* global lamejs */

const AudioKit = (() => {

  /* ---------- 共享 AudioContext ---------- *
   * Chrome 规定同一页面最多同时存在 6 个硬件 AudioContext，
   * 每次导出都 new 一个，用户多点几次导出后必然报
   * "Failed to construct 'AudioContext': ... greater than or equal to the maximum allowed (6)"，
   * 表现为「总体导出失败」且之后所有音频功能全部失灵。
   * 这里改为模块级单例复用，从根本上避免上下文耗尽。 */
  let _sharedCtx = null;
  function sharedCtx() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!_sharedCtx || _sharedCtx.state === 'closed') _sharedCtx = new Ctx();
    return _sharedCtx;
  }

  /* decodeAudioData 兼容封装：老版本 Safari 的 Promise 形式不可靠，回调 + Promise 双保险 */
  function decodeAudio(ctx, arrayBuffer) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = (b) => { if (!settled) { settled = true; resolve(b); } };
      const err = (e) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error('音频解码失败')); } };
      let p;
      try {
        p = ctx.decodeAudioData(arrayBuffer, ok, err);
      } catch (e) { err(e); return; }
      if (p && typeof p.then === 'function') p.then(ok, err);
    });
  }

  function pickMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/mp4;codecs=mp4a.40.2',
    ];
    if (typeof MediaRecorder === 'undefined') return '';
    for (const c of candidates) {
      try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (e) { /* 继续尝试 */ }
    }
    return '';
  }

  function extFor(mime) {
    if (!mime) return 'webm';
    if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('wav')) return 'wav';
    return 'webm';
  }

  /* ---------- 麦克风兼容层 ---------- *
   * 标准 API：navigator.mediaDevices.getUserMedia（HTTPS 下的现代浏览器）
   * 回退 API：navigator.getUserMedia / webkitGetUserMedia（部分 App 内置 WebView、旧浏览器只暴露这些）
   * 两者都没有（或非安全上下文）→ 抛 UNSUPPORTED，由上层引导用户换系统浏览器 */
  function getMic(constraints) {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      return navigator.mediaDevices.getUserMedia(constraints);
    }
    const legacy = navigator.getUserMedia
      || navigator.webkitGetUserMedia
      || navigator.mozGetUserMedia
      || navigator.msGetUserMedia;
    if (legacy) {
      return new Promise((resolve, reject) => {
        try {
          legacy.call(navigator, constraints, resolve, reject);
        } catch (e) { reject(e); }
      });
    }
    const err = new Error('当前内置浏览器不支持网页录音');
    err.code = 'UNSUPPORTED';
    return Promise.reject(err);
  }

  /* ---------- 单条录音器 ---------- */
  class TakeRecorder {
    constructor() {
      this.stream = null;
      this.recorder = null;
      this.chunks = [];
      this.startedAt = 0;
      this.timer = null;
      this.analyser = null;
      this.audioCtx = null;
      this.meterRaf = null;
      this.lossless = false;   // true = ScriptProcessor 捕获 PCM → WAV
      this.pcmChunks = null;    // 无损模式：分片数组（每片 = 各声道 Float32Array）
      this.processor = null;
      this.silentGain = null;
      this.onTick = null;   // (ms) => void
      this.onLevel = null;  // (0..1) => void
      this.onStop = null;   // ({blob, duration, mime}) => void
    }

    async start(lossless = false) {
      this.stream = await getMic({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.lossless = !!lossless;
      this.startedAt = Date.now();
      if (this.lossless) {
        this.startPcmCapture();
      } else {
        try {
          this.startMediaRecorder();
        } catch (e) {
          // MediaRecorder 不可用（部分老旧 WebView）：自动降级无损 PCM 采集，录音功能不中断
          this.lossless = true;
          this.startPcmCapture();
        }
      }
      this.timer = setInterval(() => {
        if (this.onTick) this.onTick(Date.now() - this.startedAt);
      }, 200);
      this.setupMeter();
    }

    startMediaRecorder() {
      const mime = pickMime();
      this.recorder = mime
        ? new MediaRecorder(this.stream, { mimeType: mime })
        : new MediaRecorder(this.stream);
      this.chunks = [];
      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) this.chunks.push(e.data);
      };
      this.recorder.onstop = () => {
        const type = this.recorder.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        const duration = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
        this.cleanup();
        if (this.onStop) this.onStop({ blob, duration, mime: type });
      };
      this.recorder.start(250);
    }

    // 无损模式：ScriptProcessorNode 直接捕获麦克风 PCM，停止时编码 32-bit 浮点 WAV
    startPcmCapture() {
      if (!this.audioCtx) this.audioCtx = sharedCtx();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      // 按麦克风音轨实际通道数采集（单声道麦克风录单声道，立体声设备录立体声），不做下混
      let trackCh = 1;
      try {
        const t = this.stream.getAudioTracks()[0];
        if (t && t.getSettings) trackCh = t.getSettings().channelCount || 1;
      } catch (e) { /* 用默认单声道 */ }
      this.pcmChannels = Math.max(1, Math.min(2, trackCh));
      this.pcmChunks = [];
      const processor = this.audioCtx.createScriptProcessor(4096, this.pcmChannels, this.pcmChannels);
      processor.onaudioprocess = (e) => {
        if (!this.pcmChunks) return;
        const frames = [];
        for (let c = 0; c < this.pcmChannels; c++) {
          frames.push(new Float32Array(e.inputBuffer.getChannelData(c)));
        }
        this.pcmChunks.push(frames);
      };
      // 经静音增益接到 destination：保证 onaudioprocess 触发，且不外放啸叫
      this.silentGain = this.audioCtx.createGain();
      this.silentGain.gain.value = 0;
      src.connect(processor);
      processor.connect(this.silentGain);
      this.silentGain.connect(this.audioCtx.destination);
      this.processor = processor;
    }

    setupMeter() {
      try {
        if (!this.audioCtx) this.audioCtx = sharedCtx();
        const src = this.audioCtx.createMediaStreamSource(this.stream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        src.connect(this.analyser);
        const data = new Uint8Array(this.analyser.frequencyBinCount);
        const loop = () => {
          if (!this.analyser) return;
          this.analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          const avg = sum / data.length / 255;
          if (this.onLevel) this.onLevel(Math.min(1, avg * 2.4));
          this.meterRaf = requestAnimationFrame(loop);
        };
        loop();
      } catch (e) { /* 电平表失败不影响录音 */ }
    }

    stop() {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop();
      } else if (this.lossless) {
        this.finishPcm();
      }
    }

    finishPcm() {
      const sr = this.audioCtx ? this.audioCtx.sampleRate : 44100;
      const channels = this.pcmChannels || 1;
      const chunks = this.pcmChunks || [];
      const total = chunks.reduce((s, c) => s + c[0].length, 0);
      const duration = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
      if (!total) {
        this.cleanup();
        if (this.onStop) this.onStop({ blob: null, duration, mime: '', error: '未捕获到音频' });
        return;
      }
      const buf = this.audioCtx.createBuffer(channels, total, sr);
      for (let c = 0; c < channels; c++) {
        const dst = buf.getChannelData(c);
        let off = 0;
        for (const chunk of chunks) {
          dst.set(chunk[Math.min(c, chunk.length - 1)], off);
          off += chunk[0].length;
        }
      }
      // 32-bit 浮点 WAV：位完美保留麦克风原始采样
      const blob = audioBufferToWav(buf, { float: true });
      this.cleanup();
      if (this.onStop) this.onStop({ blob, duration, mime: 'audio/wav', channels });
    }

    cancel() {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.onstop = null;
        try { this.recorder.stop(); } catch (e) { /* 忽略 */ }
      }
      this.cleanup();
    }

    cleanup() {
      if (this.timer) clearInterval(this.timer);
      if (this.meterRaf) cancelAnimationFrame(this.meterRaf);
      if (this.processor) {
        this.processor.onaudioprocess = null;
        try { this.processor.disconnect(); } catch (e) { /* 忽略 */ }
      }
      if (this.silentGain) {
        try { this.silentGain.disconnect(); } catch (e) { /* 忽略 */ }
      }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      // 共享 ctx 不关闭：断开节点、释放轨道即可，上下文留给下一次录音/导出复用
      if (this.audioCtx && this.audioCtx !== _sharedCtx && this.audioCtx.state !== 'closed') {
        this.audioCtx.close().catch(() => {});
      }
      this.stream = null;
      this.recorder = null;
      this.analyser = null;
      this.audioCtx = null;
      this.processor = null;
      this.silentGain = null;
      this.chunks = [];
      this.pcmChunks = null;
    }
  }

  /* ---------- WAV 编码 ---------- */
  function writeStr(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  /**
   * AudioBuffer → WAV
   * @param buf AudioBuffer
   * @param opts {float} true = 32-bit IEEE float（真无损，保留 [-1,1] 外真实幅度）；
   *                     false = 16-bit PCM（通用兼容）
   */
  function audioBufferToWav(buf, opts = {}) {
    const float = opts.float !== false;
    const numCh = Math.max(1, Math.min(2, buf.numberOfChannels));
    const sr = buf.sampleRate;
    const frames = buf.length;
    const bits = float ? 32 : 16;
    const blockAlign = numCh * (bits / 8);
    const dataSize = frames * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const view = new DataView(ab);
    writeStr(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(view, 8, 'WAVE');
    writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, float ? 3 : 1, true); // 1 = PCM，3 = IEEE float
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bits, true);
    writeStr(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)));
    let off = 44;
    if (float) {
      // 真无损：Float32 原样落盘，不量化、不钳制
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < numCh; c++) {
          view.setFloat32(off, chans[c][i] || 0, true);
          off += 4;
        }
      }
    } else {
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < numCh; c++) {
          const s = Math.max(-1, Math.min(1, chans[c][i] || 0));
          view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          off += 2;
        }
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  /* ---------- 合成导出 ---------- */

  // 变速重采样：rate > 1 加速，< 1 减速
  async function applySpeed(buf, sr, rate) {
    if (Math.abs(rate - 1) < 0.001) return buf;
    const outLen = Math.max(1, Math.ceil(buf.length / rate));
    const oc = new OfflineAudioContext(buf.numberOfChannels, outLen, sr);
    const src = oc.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(oc.destination);
    src.start(0);
    return oc.startRendering();
  }

  /**
   * 合成多条录音
   * @param blobs 音频 Blob 数组（按台词顺序）
   * @param opts { speed: 语速倍率 0.5-2, gapMs: 句间间隔毫秒, format: 'mp3'|'wav', kbps: MP3 码率 }
   * @returns {blob, ext, duration}
   */
  async function mergeTakes(blobs, opts = {}) {
    const speed = Math.min(2, Math.max(0.5, Number(opts.speed) || 1));
    const gapMs = Math.min(5000, Math.max(0, Number(opts.gapMs) ?? 250));
    const format = opts.format === 'wav' ? 'wav' : 'mp3';
    const kbps = Math.min(320, Math.max(64, Number(opts.kbps) || 192));
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = sharedCtx();
    try {
      const decoded = [];
      for (const b of blobs) {
        const ab = await b.arrayBuffer();
        decoded.push(await decodeAudio(ctx, ab));
      }
      const sr = decoded[0].sampleRate;
      // 统一采样率 + 应用语速
      const norm = [];
      for (const b of decoded) {
        let buf = b;
        if (b.sampleRate !== sr) {
          const oc = new OfflineAudioContext(b.numberOfChannels, Math.ceil(b.duration * sr), sr);
          const src = oc.createBufferSource();
          src.buffer = b;
          src.connect(oc.destination);
          src.start(0);
          buf = await oc.startRendering();
        }
        norm.push(await applySpeed(buf, sr, speed));
      }
      const gap = Math.round((gapMs / 1000) * sr);
      const channels = Math.max.apply(null, norm.map((b) => b.numberOfChannels));
      const total = norm.reduce((s, b) => s + b.length, 0) + gap * (norm.length - 1);
      const out = ctx.createBuffer(channels, total, sr);
      let offset = 0;
      for (const b of norm) {
        for (let c = 0; c < b.numberOfChannels && c < channels; c++) {
          out.getChannelData(c).set(b.getChannelData(c), offset);
        }
        offset += b.length + gap;
      }
      const duration = out.duration;
      if (format === 'mp3') {
        return { blob: encodeMp3(out, kbps), ext: 'mp3', duration };
      }
      // 合成导出同样走 32-bit 浮点，端到端不做有损量化
      return { blob: audioBufferToWav(out, { float: true }), ext: 'wav', duration };
    } finally {
      // 共享 ctx 不关闭：交由单例复用，避免反复 new/close 触碰浏览器上下文上限
      if (ctx !== _sharedCtx && ctx.state !== 'closed') ctx.close().catch(() => {});
    }
  }

  /* ---------- MP3 编码（lamejs） ---------- */
  function encodeMp3(audioBuffer, kbps) {
    if (typeof lamejs === 'undefined') {
      throw new Error('MP3 编码器未加载，请刷新页面重试');
    }
    const numCh = Math.max(1, Math.min(2, audioBuffer.numberOfChannels));
    const sr = audioBuffer.sampleRate;
    const encoder = new lamejs.Mp3Encoder(numCh, sr, kbps);
    // 交织 Int16 采样
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(audioBuffer.getChannelData(Math.min(c, audioBuffer.numberOfChannels - 1)));
    const frames = audioBuffer.length;
    const samples = new Int16Array(frames * numCh);
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i] || 0));
        samples[i * numCh + c] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    const chunkSize = 1152 * numCh;
    const parts = [];
    for (let i = 0; i < samples.length; i += chunkSize) {
      const chunk = samples.subarray(i, Math.min(i + chunkSize, samples.length));
      const buf = encoder.encodeBuffer(chunk);
      if (buf.length > 0) parts.push(new Uint8Array(buf));
    }
    const end = encoder.flush();
    if (end.length > 0) parts.push(new Uint8Array(end));
    return new Blob(parts, { type: 'audio/mpeg' });
  }

  /* ---------- ZIP（store 模式） ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = new Uint8Array(await f.blob.arrayBuffer());
      const crc = crc32(data);

      const lh = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, 0, true); // store
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      parts.push(lh, data);

      const cd = new Uint8Array(46 + nameBytes.length);
      const dv2 = new DataView(cd.buffer);
      dv2.setUint32(0, 0x02014b50, true);
      dv2.setUint16(4, 20, true);
      dv2.setUint16(6, 20, true);
      dv2.setUint16(8, 0, true);
      dv2.setUint16(10, 0, true);
      dv2.setUint16(12, 0, true);
      dv2.setUint16(14, 0, true);
      dv2.setUint32(16, crc, true);
      dv2.setUint32(20, data.length, true);
      dv2.setUint32(24, data.length, true);
      dv2.setUint16(28, nameBytes.length, true);
      dv2.setUint16(30, 0, true);
      dv2.setUint16(32, 0, true);
      dv2.setUint16(34, 0, true);
      dv2.setUint16(36, 0, true);
      dv2.setUint32(38, 0, true);
      dv2.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += lh.length + data.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const dv3 = new DataView(end.buffer);
    dv3.setUint32(0, 0x06054b50, true);
    dv3.setUint16(8, files.length, true);
    dv3.setUint16(10, files.length, true);
    dv3.setUint32(12, cdSize, true);
    dv3.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  /* ---------- 工具 ---------- */
  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 5000);
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('音频读取失败'));
      r.readAsDataURL(blob);
    });
  }

  return { TakeRecorder, pickMime, extFor, mergeTakes, makeZip, downloadBlob, fmtTime, blobToBase64 };
})();
