'use strict';

/**
 * FX —— 全站视觉特效
 * 1. 伪 3D 透视粒子背景（canvas，尊重 prefers-reduced-motion，标签隐藏时暂停）
 * 2. 卡片 3D 倾斜（指针设备）
 * 3. 录音可视化由 app.js drawMeter 增强实现
 */

(function fxBackground() {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canvas = document.createElement('canvas');
  canvas.id = 'fx-bg';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');

  let W = 0;
  let H = 0;
  let dpr = 1;
  const COUNT = reduced ? 0 : 64;
  const FOCAL = 320;
  const particles = [];

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(p) {
    p.x = (Math.random() - 0.5) * 1600;
    p.y = (Math.random() - 0.5) * 1000;
    p.z = 200 + Math.random() * 900;
    p.vz = -18 - Math.random() * 26;
    p.size = 1 + Math.random() * 2.2;
    p.hue = 220 + Math.random() * 60; // 蓝紫区间
    return p;
  }

  for (let i = 0; i < COUNT; i++) particles.push(spawn({}));

  let running = true;
  let last = 0;

  function frame(ts) {
    if (!running) return;
    const dt = last ? Math.min(50, ts - last) / 1000 : 0.016;
    last = ts;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    for (const p of particles) {
      p.z += p.vz * dt;
      if (p.z < 60) spawn(p);
      const s = FOCAL / p.z;
      const x = cx + p.x * s;
      const y = cy + p.y * s;
      if (x < -40 || x > W + 40 || y < -40 || y > H + 40) { spawn(p); continue; }
      const r = Math.max(0.4, p.size * s);
      const alpha = Math.min(0.55, 0.5 * (1 - p.z / 1100) + 0.08);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 85%, 72%, ${alpha})`;
      ctx.fill();
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      running = false;
    } else if (!reduced) {
      running = true;
      last = 0;
      requestAnimationFrame(frame);
    }
  });

  resize();
  if (!reduced) requestAnimationFrame(frame);
})();

/* ---------- 卡片 3D 倾斜 ---------- */
(function fxTilt() {
  if (!window.matchMedia('(pointer: fine)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const SELECTOR = '.line-card, .home-card, .work-item, .modal, .invite-bar';
  const MAX = 5; // 最大倾斜角

  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest(SELECTOR);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(800px) rotateX(${-py * MAX}deg) rotateY(${px * MAX}deg) translateZ(0)`;
  }, { passive: true });

  document.addEventListener('pointerout', (e) => {
    const el = e.target.closest(SELECTOR);
    if (el && !el.contains(e.relatedTarget)) el.style.transform = '';
  });
  document.addEventListener('pointerleave', () => {}, { passive: true });
})();
