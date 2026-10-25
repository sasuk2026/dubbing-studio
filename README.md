# 🎬 配音工坊 · Dubbing Studio

多人在线协作配音网站：每个独立的配音房间展示台词本，在台词本**选中要配的台词**后底部出现**配音按钮**，点击即可逐段录音（支持**无损 WAV 直录**），**合成导出 MP3**（可设**整体语速**、**每段间隔**、码率）或**分段导出 ZIP**；合成结果与单条录音可存入**个人作品库**随时试听下载；多人同时在线时显示**邀请条**，房间内支持**语音聊天**和**文字聊天**。

## ✨ 功能

| 模块 | 说明 |
| --- | --- |
| 账号系统 | 注册 / 登录（scrypt 加盐哈希、令牌会话 30 天、HttpOnly Cookie 双通道认证），进站需登录 |
| 配音室 | 房间号创建/加入，粘贴台词本（支持「角色：台词」格式），台词可增删改 |
| 选中配音 | 在台词本点击选中某句 → 底部出现配音按钮（显示「第 N 条 · 角色：台词」）→ 点击录音，配完即保存为该句的一段录音 |
| 分段录音 | MediaRecorder 逐条录制，带计时器与实时电平表，可试听、重录、覆盖；可选**无损模式**（ScriptProcessor 捕获 PCM → 16-bit WAV） |
| 合成设置 | 整体语速 0.5x–2x、每段间隔 0–3 秒、导出格式（MP3 128/192/320kbps 或 WAV 无损），设置保存在本机 |
| 合成导出 | 按台词顺序解码拼接所有录音，导出**一段 MP3**（lamejs 编码）或 WAV |
| 分段导出 | 所有录音打包为 ZIP，文件名含序号/角色/台词 |
| 个人作品库 | 合成结果 / 单条录音存入云端作品库，按账号隔离，支持在线试听、下载到本地、删除 |
| 连播试听 | 按顺序播放全部已录台词，当前句高亮 |
| 在线状态 | 头像列表实时显示在线用户，语音中的用户带绿圈 |
| 邀请条 | ≥2 人在线时自动弹出，一键复制邀请链接 |
| 语音聊天 | WebRTC Mesh 点对点语音，支持静音、说话指示 |
| 文字聊天 | 实时聊天，含加入/离开系统通知 |
| 视觉特效 | 3D 透视粒子背景、玻璃拟态面板、卡片 3D 倾斜、立体声浪录音可视化（尊重 prefers-reduced-motion） |
| 持久化 | 账号、房间、台词、录音、作品落盘，服务重启不丢失；重新部署会清空（Render 免费版无持久磁盘） |

## 🚀 本地运行

```bash
npm install
npm start                # http://localhost:3000
npm test                 # 冒烟测试（账号体系 + 作品库 + 双客户端全流程，33 项）
NODE_PATH=$(npm root -g) node test/e2e.js   # 浏览器端到端测试（37 项，需 Playwright）
```

> 录音与语音聊天需要 HTTPS 或 localhost 环境（浏览器 getUserMedia 限制）。

## 🐳 Docker 运行

```bash
docker build -t dubbing-studio .
docker run -p 3000:3000 dubbing-studio
```

## ☁️ 部署到 Render

仓库自带 `render.yaml`，在 Render 面板选择 **New + → Blueprint** 关联本仓库即可一键部署（免费套餐）。服务通过 `PORT` 环境变量监听端口，健康检查路径 `/healthz`。

> ⚠️ **数据持久化提示**：Render 免费版没有持久磁盘，数据仅存于内存/临时盘，**每次重新部署（含自动部署触发的新版本）都会清空**账号、房间与录音。部署完成后请重新注册账号并创建房间；如需长期保存数据，请在 Render 服务上添加付费 Disk 挂载。

技术栈：Node.js + Express + Socket.io + WebRTC（STUN），前端为无构建原生 JS。

## 📁 结构

```
server.js            # 服务端：账号/房间/台词/录音/作品库/聊天/信令
public/index.html    # 页面
public/css/style.css # 样式（暗色主题 + 玻璃拟态）
public/js/app.js     # 主逻辑
public/js/audio.js   # 录音、无损 PCM 捕获、WAV/MP3 合成、ZIP 打包
public/js/voice.js   # WebRTC 语音聊天
public/js/fx.js      # 3D 粒子背景与卡片倾斜特效
public/js/vendor/    # lamejs（MP3 编码器，本地内置）
test/smoke.js        # 冒烟测试
```
