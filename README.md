# 双人桌上足球 · 独立部署版

一个 Node.js 进程同时提供网页和联机中转。**不需要 `npm install`，不依赖任何第三方库**，装了 Node.js 18 或更新版本就能跑。

```
foosball-online/
├── server.js        网页服务 + 联机中转（/ws）
├── miniws.js        自带的 WebSocket 实现（不依赖 ws 等第三方库）
├── public/
│   └── index.html   游戏本体（物理、画面、操作全在这一个文件里）
├── package.json
├── Dockerfile
└── README.md
```

## 它是怎么工作的

- **游戏的裁判是房主的浏览器**：球的物理、进球、比分都在开房间那个人的浏览器里算。
- **服务器只做中转**：每个人把自己的状态发给服务器，服务器转给同一个房间里的人。不在同一房间的人只收到"谁开了房间"这种大厅信息。
- 服务器不存任何数据，重启后大家会自动重连。房主和对手都会保持原来的身份，比赛接着打。

所以服务器很轻：一台最便宜的云服务器就能撑几十桌同时玩。真正影响手感的是**服务器离你们两个人有多远**：延迟 = 你到服务器 + 服务器到朋友。

---

## 一、先在自己电脑上试

```bash
cd foosball-online
node server.js
```

浏览器打开 <http://localhost:3000>。再开一个浏览器窗口（或者换个浏览器）打开同一个地址，一边开房间、一边加入，就能自己和自己对打。

**和同一个 Wi-Fi 下的朋友玩**：查一下你电脑的局域网 IP（Windows 用 `ipconfig`，macOS 和 Linux 用 `ifconfig` 或 `ip addr`），让朋友打开 `http://你的IP:3000`。如果打不开，多半是电脑防火墙挡了 3000 端口。

## 二、部署到网上（和不在身边的朋友玩）

### 方式 A：云服务器（最稳，推荐）

适合阿里云、腾讯云、华为云的轻量应用服务器，或者任何一台 Linux VPS。

1. 在服务器上装 Node.js（18 或更新），把整个 `foosball-online` 文件夹传上去。
2. 先直接跑起来试试：

   ```bash
   cd foosball-online
   PORT=3000 node server.js
   ```

   在云服务器控制台的**安全组 / 防火墙**里放行 3000 端口，然后浏览器打开 `http://服务器公网IP:3000`。能玩就说明没问题了。

3. 让它在后台一直运行、开机自启，用 systemd。新建 `/etc/systemd/system/foosball.service`：

   ```ini
   [Unit]
   Description=Foosball
   After=network.target

   [Service]
   WorkingDirectory=/opt/foosball-online
   ExecStart=/usr/bin/node server.js
   Environment=PORT=3000
   Restart=always
   User=www-data

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now foosball
   ```

   （把 `WorkingDirectory` 改成你放文件夹的实际路径，`which node` 可以查到 node 的路径。）

4. **可选：用域名 + HTTPS**。用 Nginx 反向代理，再用 certbot 申请免费证书。关键是 `/ws` 这一段要转发 WebSocket 升级请求：

   ```nginx
   server {
       server_name 你的域名;
       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_read_timeout 3600s;
       }
       listen 80;
   }
   ```

   ```bash
   sudo certbot --nginx -d 你的域名
   ```

   网页会自动判断：用 `https://` 打开时走 `wss://`，用 `http://` 打开时走 `ws://`，不用改代码。

### 方式 B：托管平台（不用管服务器）

Render、Railway、Fly.io 这类平台都能直接跑 Node.js 服务，自带 HTTPS 域名：

- 把这个文件夹推到一个 GitHub 仓库，在平台上新建 Web Service 并连上仓库。
- 启动命令填 `node server.js`。不需要构建命令。
- 端口不用设：平台会通过 `PORT` 环境变量告诉程序，`server.js` 会自动读取。
- 如果平台支持 Docker，也可以直接用仓库里的 `Dockerfile`。

注意两点：
- 有的平台免费档在一段时间没人访问后会休眠，第一次打开要等几十秒才能醒。
- 这些平台的机房大多在海外，从中国大陆访问延迟会比较高，有时还不稳定。

### 方式 C：Docker

```bash
docker build -t foosball .
docker run -d --restart=always -p 3000:3000 --name foosball foosball
```

---

## 在中国大陆部署要注意

- **备案**：用国内云服务器、并通过**域名**访问 80/443 端口时，域名需要 ICP 备案。没备案之前，可以先用 `http://公网IP:3000` 直接访问，自己和朋友玩足够了。
- **机房选在你们俩中间**：比如一个在北京、一个在上海，选华北或华东的机房都行。别选海外的。
- **字体**：页面用了 Google Fonts，国内一般加载不了。页面已经改成异步加载，加载不了会自动用系统字体，不影响游戏。想要原版字体效果，可以把字体文件下载下来放进 `public/`，或者换成国内的镜像地址。

## 可以调整的设置（环境变量）

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；只想本机访问就设成 `127.0.0.1`（配合 Nginx 时推荐） |
| `MAX_CLIENTS` | `500` | 最多同时在线人数 |

`/healthz` 会返回当前在线人数，可以用来做健康检查。

## 联机协议（想改代码时看）

浏览器和服务器之间都是 JSON 文本消息，路径为 `/ws`。

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| 浏览器 → 服务器 | `{"t":"hi","id":"16位十六进制"}` | 连上后的第一条。id 在每个标签页里随机生成，断线重连时沿用 |
| 浏览器 → 服务器 | `{"t":"p","p":{...}}` | 发布自己的完整状态（昵称、房间码、身份、比赛状态或操作），最大 4 KB，每秒最多 60 条 |
| 服务器 → 浏览器 | `{"t":"hello","id":...}` | 握手完成 |
| 服务器 → 浏览器 | `{"t":"sync","peers":[{"id","p"}]}` | 当前所有人的状态（连上时、换房间时发） |
| 服务器 → 浏览器 | `{"t":"p","id","p"}` | 某人的状态更新：同房间的人收到完整状态，其他人只收到大厅信息 |
| 服务器 → 浏览器 | `{"t":"leave","id"}` | 某人离开 |
| 服务器 → 浏览器 | `{"t":"b"}` | 每 10 秒一次的心跳 |

游戏里状态字段的含义（房主发的比赛状态、对手发的操作）见 `public/index.html` 里 `hostPublish` 和 `guestTick` 两个函数。
