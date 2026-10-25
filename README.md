# 🎬 配音工坊 · Dubbing Studio

多人在线协作配音网站：每个独立的配音房间展示台词本，用户**锁定**自己要配的台词后逐段录音，支持**一键合成导出**或**分段导出**；多人同时在线时显示**邀请条**，房间内支持**语音聊天**和**文字聊天**。

## ✨ 功能

| 模块 | 说明 |
| --- | --- |
| 账号系统 | 注册 / 登录（scrypt 加盐哈希、令牌会话 30 天、HttpOnly Cookie 双通道认证），进站需登录 |
| 配音室 | 房间号创建/加入，粘贴台词本（支持「角色：台词」格式），台词可增删改 |
| 台词锁定 | 点击录制即锁定该台词，其他人无法同时录制；锁定 10 分钟无操作可被接管；断线自动释放 |
| 分段录音 | MediaRecorder 逐条录制，带计时器与实时电平表，可试听、重录、覆盖 |
| 合成导出 | 按台词顺序解码拼接所有录音（句间 300ms 停顿），导出单个 WAV |
| 分段导出 | 所有录音打包为 ZIP，文件名含序号/角色/台词 |
| 连播试听 | 按顺序播放全部已录台词，当前句高亮 |
| 在线状态 | 头像列表实时显示在线用户，语音中的用户带绿圈 |
| 邀请条 | ≥2 人在线时自动弹出，一键复制邀请链接 |
| 语音聊天 | WebRTC Mesh 点对点语音，支持静音、说话指示 |
| 文字聊天 | 实时聊天，含加入/离开系统通知 |
| 持久化 | 账号、房间、台词、录音、聊天记录落盘，服务重启不丢失 |

## 🚀 本地运行

```bash
npm install
npm start                # http://localhost:3000
npm test                 # 冒烟测试（账号体系 + 双客户端全流程，28 项）
NODE_PATH=$(npm root -g) node test/e2e.js   # 浏览器端到端测试（27 项，需 Playwright）
```

> 录音与语音聊天需要 HTTPS 或 localhost 环境（浏览器 getUserMedia 限制）。

## 🐳 Docker 运行

```bash
docker build -t dubbing-studio .
docker run -p 3000:3000 dubbing-studio
```

## ☁️ 部署到 Render

仓库自带 `render.yaml`，在 Render 面板选择 **New + → Blueprint** 关联本仓库即可一键部署（免费套餐）。服务通过 `PORT` 环境变量监听端口，健康检查路径 `/healthz`。

技术栈：Node.js + Express + Socket.io + WebRTC（STUN），前端为无构建原生 JS。

## 📁 结构

```
server.js            # 服务端：房间/台词/锁定/录音/聊天/信令
public/index.html    # 页面
public/css/style.css # 样式（暗色主题）
public/js/app.js     # 主逻辑
public/js/audio.js   # 录音、WAV 合成、ZIP 打包
public/js/voice.js   # WebRTC 语音聊天
test/smoke.js        # 冒烟测试
```
