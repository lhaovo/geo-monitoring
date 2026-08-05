# 远端 Linux 浏览器登录改造方案

## 1. 背景与目标

后端未来部署在已安装 Chrome 的 Linux 服务器上。Playwright 的有头模式会在服务器的图形会话中打开浏览器，本地电脑无法直接操作，因此需要把这段图形会话安全地嵌入或链接到管理前端。

目标是：

- 在“平台与登录”页面为某个平台发起远端登录。
- 后端在服务器上使用该平台现有的持久化 Profile 启动有头 Chrome。
- 管理员通过浏览器中的 noVNC 页面完成扫码、验证码或账号登录。
- 登录结束后关闭有头 Chrome，后续无头监控继续复用相同 Profile。
- 登录会话与监控任务共享平台锁，彻底避免同一 Profile 被两个 Chrome 进程同时占用。
- noVNC、VNC 和平台 Profile 不直接暴露给公网或普通用户。

这份文档描述待实现方案；当前项目尚未包含远端登录 API、会话管理器和 noVNC 前端入口。

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
  data/profiles/<platform>
```

各组件职责：

- **Xvfb**：在没有物理显示器的 Linux 服务器上提供虚拟 X11 屏幕。
- **轻量窗口管理器**：建议使用 Fluxbox，保证弹窗、窗口焦点和尺寸行为稳定。
- **x11vnc**：把 Xvfb 的 `:99` 屏幕转换为 VNC 流，只监听 `127.0.0.1`。
- **noVNC / websockify**：把 VNC 转成浏览器可访问的 WebSocket 和 HTML 客户端。
- **反向代理**：统一提供 HTTPS、WebSocket 转发、身份认证和访问控制。
- **登录会话管理器**：启动/关闭有头 Playwright，管理超时、状态和平台锁。

第一版使用一块共享虚拟屏幕，并限制系统同一时间只存在一个人工登录会话。实现简单，也避免管理员在 noVNC 中看到其他人的登录窗口。以后若需要多用户并行登录，再为每个会话动态分配独立的 `DISPLAY`、VNC 端口和 noVNC token。

## 3. Linux 图形环境

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

## 4. 后端改造

### 4.1 登录会话 API

建议增加以下接口：

```text
GET    /api/platforms/login-sessions
POST   /api/platforms/:platformId/login-session
GET    /api/platforms/:platformId/login-session
POST   /api/platforms/:platformId/login-session/verify
DELETE /api/platforms/:platformId/login-session
```

创建会话返回示例：

```json
{
  "id": "login_xxx",
  "platformId": "kimi",
  "status": "waiting_for_operator",
  "viewerUrl": "/novnc/vnc.html?autoconnect=1&resize=scale",
  "expiresAt": "2026-08-05T09:30:00.000Z"
}
```

建议的会话状态：

```text
starting → waiting_for_operator → verifying → ready → closed
                                 ↘ error / expired
```

`ready` 表示本次页面验证通过且 Profile 已安全落盘，不代表平台登录永远有效。平台登录状态仍需定期验证并记录最后验证时间。

### 4.2 LoginSessionManager

新增 `src/login/login-session-manager.js`，负责：

1. 校验平台 ID、管理员权限及当前系统是否已有人工登录会话。
2. 获取平台锁，确认该平台没有正在运行的监控浏览器。
3. 使用 `data/profiles/<platformId>` 启动 `launchPersistentContext`。
4. 设置 `headless: false`，继承 `DISPLAY=:99`，打开平台入口页。
5. 保存会话 ID、启动时间、当前状态、错误和过期时间。
6. 在管理员点击“验证登录”时检查聊天输入框、登录页特征和验证码状态。
7. 验证成功、管理员关闭或会话超时后关闭 BrowserContext，再释放平台锁。
8. 无论正常结束还是异常退出，都执行 `finally` 清理，避免僵尸 Chrome 和永久锁。

登录会话默认保留 20 分钟；管理员仍在操作时可以续期。服务重启后应清理内存中的旧会话状态，并检查/终止只属于本服务的残留浏览器进程，不能使用宽泛的 `pkill chrome`。

### 4.3 Profile 锁统一

当前监控调度已经保证同一平台最多同时运行一个问题，但登录命令和监控 Worker 之间还没有统一锁。需要新增进程内 `PlatformLeaseManager`：

```text
acquire(platformId, ownerType, ownerId)
release(platformId, ownerId)
getLease(platformId)
```

锁规则：

- 登录会话持锁时，该平台新的监控项等待，不直接启动 Chrome。
- 平台正在监控时，创建登录会话返回 HTTP `409`，前端显示当前任务信息。
- 登录窗口关闭且 BrowserContext 完全退出后才能释放锁。
- 不同平台可以继续并发监控。
- 第一版后端是单进程，进程内锁足够；如果未来多实例部署，需要替换为 Redis 或数据库租约锁。

Chrome 报错 `launchPersistentContext: Target page, context or browser has been closed`，并且同一 Profile 已被另一个窗口打开时，应归类为 `profile_locked`，不能误判为平台风控。

### 4.4 登录验证

每个平台适配器增加可选方法：

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
- 是否出现“登录/扫码/验证码”等平台特有元素。
- 是否仍处于登录、passport 或 auth 页面。
- 页面是否触发安全验证或异常提示。

平台状态接口返回 `authenticated`、`unauthenticated`、`challenge`、`unknown` 以及 `checkedAt`。不要在普通状态轮询中频繁启动浏览器；优先使用最近一次登录验证结果，真正运行任务时再做最终校验。

## 5. 前端改造

“平台与登录”页面改为展示真实会话和最近验证状态：

- 登录状态、最后验证时间、默认模式和当前 Profile 是否被占用。
- “远程登录”按钮：创建会话后打开内嵌抽屉或新窗口 noVNC。
- “验证登录”按钮：调用验证接口，成功后自动关闭登录窗口。
- “结束会话”按钮：关闭 BrowserContext 并释放平台锁。
- 倒计时、连接断开、登录超时、Profile 占用和平台验证码提示。

建议第一版在新标签页打开 noVNC，稳定后再嵌入前端抽屉。扫码登录时新标签页视野更大，也更容易处理浏览器弹窗。

## 6. 反向代理与安全

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
- noVNC 使用短时会话 token，不能只依赖一个长期共享 VNC 密码。
- 对登录会话的创建、验证和关闭记录审计日志。
- 限制来源 IP 或接入 VPN/零信任网络。
- 防止跨站请求伪造，并校验 WebSocket Origin。
- `data/profiles/` 权限设为 `0700`，数据库、截图和 Profile 纳入受控备份。
- 日志不记录 Cookie、密码、二维码内容和完整页面存储数据。

若当前还没有用户与权限系统，远端登录功能不应直接发布到公网。第一阶段可只通过 SSH 隧道或 VPN 访问：

```bash
ssh -L 3030:127.0.0.1:3030 user@server
```

## 7. 实施顺序

### 阶段 A：服务器图形基座

- 安装并用 systemd 管理 Xvfb、Fluxbox、x11vnc 和 noVNC。
- 仅在回环地址验证 noVNC 能操作测试 Chrome。
- 确认后端服务用户拥有 Profile 目录。

### 阶段 B：后端会话与锁

- 实现 `PlatformLeaseManager` 和 `LoginSessionManager`。
- 增加登录会话 API、超时清理和结构化错误码。
- 让 RunWorker 在获取平台锁后再启动 Playwright。
- 为会话状态、锁冲突、超时和异常清理添加自动化测试。

### 阶段 C：平台验证与前端

- 为五个平台实现登录状态检查。
- 改造“平台与登录”页面，接入创建、验证、关闭和 noVNC 入口。
- 增加断线重连、倒计时和错误提示。

### 阶段 D：安全与运维

- 配置 HTTPS、管理员认证、短时 token、审计与访问限制。
- 增加进程健康检查、磁盘空间监控和 Profile 备份策略。
- 完成服务器重启、登录过期、任务并发和残留进程恢复演练。

## 8. 验收标准

- 管理员可从前端为任一平台打开远端登录页面并完成人工登录。
- 关闭登录会话后，使用同一 Profile 的无头监控能成功提交问题并采集回答。
- 登录与监控并发操作不会再产生 Profile 锁冲突。
- 登录会话超时或浏览器异常退出后，资源和锁会自动释放。
- VNC 端口不对公网开放，未认证用户无法访问 noVNC 或登录会话 API。
- Profile、SQLite、截图和会话数据仍位于 `data/`，不会进入 Git。
