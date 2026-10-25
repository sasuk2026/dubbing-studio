'use strict';

/**
 * 浏览器端到端测试（Playwright + Chromium 虚拟麦克风）
 * 验证：注册/登录、建房/示例台词、双人在线/邀请条、选中台词出现配音按钮、
 *       录音保存/实时同步、聊天、导出 WAV+ZIP、WebRTC 语音
 * 运行：NODE_PATH=$(npm root -g) node test/e2e.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const PORT = 3977;
const BASE = `http://127.0.0.1:${PORT}`;
const DL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dub-dl-'));

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

// 在页面中完成注册（自动登录）
async function register(page, username, password) {
  await page.click('.auth-tab[data-auth="register"]');
  await page.fill('#auth-username', username);
  await page.fill('#auth-password', password);
  await page.click('#btn-auth-submit');
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dub-e2e-'));
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));
  await sleep(1200);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });

  const ctxA = await browser.newContext({ acceptDownloads: true });
  const ctxB = await browser.newContext({ acceptDownloads: true });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const errorsA = [];
  pageA.on('pageerror', (e) => errorsA.push(String(e)));
  pageA.on('console', (m) => {
    if (m.type() === 'error') errorsA.push(m.text());
  });

  try {
    console.log('\n[A] 注册账号');
    await pageA.goto(BASE, { waitUntil: 'networkidle' });
    check('未登录时展示登录/注册面板', await pageA.locator('#auth-panel').isVisible());
    check('大厅被隐藏', !(await pageA.locator('#lobby-panel').isVisible()));
    await register(pageA, '小明', 'pass1234');
    await pageA.waitForSelector('#lobby-panel:not([hidden])', { timeout: 10000 });
    check('注册后自动登录进入大厅', await pageA.locator('#lobby-panel').isVisible());
    check('大厅显示账号名', (await pageA.textContent('#account-name')).includes('小明'));

    console.log('\n[B] 创建配音室');
    await pageA.click('.script-setup summary');
    await pageA.click('[data-sample]');
    const scriptVal = await pageA.inputValue('#script-input');
    check('载入示例台词', scriptVal.includes('图书馆'));
    await pageA.click('#btn-create');
    await pageA.waitForSelector('#room-view:not([hidden])', { timeout: 10000 });
    const roomId = (await pageA.textContent('#room-id')).trim();
    check('进入配音室，房间号 6 位', /^[A-Z0-9]{6}$/.test(roomId), roomId);
    check('房间头部显示登录账号', (await pageA.textContent('#header-account-name')).includes('小明'));

    await pageA.waitForSelector('.line-card', { timeout: 10000 });
    const lineCount = await pageA.locator('.line-card').count();
    check('台词本渲染 7 条', lineCount === 7, `实际 ${lineCount}`);

    console.log('\n[C] 第二位用户注册加入 + 邀请条');
    await pageB.goto(`${BASE}/r/${roomId}`, { waitUntil: 'networkidle' });
    check('B 打开邀请链接需先登录', await pageB.locator('#auth-panel').isVisible());
    check('B 的房间号已预填', (await pageB.inputValue('#join-id')) === roomId);
    await register(pageB, '小红', 'pass1234');
    await pageB.waitForSelector('#room-view:not([hidden])', { timeout: 10000 });
    await sleep(1500);
    check('A 看到邀请条（多人在线）', await pageA.locator('#invite-bar').isVisible());
    const avatarsA = await pageA.locator('#user-avatars .avatar').count();
    check('A 看到 2 个用户头像', avatarsA === 2, `实际 ${avatarsA}`);

    console.log('\n[D] 选中台词出现配音按钮');
    await pageB.locator('.line-card').first().click();
    await pageB.waitForSelector('#dub-target:not([hidden])', { timeout: 5000 });
    check('选中台词后出现配音按钮', await pageB.locator('#btn-dub').isVisible());
    check(
      '配音按钮显示目标台词',
      (await pageB.textContent('#dub-target-label')).includes('第 1 条'),
      await pageB.textContent('#dub-target-label')
    );

    console.log('\n[E] B 点击配音按钮录音并保存');
    await pageB.click('#btn-dub');
    await pageB.waitForSelector('#recorder-modal:not([hidden])', { timeout: 10000 });
    await sleep(1800);
    await pageB.click('#btn-rec-stop');
    await pageB.waitForSelector('#btn-rec-save:not([hidden])', { timeout: 10000 });
    await pageB.click('#btn-rec-save');
    await pageB.waitForSelector('#recorder-modal[hidden]', { state: 'attached', timeout: 20000 });
    await sleep(1000);
    const badgeB1 = await pageB.locator('.line-card').first().locator('.badge').textContent();
    check('B 的台词显示已录制', badgeB1.includes('已录制'), badgeB1);
    const badgeA1 = await pageA.locator('.line-card').first().locator('.badge').textContent();
    check('A 实时看到小红已录制', badgeA1.includes('小红'), badgeA1);

    console.log('\n[F] A 录制第二句（不同用户协作）');
    await pageA.locator('.line-card').nth(1).click();
    await pageA.waitForSelector('#dub-target:not([hidden])', { timeout: 5000 });
    await pageA.click('#btn-dub');
    await pageA.waitForSelector('#recorder-modal:not([hidden])', { timeout: 10000 });
    await sleep(1600);
    await pageA.click('#btn-rec-stop');
    await pageA.waitForSelector('#btn-rec-save:not([hidden])', { timeout: 10000 });
    await pageA.click('#btn-rec-save');
    await pageA.waitForSelector('#recorder-modal[hidden]', { state: 'attached', timeout: 20000 });
    await sleep(800);
    const doneCount = (await pageA.textContent('#done-count')).trim();
    check('已录制计数 = 2', doneCount === '2', doneCount);

    console.log('\n[G] 播放与文字聊天');
    await pageA.locator('.line-card').first().locator('[data-action="play"]').click();
    await sleep(1200);
    check('播放录音无报错', errorsA.filter((e) => /play|播放/i.test(e)).length === 0);
    await pageA.fill('#chat-input', '我录完第一句啦');
    await pageA.click('#chat-form button[type="submit"]');
    await sleep(1000);
    const chatB = await pageB.locator('#chat-list').textContent();
    check('B 收到小明的聊天', chatB.includes('我录完第一句啦'));

    console.log('\n[H] 导出');
    const [dl1] = await Promise.all([
      pageA.waitForEvent('download', { timeout: 40000 }),
      pageA.click('#btn-export-all'),
    ]);
    const wavPath = path.join(DL_DIR, dl1.suggestedFilename());
    await dl1.saveAs(wavPath);
    const wavBuf = fs.readFileSync(wavPath);
    check(
      '合成导出 WAV 下载成功',
      wavBuf.length > 1000 && wavBuf.toString('ascii', 0, 4) === 'RIFF' && wavBuf.toString('ascii', 8, 12) === 'WAVE',
      `${wavBuf.length} bytes`
    );

    const [dl2] = await Promise.all([
      pageA.waitForEvent('download', { timeout: 40000 }),
      pageA.click('#btn-export-parts'),
    ]);
    const zipPath = path.join(DL_DIR, dl2.suggestedFilename());
    await dl2.saveAs(zipPath);
    const zipBuf = fs.readFileSync(zipPath);
    check(
      '分段导出 ZIP 下载成功',
      zipBuf.length > 100 && zipBuf[0] === 0x50 && zipBuf[1] === 0x4b,
      `${zipBuf.length} bytes`
    );

    console.log('\n[I] 语音聊天（WebRTC）');
    await pageA.click('.tab[data-tab="voice"]');
    await pageB.click('.tab[data-tab="voice"]');
    await pageA.click('#btn-voice-join');
    await pageB.click('#btn-voice-join');
    await sleep(8000);
    const voiceUsersA = await pageA.locator('.voice-user').count();
    check('双方加入语音室', voiceUsersA === 2, `A 看到 ${voiceUsersA} 人`);
    const p2p = await pageA.evaluate(() => {
      const out = [];
      for (const [, entry] of state.voice.pcs) out.push(entry.pc.connectionState);
      return out;
    });
    check('WebRTC P2P 连接已建立', p2p.length >= 1 && p2p.some((s) => s === 'connected'), JSON.stringify(p2p));

    console.log('\n[J] 退出登录');
    await pageA.click('#btn-leave');
    await pageA.waitForSelector('#lobby-panel:not([hidden])', { timeout: 8000 });
    check('退出房间回到大厅', await pageA.locator('#lobby-panel').isVisible());
    await pageA.click('#btn-logout');
    await pageA.waitForSelector('#auth-panel:not([hidden])', { timeout: 8000 });
    check('退出登录回到登录面板', await pageA.locator('#auth-panel').isVisible());
    await pageA.goto(`${BASE}/r/${roomId}`, { waitUntil: 'networkidle' });
    check('退出后访问房间需重新登录', await pageA.locator('#auth-panel').isVisible());

    console.log('\n[K] 控制台错误');
    check('无 JS 报错', errorsA.length === 0, errorsA.slice(0, 3).join(' | '));

    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('E2E 异常:', e);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
    process.exit(process.exitCode || 0);
  }
}

main();
