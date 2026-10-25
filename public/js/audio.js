'use strict';

/**
 * AudioKit —— 浏览器端音频工具箱
 * 录音（MediaRecorder 压缩 / ScriptProcessor 无损 PCM + 电平表）、
 * WAV/MP3 合成导出（支持语速与句间间隔）、ZIP 打包、下载
 */

/* global lamejs */

const AudioKit = (() => {

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
      this.pcmChunks = [];     // 无损模式：Float32Array 分片
      this.processor = null;
      this.silentGain = null;
      this.onTick = null;   // (ms) => void
      this.onLevel = null;  // (0..1) => void
      this.onStop = null;   // ({blob, duration, mime}) => void
    }

    async start(lossless = false) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('当前浏览器不支持录音（需 HTTPS 或 localhost 环境）');
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.lossless = !!lossless;
      this.startedAt = Date.now();
      if (this.lossless) {
        this.startPcmCapture();
      } else {
        this.startMediaRecorder();
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

    // 无损模式：ScriptProcessorNode 直接捕获麦克风 PCM，停止时编码 16-bit WAV
    startPcmCapture() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!this.audioCtx) this.audioCtx = new Ctx();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      this.pcmChunks = [];
      const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (!this.pcmChunks) return;
        this.pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
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
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!this.audioCtx) this.audioCtx = new Ctx();
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
      const total = this.pcmChunks.reduce((s, c) => s + c.length, 0);
      const duration = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
      if (!total) {
        this.cleanup();
        if (this.onStop) this.onStop({ blob: null, duration, mime: '', error: '未捕获到音频' });
        return;
      }
      const pcm = new Float32Array(total);
      let off = 0;
      for (const c of this.pcmChunks) { pcm.set(c, off); off += c.length; }
      const buf = this.audioCtx.createBuffer(1, total, sr);
      buf.copyToChannel(pcm, 0);
      const blob = audioBufferToWav(buf);
      this.cleanup();
      if (this.onStop) this.onStop({ blob, duration, mime: 'audio/wav' });
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
      if (this.audioCtx && this.audioCtx.state !== 'closed') {
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

  function audioBufferToWav(buf) {
    const numCh = Math.max(1, Math.min(2, buf.numberOfChannels));
    const sr = buf.sampleRate;
    const frames = buf.length;
    const blockAlign = numCh * 2;
    const dataSize = frames * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const view = new DataView(ab);
    writeStr(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(view, 8, 'WAVE');
    writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);        // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)));
    let off = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i] || 0));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
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
    const ctx = new Ctx();
    try {
      const decoded = [];
      for (const b of blobs) {
        const ab = await b.arrayBuffer();
        decoded.push(await ctx.decodeAudioData(ab));
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
      return { blob: audioBufferToWav(out), ext: 'wav', duration };
    } finally {
      if (ctx.state !== 'closed') ctx.close().catch(() => {});
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
