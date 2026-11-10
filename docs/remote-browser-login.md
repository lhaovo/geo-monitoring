# 远端 Linux 浏览器登录改造方案

## 0. 文档状态

本文写于「每平台一个 Profile」的单账号时代，项目后来改成了「平台 + 账号」的多登录态模型，登录会话管理器与登录态判定也已经落地。阅读时以本文第 0 节这张表为准：

| 本文后续描述 | 当前实现 |
| --- | --- |
| `data/profiles/<platform>` | `data/profiles/<platform>/<profileId>/chrome`，每个账号一个独立目录 |
| 平台级锁 `acquire(platformId, ...)` | 锁粒度必须改成账号级；当前**尚未实现**，见第 5.3 节 |
| `/api/platforms/:platformId/login-session` | 已实现为 `/api/login-sessions`，见第 5.1 节 |
| 会话管理器尚未实现 | 已实现为 `src/login/login-manager.js`，见第 5.2 节 |
| `inspectLoginState` 待实现 | 已实现于 `src/platforms/base.js` 与各平台适配器，见第 5.4 节 |
| 远端登录 API 与 noVNC 前端入口 | **仍未实现**，是本文的主线 |

本文仍然有效的是：图形基座、远程桌面层、鉴权与运维三部分。

## 1. 背景与目标

后端未来部署在已安装 Chrome 的 Linux 服务器上。Playwright 的有头模式会在服务器的图形会话中打开浏览器，本地电脑无法直接操作，因此需要把这段图形会话安全地嵌入或链接到管理前端。

目标是：

- 在「平台与登录」页面为某个平台的某个账号发起远端登录。
- 后端在服务器上使用该账号现有的持久化 Profile 启动有头 Chrome。
- 管理员通过浏览器中的 noVNC 页面完成扫码、验证码或账号登录。
- 登录结束后关闭有头 Chrome，后续无头监控继续复用相同 Profile。
- 登录会话与监控任务共享**账号级**锁，彻底避免同一 Profile 被两个 Chrome 进程同时占用。
- noVNC、VNC 和平台 Profile 不直接暴露给公网或普通用户。

多登录态带来的现实约束：登录窗口开的是**某一个账号**的 Profile，而采集任务会按「最久未使用优先」在同平台的多个账号之间轮转。因此锁的粒度必须是账号级——用平台级锁会把同平台所有账号串行化，正好抵消多账号的并行收益。

## 2. 推荐架构

```text
管理员浏览器
  ├─ HTTPS / 管理前端与登录会话 API
  └─ WSS /novnc/websockify
             │
        Nginx / Caddy
             │（仅回环地址）
        noVNC + websockify :6080
             │
          x11vnc :5900
             │
       Xvfb 虚拟显示器 :99
             │
  Playwright headed Chrome
             │
  data/profiles/<platform>/<profileId>/chrome
```

各组件职责：

- **Xvfb**：在没有物理显示器的 Linux 服务器上提供虚拟 X11 屏幕。
- **轻量窗口管理器**：建议使用 Fluxbox，保证弹窗、窗口焦点和尺寸行为稳定。
- **x11vnc**：把 Xvfb 的 `:99` 屏幕转换为 VNC 流，只监听 `127.0.0.1`。
- **noVNC / websockify**：把 VNC 转成浏览器可访问的 WebSocket 和 HTML 客户端。
- **反向代理**：统一提供 HTTPS、WebSocket 转发、身份认证和访问控制。
- **登录会话管理器**：启动/关闭有头 Playwright，管理超时、状态和账号锁。

### 2.1 远程桌面层与 Chrome 自动化层的边界

这是整个方案最需要守住的边界：**底层虚拟桌面和 Chrome 自动化基本相同，两者的差异只在于「画面怎么送到浏览器」**。因此建议把远程桌面单独抽成一层：

```text
src/login/remote-desktop/
├── remote-desktop-server.js   ← 接口：start(display) / stop(display) / url()
├── novnc-stack.js             ← Xvfb + x11vnc + websockify + noVNC
└── kasmvnc-stack.js           ← Xvfb + kasmvnc

以上（不随选型变化）
├── src/login/login-manager.js  ← Chrome 启动、Profile 绑定、登录态判定
├── 账号级锁                    ← 登录窗口与采集任务互斥
└── src/infrastructure/platform-runner.js  ← 监控执行
```

Chrome 永远由我们自己的 `launchPersistentContext` 启动，远程桌面层只负责「把某个 DISPLAY 的画面送出去」。因此从 noVNC 栈切换到 KasmVNC 时，上面一半的代码一行都不用动。

### 2.2 多会话演进

第一版使用一块共享虚拟屏幕，并限制系统同一时间只存在一个人工登录会话。实现简单，也避免管理员在 noVNC 中看到其他人的登录窗口。

但账号变多之后，登录会从偶发变成高频操作（登录态过期、被平台限制都需要重新登录），共享屏幕会成为瓶颈。届时需要为每个会话动态分配独立的 `DISPLAY`、VNC 端口和访问令牌。两种远程桌面实现都支持这一点，差别只在编排方式：noVNC 栈要自己拉起 Xvfb/x11vnc/websockify 三个进程并负责清理，KasmVNC 用 `vncserver -list` / `vncserver -kill :N` 或 systemd 模板 `kasmvncserver@:N` 就能完成。

## 3. 远程桌面层选型：noVNC 栈 与 KasmVNC

两者都能自托管、共用同一套 Xvfb + Chrome 自动化，差异集中在「远程桌面的画面传输和交互层」。

| 对比项 | A：noVNC 栈 | B：KasmVNC |
| --- | --- | --- |
| 虚拟显示 | Xvfb | Xvfb |
| 窗口管理 | Fluxbox | Fluxbox |
| VNC 服务 | x11vnc | 内置 |
| WebSocket 转换 | websockify | 内置 |
| 浏览器客户端 | noVNC | KasmVNC Web Client |
| 常驻组件数 | 5（Xvfb、Fluxbox、x11vnc、websockify、noVNC） | 3（Xvfb、Fluxbox、kasmvnc） |
| 认证 | 服务器级共享 VNC 密码，短时令牌需自己接 websockify token plugin | 内建用户体系，天然按用户隔离 |
| 剪贴板同步 | 需额外配置 | 内建 |
| 会话编排 | 自己实现 | 内建多用户多桌面 |
| 分发方式 | 全是 Debian 官方包 | 官方 .deb / .rpm 包，第三方 Docker 镜像 |

### 3.1 建议：第一版用 A，把边界留好

- **画面传输的差异在本场景没有价值**。登录窗口里只有一张静态二维码、一次滑块拖动和少量键盘输入，传统 VNC 编码已经够用；KasmVNC 的编码与传输优化针对的是高分辨率高动态画面（视频、3D），不是登录表单。
- **A 与现有部署模型更契合**。五个 Debian 官方包 `apt install` 即可，与当前单进程 `npm start` 的部署方式一致，文档第 4 节的写法可以照搬。
- **切换成本可控**。只要按第 2.1 节把远程桌面层抽出来，将来换成 B 只是替换该目录下的一个实现文件。

### 3.2 什么情况下应该改选 B

- 需要**多个管理员同时**连入，各自操作不同的登录窗口。
- 需要剪贴板双向同步（管理员在自己电脑上复制内容，直接粘进远端 Chrome）。
- 需要会话录制或审计。

选 B 时注意分发方式：**优先用官方 `.deb` 与 systemd 模板**，不要依赖第三方容器镜像（社区镜像的构建节奏往往落后上游）。同时要按 KasmVNC 的会话模型重新组织登录会话管理，避免出现两套并行的会话状态。

### 3.3 一个容易被忽略的交互风险：队头阻塞

x11vnc 把「画面更新」和「鼠标键盘事件」放在同一条 TCP 连接上。当一个较大的画面帧正在传输时，后面的鼠标移动事件会被排队，导致**拖动轨迹被量化成阶梯状**。平台的滑块风控（阿里 x5sec、极验）会分析鼠标轨迹的平滑度，阶梯状轨迹可能被判定为机器人。

这个问题不是「带宽不够」造成的，而是「带宽占用」造成「输入事件延迟」。因此降低带宽在这里不是省流量，而是提高验证码通过率：

- 限制帧率（KasmVNC `encoding.max_frame_rate`，x11vnc `-defer`）。登录页 5–10 fps 完全够用，可以直接砍掉三分之二带宽，同时缩小队头阻塞窗口。
- 降低单帧体积（KasmVNC `encoding.rect_encoding_mode`，x11vnc `-quality`）。
- **不要为了省流量关掉二维码的清晰度**：二维码是高对比度几何图案，JPEG 压缩产生的马赛克会直接影响手机扫码成功率。x11vnc 建议用 `-nojpeg`。
- KasmVNC 的 `network.udp`（WebRTC UDP 通道）可以让输入事件绕开 TCP 队列，这是 B 在本项目里最实质的一个优势。

## 4. Linux 图形环境

以下以 Ubuntu/Debian 为例。Chrome 已安装时，只需补充虚拟显示和 VNC 组件：

```bash
sudo apt update
sudo apt install -y xvfb x11vnc novnc websockify fluxbox
```

建议用独立低权限用户运行整个采集服务，例如 `geo-monitoring`，并让 Profile 目录仅该用户可读写。VNC 密码保存在服务器文件中，不放入仓库、环境变量日志或 noVNC URL：

```bash
sudo install -d -m 0750 -o geo-monitoring -g geo-monitoring /opt/geo-monitoring/data
sudo install -d -m 0750 -o geo-monitoring -g geo-monitoring /etc/geo-monitoring
sudo -u geo-monitoring x11vnc -storepasswd /etc/geo-monitoring/x11vnc.pass
sudo chmod 0600 /etc/geo-monitoring/x11vnc.pass
```

核心进程的等价启动方式如下；生产环境应改为 systemd 服务，不应依赖手工终端常驻：

```bash
Xvfb :99 -screen 0 1440x960x24 -nolisten tcp
DISPLAY=:99 fluxbox
x11vnc -display :99 -localhost -forever -shared \
  -rfbport 5900 -rfbauth /etc/geo-monitoring/x11vnc.pass
websockify --web=/usr/share/novnc/ \
  127.0.0.1:6080 127.0.0.1:5900
```

服务启动顺序为 Xvfb → Fluxbox → x11vnc → noVNC/websockify → GEO 后端。后端进程需要继承：

```bash
DISPLAY=:99
GEO_BROWSER_PATH=/usr/bin/google-chrome
```

部署时还应增加以下检查：

- `xdpyinfo -display :99` 能正常返回屏幕信息。
- `curl http://127.0.0.1:6080/vnc.html` 能返回 noVNC 页面。
- Chrome 由采集服务用户启动，且该用户拥有 `data/profiles/`。
- 服务器重启后各 systemd 单元能按依赖顺序自动恢复。

### 4.1 Playwright 侧的必要改造

这一部分与选 A 还是 B 无关，但会先卡住部署，必须在上服务器之前改完：

| # | 事项 | 位置 |
| --- | --- | --- |
| 1 | `browserCandidates()` 只列了 Windows 路径，Linux 上必须依赖 `GEO_BROWSER_PATH`；建议补上 `/usr/bin/google-chrome` 等候选 | `src/browser.js` |
| 2 | 容器内 Chrome 需要 `--no-sandbox`、`--disable-dev-shm-usage`；当前启动参数只有反自动化的 `--disable-blink-features=AutomationControlled` | `src/browser.js` 的 `browserLaunchOptions()` |
| 3 | `launchPersistentContext` 要显式注入 `DISPLAY`，不要依赖 Playwright 的默认值 | `src/login/login-manager.js`、`src/infrastructure/platform-runner.js` |
| 4 | 无 GPU 环境要关闭硬件加速 | 同上 |
| 5 | 反自动化参数在 Linux 上同样要保留：平台的风控指纹采集与操作系统无关 | `src/browser.js` 的 `ANTI_AUTOMATION_ARGS` |

### 4.2 带宽与延迟要求

按 1440×960×24bpp 计算，一帧原始画面约 4.15 MB；实际靠增量更新与 zlib 压缩，量级如下：

| 阶段 | 带宽 |
| --- | --- |
| 首帧全屏 | 300–500 KB |
| 页面静止 | 20–60 KB/s |
| 滑块拖动中 | 100–400 KB/s |
| 平台页首次加载 | 1–3 MB 突发 |
| 鼠标键盘事件回传 | < 10 KB/s |

一次登录会话（5 分钟）大约消耗 20 MB，流量成本可以忽略。**真正的约束是往返延迟（RTT），不是带宽**：

| RTT | 体验 |
| --- | --- |
| < 50 ms | 舒适 |
| 50–120 ms | 可接受 |
| 120–250 ms | 拖动开始发粘，轨迹采样不连续 |
| > 300 ms | 明显影响精确拖动 |

因此部署时应当优先保证**同城或同区域机房、RTT 小于 100 ms**，出口带宽 5–10 Mbps 已经足够。家用宽带的上行通常只有 30–50 Mbps 且上传打满会影响其它业务，VNC 建议限速。

顺带一提：远程桌面只承载登录窗口这一小段交互，监控执行的证据不走 VNC，而是从本地磁盘经 `/artifacts/` 以 HTTP 提供。实测单份证据 HTML 可达 1.1 MB 且当前未启用响应压缩，操作员逐条翻证据的流量反而远超 VNC。

## 5. 后端改造

### 5.1 登录会话 API

当前已实现的接口是：

```text
POST   /api/login-sessions                    创建登录窗口（按平台 + 账号）
GET    /api/login-sessions                    列出进行中的登录会话
GET    /api/login-sessions/:sessionId         查询单个会话
POST   /api/login-sessions/:sessionId/close   关闭登录窗口并复验登录结果
```

会话状态为 `starting` → `open` → `closed`，另有 `failed`。关闭时会依据登录窗口存活期间探测到的页面内容复验登录结果，并据此把 Profile 标记为 `ready`、`expired`、`restricted` 或 `error`（关闭时仍停在验证码界面）。

远端登录还需要在此基础上补充：向远程桌面层申请一块 DISPLAY、返回 `viewerUrl`、以及管理员主动「验证登录」的接口。

### 5.2 LoginManager

登录会话管理器已经实现于 `src/login/login-manager.js`，负责：

1. 校验平台 ID，按「平台 + 账号」解析或创建 Profile。
2. 使用 `data/profiles/<platform>/<profileId>/chrome` 启动 `launchPersistentContext`。
3. 设置 `headless: false`，打开平台入口页。
4. 在登录窗口存活期间持续探测页面状态（`inspectLoginState`）。
5. 窗口关闭后复验登录结果并写回 Profile 健康状态。
6. 同一账号重复发起登录时复用已打开的会话，避免 Chrome 因 Profile 锁启动失败。

远端化时需要补充：申请与释放 DISPLAY、超时清理、与账号级锁的协作、服务重启后清理内存会话状态并检查残留浏览器进程（不能使用宽泛的 `pkill chrome`）。

### 5.3 账号级锁统一

**这一节是当前已经存在的缺口，且不需要等上服务器就能修。**

现状是：监控调度保证同一平台最多同时运行一个问题，但登录命令和监控 Worker 之间没有统一锁。两者启动 Chrome 时用的是**同一个** `chrome` 用户数据目录，而 Chrome 对该目录是排他锁，于是会出现：

- 给一个**健康状态为 `ready`** 的账号打开登录窗口时，它的 Profile 不会被移出可选取集合（`pickAvailableProfile` 只挑 `ready`），采集任务仍会轮转到它。
- 两边同时 `launchPersistentContext` 同一个目录，后启动的那个直接失败。
- 该失败没有专属错误码，会被当成普通平台故障处理，**误判成平台风控**，排查方向被带偏。

需要新增进程内 `AccountLeaseManager`：

```text
acquire(platformId, profileId, ownerType, ownerId)
release(platformId, profileId, ownerId)
getLease(platformId, profileId)
```

锁规则：

- 登录会话持锁时，该账号不参与监控任务的账号选取，直接换下一个账号。
- 账号正在监控时，创建登录会话返回 HTTP `409`，前端显示当前任务信息。
- 登录窗口关闭且 BrowserContext 完全退出后才能释放锁。
- 同一平台的不同账号可以继续并发监控。
- 第一版后端是单进程，进程内锁足够；如果未来多实例部署，需要替换为 Redis 或数据库租约锁。

另外，Chrome 报错 `launchPersistentContext: Target page, context or browser has been closed`，并且同一 Profile 已被另一个窗口打开时，应归类为 `profile_locked`，不能误判为平台风控。

### 5.4 登录验证

每个平台适配器都已实现 `inspectLoginState(page)`：

```js
async inspectLoginState(page) {
  return {
    status: 'authenticated',
    reason: 'chat_input_visible',
  };
}
```

验证不能只看 URL，应组合判断：

- 是否存在可交互的聊天输入框。
- 是否出现「登录/扫码/验证码」等平台特有元素。
- 是否仍处于登录、passport 或 auth 页面。
- 页面是否触发安全验证或异常提示。

平台状态接口返回 `authenticated`、`unauthenticated`、`challenge`、`unknown` 以及 `checkedAt`。不要在普通状态轮询中频繁启动浏览器；优先使用最近一次登录验证结果，真正运行任务时再做最终校验。

## 6. 前端改造

「平台与登录」页面改为展示真实会话和最近验证状态：

- 登录状态、最后验证时间、默认模式和当前 Profile 是否被占用。
- 「远程登录」按钮：创建会话后打开内嵌抽屉或新窗口 noVNC。
- 「验证登录」按钮：调用验证接口，成功后自动关闭登录窗口。
- 「结束会话」按钮：关闭 BrowserContext 并释放账号锁。
- 倒计时、连接断开、登录超时、Profile 占用和平台验证码提示。

建议第一版在新标签页打开 noVNC，稳定后再嵌入前端抽屉。扫码登录时新标签页视野更大，也更容易处理浏览器弹窗。

注意：平台与登录页面**只展示**熔断与账号占用状态，不提供「立即恢复」「恢复无头」这类操作按钮——熔断的续跑与中止统一放在「监控任务」的任务详情里，避免出现半截状态。

## 7. 反向代理与安全

不能把 `5900`、`6080` 或 X11 端口直接开放到公网。x11vnc 和 websockify 都只监听回环地址，由 Nginx/Caddy 统一转发：

```nginx
location /novnc/ {
    proxy_pass http://127.0.0.1:6080/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

实际部署还必须增加：

- HTTPS 和管理员身份认证；API 与 noVNC 使用同一权限边界。
- noVNC 使用短时会话 token，不能只依赖一个长期共享 VNC 密码。x11vnc 只有服务器级密码，短时令牌需要借助 websockify 的 token plugin 实现；KasmVNC 则天然按用户隔离。
- 对登录会话的创建、验证和关闭记录审计日志。
- 限制来源 IP 或接入 VPN/零信任网络。
- 防止跨站请求伪造，并校验 WebSocket Origin。
- `data/profiles/` 权限设为 `0700`，数据库、截图和 Profile 纳入受控备份。
- 日志不记录 Cookie、密码、二维码内容和完整页面存储数据。

若当前还没有用户与权限系统，远端登录功能不应直接发布到公网。第一阶段可只通过 SSH 隧道或 VPN 访问：

```bash
ssh -L 3030:127.0.0.1:3030 user@server
```

## 8. 实施顺序

### 阶段 0：账号级锁与错误归类（不依赖上服务器）

- 实现 `AccountLeaseManager`，让登录会话与采集任务按账号互斥。
- 把 Profile 锁冲突归类为 `profile_locked`，不再误判成平台风控。
- 补自动化测试覆盖锁冲突、超时与异常清理。

### 阶段 A：服务器图形基座

- 安装并用 systemd 管理 Xvfb、Fluxbox、x11vnc 和 noVNC。
- 仅在回环地址验证 noVNC 能操作测试 Chrome。
- 完成第 4.1 节的 Playwright 侧改造。
- 确认后端服务用户拥有 Profile 目录。

### 阶段 B：远程桌面层与登录接入

- 按第 2.1 节抽出 `remote-desktop` 层，先实现 noVNC 栈。
- 登录会话接入 DISPLAY 申请与释放，补齐 `viewerUrl` 与验证登录接口。
- 为会话状态、锁冲突、超时和异常清理添加自动化测试。

### 阶段 C：前端

- 改造「平台与登录」页面，接入创建、验证、关闭和 noVNC 入口。
- 增加断线重连、倒计时和错误提示。

### 阶段 D：安全与运维

- 配置 HTTPS、管理员认证、短时 token、审计与访问限制。
- 增加进程健康检查、磁盘空间监控和 Profile 备份策略。
- 完成服务器重启、登录过期、任务并发和残留进程恢复演练。

## 9. 验收标准

- 管理员可从前端为任一平台的任一账号打开远端登录页面并完成人工登录。
- 关闭登录会话后，使用同一 Profile 的无头监控能成功提交问题并采集回答。
- 登录与监控并发操作不会再产生 Profile 锁冲突，且冲突会被正确归类为 `profile_locked`。
- 登录会话超时或浏览器异常退出后，资源和锁会自动释放。
- 拖动滑块时鼠标轨迹连续，没有因画面传输导致的明显阶梯化。
- VNC 端口不对公网开放，未认证用户无法访问 noVNC 或登录会话 API。
- Profile、SQLite、截图和会话数据仍位于 `data/`，不会进入 Git。
