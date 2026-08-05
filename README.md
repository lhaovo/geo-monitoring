# GEO Monitoring

面向品牌可见度监测的 GEO 采集系统。项目通过 Playwright 操作国内 AI 平台的 Web 页面，保存回答、引用来源和页面证据，并按品牌统计出现率、来源引用率及平台表现。

## 当前能力

- 以品牌为监测主体，维护品牌名、别名、产品和自有域名。
- 为品牌批量添加监控问题。
- 支持 DeepSeek、豆包、Kimi、千问和腾讯元宝。
- 支持按平台选择有头或无头模式；豆包默认有头，其余平台默认无头。
- 可选附加搜索提示词，要求模型先搜索公开来源后回答。
- 全局并发数可设为 1–6，同一平台最多同时执行一个问题。
- 采集回答原文、回答链接、引用 URL、引用次数、截图、HTML 和来源 JSON。
- 使用 SQLite 保存品牌、问题、任务、回答、来源和事件。
- 提供品牌总览、监控任务、来源中心、趋势和报告页面。

## 技术栈

- Node.js 20+
- Fastify
- SQLite / better-sqlite3
- Playwright
- React 19 + Vite

## 快速开始

### 1. 安装依赖

```bash
npm install
```

采集器默认使用操作系统已安装的 Chrome 或 Edge。Windows 会自动检测常用安装路径；其他系统或自定义安装位置需要配置：

```bash
# Linux 示例
export GEO_BROWSER_PATH=/usr/bin/google-chrome
```

### 2. 初始化平台登录

首次使用时，分别打开平台的可见浏览器并手动登录：

```bash
npm run open:deepseek
npm run open:doubao
npm run open:kimi
npm run open:qwen
npm run open:yuanbao
```

登录状态保存在 `data/profiles/<platform>`。登录完成后关闭该浏览器，再执行监控任务。同一个平台的登录窗口和采集任务不能同时使用同一 Profile，否则 Chrome 会因 Profile 锁而启动失败。

### 3. 开发模式

分别启动后端和前端开发服务器：

```bash
# 终端 1：API，默认 http://127.0.0.1:3030
npm run dev

# 终端 2：前端，默认 http://127.0.0.1:5173
npm run web
```

Vite 会把 `/api` 和 `/artifacts` 代理到后端。

### 4. 生产模式

```bash
npm run build:web
npm start
```

前端构建完成后，Fastify 会在同一端口提供前端页面、API 和证据文件。可通过 `HOST`、`PORT` 和 `GEO_BROWSER_PATH` 调整监听地址、端口及浏览器路径：

```bash
HOST=0.0.0.0 PORT=3030 GEO_BROWSER_PATH=/usr/bin/google-chrome npm start
```

对公网提供服务时，应在应用前部署带 HTTPS 和身份认证的反向代理，不建议直接暴露 Fastify 端口。

## 使用流程

1. 创建品牌并填写别名、产品或自有域名。
2. 在品牌下添加需要长期监控的问题。
3. 发起监控，选择问题、平台、浏览器模式和并发数。
4. 查看任务进度、回答原文、引用来源及截图证据。
5. 在品牌总览、来源中心和趋势页持续对比监测结果。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm test` | 运行 Node 测试 |
| `npm run dev` | 启动后端开发服务 |
| `npm run web` | 启动 Vite 前端开发服务 |
| `npm run build:web` | 构建前端 |
| `npm start` | 启动生产服务 |
| `npm run open:<platform>` | 打开指定平台的可见登录窗口 |
| `npm run ask -- "问题"` | 通过 CLI 同时打开配置的平台并提交调试问题 |

## 目录结构

```text
geo-monitoring/
├─ src/
│  ├─ api/                 # Fastify 路由
│  ├─ config/              # 数据目录配置
│  ├─ db/                  # SQLite schema 与 repository
│  ├─ infrastructure/      # Playwright 执行器和证据文件
│  ├─ platforms/           # 各平台适配器
│  ├─ worker/              # 任务队列与并发调度
│  └─ index.js             # 服务入口
├─ web/                    # React 前端
├─ test/                   # 自动化测试
├─ docs/                   # 设计与部署文档
└─ data/                   # 本地数据库、Profile 和运行证据（不提交）
```

运行数据默认位于：

```text
data/
├─ brand-monitoring.sqlite
├─ profiles/<platform>/
└─ artifacts/<run-id>/<platform-run-id>/
```

`data/`、数据库、浏览器 Profile、运行截图、`node_modules/` 和 `web/dist/` 均已通过 `.gitignore` 排除。浏览器 Profile 含登录凭据，不能提交、公开或与不受信任的用户共享。

## 远端服务器登录

当前登录命令只会在运行后端的机器上打开有头浏览器。远端 Linux 场景计划使用 Xvfb + x11vnc + noVNC，把后端浏览器画面安全地提供到前端，同时复用现有 Playwright Profile。

详细方案见 [docs/remote-browser-login.md](docs/remote-browser-login.md)。

## 已知限制

- AI 平台页面结构会变化，适配器和引用提取规则需要持续维护。
- 平台风控、验证码和登录过期无法完全自动化，必要时需要人工重新登录。
- 有头/无头可用性取决于平台策略；豆包当前更适合使用有头模式。
- 当前任务队列驻留在单个 Node 进程内，服务重启后不会自动恢复未完成任务。
