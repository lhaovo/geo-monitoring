---
name: geo-monitoring
description: 使用独立 Playwright 脚本运行国内 AI 平台的 GEO 品牌可见性监测。用于收集品牌、监控问题和平台登录态选择，通过对话管理多个持久化 Profile，完成 DeepSeek 密码登录及豆包、Kimi、千问、文小言、元宝短信验证码登录，再采集回答、引用来源、平台分享链接、品牌出现率与页面证据；不依赖后端或数据库。
---

# GEO Monitoring

使用此 Skill 运行文件化的 GEO 监测任务。Skill 负责确认范围、管理登录态和执行浏览器自动化；结果写入调用目录下的 `output/<task-id>/`。

## 支持范围

- 平台：DeepSeek、豆包、Kimi、千问、文小言、腾讯元宝。
- 监控问答固定使用豆包有头模式，其余平台无头模式；登录与登录态复验始终使用有头模式。
- 每个任务的去重后问题数量不设上限；不要按“十题”或其他默认阈值截断。
- 一个平台可以保存多个登录态 Profile；一个任务可以同时绑定同一平台的多个 Profile。
- 每个平台维护一份共享问题队列，不在任务开始前把问题静态均分给 Profile。每个 Worker 完成当前问题后再领取下一题，因此 100 题绑定 2 个 Profile 时，由两个账号动态分担，总处理量仍为 100。
- 每个 Worker 同一时刻只处理一题；不同 Profile 可以并发，任务默认最多 3 个 Worker，也可在创建任务时用 `--concurrency <n>` 指定上限；实际并发还受可用内存限制。
- 问题领取使用租约和心跳。Worker 异常退出或租约过期后，未完成问题立即回到共享队列，由其他可用 Profile 继续处理；单个账号失效不会造成静态分配下的大段任务无法执行。不同 Profile 的真实回答、来源、失败记录和最终归属保持独立。
- 只实现第一登录方式：DeepSeek 使用密码登录；豆包、Kimi、千问、文小言、元宝使用短信验证码登录。扫码登录不实现，也不要作为回退。
- Agent 通过对话收集第一阶段登录材料：DeepSeek 使用账号和密码；豆包、Kimi、千问、文小言、元宝使用手机号和用户收到的短信验证码，再由本地脚本自动填写和提交。
- 登录材料通过本地短时控制文件传给 Broker，Broker 消费后立即清空；不得写入 Session 文件、Profile 元数据、任务输出或日志。不要重复回显密码和验证码。
- 图形验证码、滑块和安全校验必须由用户人工完成；不要尝试绕过验证码、风控或 MFA。
- 登录态使用 Playwright `launchPersistentContext` 持久化。不要导出、复制、读取或输出 Cookie、`storageState`、二维码或浏览器 Profile 内容。

- 每个成功问题在完成回答和来源采集后，会 best-effort 打开平台分享入口，勾选“全选”并复制分享链接；分享链接写入该问题的 `share.json`，摘要同步写入 `answer.json`。分享失败或平台不提供分享入口不会让问题失败。

## 安装与诊断

在 Skill 根目录安装独立依赖并检查环境：

```bash
npm install
node scripts/doctor.mjs --profiles ./profiles
```

`GEO_BROWSER_PATH` 可指定 Chrome/Edge 路径；也可在各命令传入 `--browser <path>`。`profiles/`、`output/`、Session 和锁文件都不应提交到版本库。

## 登录态模型

登录态保存在 `<profiles>/<platform>/<profile-id>/chrome`。Profile ID 由账号自动生成：短信平台直接用手机号（例如 `profiles/doubao/13220602153`），DeepSeek 用规范化后的登录账号。一个账号在同一平台只对应一个 Profile，不需要额外命名，也不存在主号 / 工作号 / 个人号这类角色区分。每个 Profile 有独立元数据，主要状态为：

- `new`：刚创建，尚未完成登录。
- `ready`：已完成登录，并通过重新打开验证。
- `expired`：需要重新登录。
- `error`：最近一次验证或运行失败。
- `restricted`：平台明确提示账号被禁言、封禁或限制；`restrictedUntil` 会记录可解析的解除时间。
- `disabled`：由用户主动禁用。

每个 Profile 的 `account` 字段保存规范化后的账号（短信平台为手机号，DeepSeek 为登录账号），Profile ID 由该账号派生，目录名、任务绑定和报告里都直接使用这个账号。密码和验证码永不落盘，只通过本地短时控制文件传递。

常用命令：

```bash
node scripts/profile.mjs list --profiles ./profiles
node scripts/profile.mjs create --platform doubao --account "<account-or-phone>" --profiles ./profiles
node scripts/profile.mjs rebind --platform doubao --profile <old-profile-id> --account "<account-or-phone>" --profiles ./profiles
node scripts/profile.mjs default --platform doubao --profile <profile-id> --profiles ./profiles
node scripts/profile.mjs check --platform doubao --profile <profile-id> --profiles ./profiles
node scripts/profile.mjs disable --platform doubao --profile <profile-id> --profiles ./profiles
```

`create` 是幂等的：同一个账号重复执行只会返回已有 Profile（`created=false`），不会新建第二个。`rebind` 用来把历史遗留的 Profile ID 改成账号并移动目录。一个平台有多个 Profile 时，必须让用户明确选择使用哪一个，不要自行挑一个。

## 对话式登录流程

当用户需要新增或重新登录时，Agent 负责组织对话并执行命令，不要只给用户一段命令让其自行处理。

1. 运行 `profile.mjs list`，确认平台现有 Profile、默认 Profile 和 `health`。一个平台有多个 Profile 时，必须让用户明确选择使用哪一个。
2. 先向用户索取账号或手机号，再运行幂等的 `profile.mjs create`，它会创建或复用该账号的 Profile：

```bash
node scripts/profile.mjs create --platform doubao --account "<account-or-phone>" --profiles ./profiles
```

   - 返回 `created=true` 表示新建了 Profile，继续登录。
   - 返回 `created=false` 表示该账号已有 Profile，直接复用返回的 `profileId`，不要重复创建。
   - 一个平台有多个 Profile 时，必须让用户明确选择使用哪一个，不要自行挑一个。
3. 不要为同一个账号建第二个 Profile。要用另一个账号时，先向用户索取新的手机号或账号，再执行一次 `create`。
4. 启动登录会话：

```bash
node scripts/login.mjs start --platform doubao --profile <profile-id> --profiles ./profiles
```

5. 读取返回 JSON，按统一的 `state` / `nextAction` 协议继续；不要依赖旧的自由文本判断。
6. DeepSeek 在 `awaiting_password` 时向用户索取账号和密码，然后运行 `submit-password`；短信平台在 `awaiting_phone` 时索取手机号并运行 `submit-phone`。脚本负责自动填写、处理用户协议并请求验证码。
7. 收到 `awaiting_sms_code` 后提示用户查看短信；用户提供验证码后运行 `submit-code`，脚本自动填写并提交。
8. 只有 `awaiting_human_challenge` 或 `requiresUserAction=true` 且明确要求人工安全验证时，才请用户在可见浏览器中完成图形验证码、滑块等操作；完成后运行 `verify`，不要尝试绕过风控。
9. `submit-password` 和 `submit-code` 可能等待平台返回并完成登录态保存。只要返回 `state=completed`，说明登录态已保存并通过重新打开验证。若返回仍是非终态或 `timedOut=true`，运行 `verify` 继续检查，不要直接宣称登录成功。
10. 如果出现 `profile_locked`，说明该 Profile 正被另一个浏览器或监控任务占用。先关闭占用它的窗口，再重试；不要删除 Profile 来排错。
11. 如果会话 `failed`、`cancelled` 或 `expired`，报告原因并在用户确认后创建新会话。 如果返回 `state=account_restricted`，应停止重试该 Profile，报告平台、账号提示和解除时间。

对应平台的提交命令：

```bash
node scripts/login.mjs submit-password --session <session-id> --account <account> --password <password> --profiles ./profiles
node scripts/login.mjs submit-phone --session <session-id> --phone <phone> --profiles ./profiles
node scripts/login.mjs submit-code --session <session-id> --code <code> --profiles ./profiles
```

### 统一登录状态输出

`start`、`status`、各 `submit-*`、`verify`、`cancel` 和 `sessions` 都返回同一套 JSON 字段：`version`、`platform`、`profile`、`state`、`status`、`stage`、`nextAction`、`message`、`ok`、`terminal`、`requiresUserAction`、`account`、时间戳和 `error`。其中 `status` 与 `state` 相同，保留该字段是为了兼容调用方。

- `nextAction` 是下一步行为；`wait_*` 表示等待 Broker 推进，不要反复向用户索取已经提交的材料。
- `terminal=true` 后不再轮询；`completed` 是成功，其余终态按 `message` 和 `error` 处理。
- `requiresUserAction=true` 只表示需要用户提供登录材料或在可见浏览器中完成安全验证；等待任务本身不会把它设为 `true`。
- `account` 是当前 Profile 的账号；`accountBinding.status` 为 `bound_to_current` 或 `unbound`。
- `submit-password` 和 `submit-phone` 提交的账号必须与 Profile 的 `account` 一致。不一致时命令返回 `account_mismatch`；此时应为新账号执行 `profile.mjs create` 新建 Profile，不要改动已有 Profile。

常用 `state` / `nextAction` 处理表：

| state | nextAction | Agent 行为 |
| --- | --- | --- |
| `created` | `start` | 启动登录会话，通常由 `login.mjs start` 内部完成。 |
| `starting_browser` | `wait_for_browser` | 调用 `status` 或等待当前命令返回。 |
| `awaiting_password` | `submit_password` / `retry_password` | 索取 DeepSeek 账号和密码，执行 `submit-password`。 |
| `processing_password` | `wait_for_password_submission` | 等待，不要重复提交。 |
| `awaiting_phone` | `submit_phone` / `retry_phone` | 索取手机号，执行 `submit-phone`。 |
| `processing_phone` | `wait_for_sms_request` | 等待验证码请求完成。 |
| `awaiting_sms_code` | `submit_sms_code` / `retry_sms_code` | 索取用户收到的验证码，执行 `submit-code`。 |
| `processing_sms_code` | `wait_for_sms_code_submission` | 等待，不要重复提交。 |
| `checking_login` | `wait_for_login_result` | 轮询 `status`；超时后执行 `verify`。 |
| `awaiting_human_challenge` | `complete_human_challenge_in_browser` | 请用户在可见浏览器完成安全验证，然后执行 `verify`。 |
| `verifying` / `saving` | `wait_for_profile_verification` / `wait_for_profile_save` | 等待保存与复验完成。 |
| `retryable_error` | `inspect_login_error` | 读取 `message` / `error`，只重试失败的步骤。 |
| `completed` | `none` | 登录态已保存，可以使用该 Profile。 |
| `failed`、`cancelled`、`expired` | `start_new_session` 或 `wait_for_lock_release` | 按提示处理占用或重建会话。 |

会话查询、复验、取消和清理命令：

```bash
node scripts/login.mjs status --session <session-id> --profiles ./profiles
node scripts/login.mjs sessions --profiles ./profiles
node scripts/login.mjs verify --session <session-id> --profiles ./profiles
node scripts/login.mjs cancel --session <session-id> --profiles ./profiles
node scripts/login.mjs cleanup --dry-run --profiles ./profiles
node scripts/login.mjs cleanup --profiles ./profiles
```

`login start` 会在创建新会话前自动执行一次 best-effort 清理。清理规则：非活跃且过期的 Session 会删除；终态 Session 默认保留 24 小时后删除；没有对应活跃 Session 的遗留 control、evidence 和 `.staging` 目录默认保留 1 小时后删除。Broker PID 仍存活的 Session 不会清理，Profile 目录和登录态也不会删除。可用 `--terminal-retention-ms` 和 `--orphan-grace-ms` 调整保留时间；`--dry-run` 只报告不删除。

## 创建与运行任务

先确认每个待运行 Profile 的 `health=ready`。未登录或已过期时先走上面的对话式登录流程；监控调度器也会在启动任何 Worker 前统一预检，未就绪时返回 `login_required`。

使用重复的 `--platform` 和 `--profile` 创建任务；第 n 个 `--profile` 绑定第 n 个 `--platform`。省略 `--profile` 时使用该平台默认 Profile：

```bash
node scripts/create-task.mjs \
  --brand "品牌名" \
  --alias "品牌别名" \
  --domain "example.com" \
  --question "问题一" \
  --question "问题二" \
  --platform deepseek --profile 13220602153 \
  --platform doubao --profile 13220602153 \
  --platform doubao --profile 13800001111 \
  --concurrency 2 \
  --append-search-prompt \
  --profiles ./profiles \
  --output ./output
```

该命令输出任务目录，然后执行：

```bash
node scripts/run-task.mjs --task ./output/<task-id>
```

不要把同一个 Profile 同时用于登录和监控。若任务预检失败，报告具体 `平台:Profile` 及其 `health`，先完成对应登录，再重新运行任务。

### 输入模板

如需人工整理输入，可使用 `templates/geo-monitoring-task-template-v2.xlsx`（4 个工作表）：`任务` 填任务信息与平台账号（一行一个账号，同一平台可填多个），`问题` 填监控问题（只处理「启用=是」的行），`结果` 与 `来源` 为示例输出。模板只用于辅助整理输入，实际运行仍以 `create-task.mjs` 生成的 `task.json` 为准。

### 动态队列与故障恢复

- 队列主文件在 `runtime/queue.json`，同步镜像在 `runtime/queue.backup.json`；`manifest.json` 也有 `manifest.backup.json`。两者先写临时文件再原子替换，主文件损坏时自动回退备份。
- `runtime/coordinator.lock` 是任务级协调器锁。同一任务只允许一个 `run-task.mjs` 写队列；协调器每 15 秒刷新心跳，失活超过 120 秒后可被新协调器接管，接管时会把旧 `claimed` 问题回收至 `pending`。
- 主队列和备份都损坏时，会根据 Profile 目录里的 `answer.json` 重建 `completed` 状态，再继续处理剩余问题。
- Worker 领取问题后默认持有 6 分钟租约，并每 30 秒续租。正常任务不会因为租约到期而中断。
- Worker 崩溃、退出或失去心跳时，其未完成租约会立即或到期后回到 `pending`，其他 Profile 可以继续抢占处理。
- `profile_locked`、`login_required`、`human_challenge` 等情况立即将当前问题重排，并停止该 Profile Worker；`platform_error` 默认最多尝试 3 次。
- 某个平台已经没有任何可运行 Profile，而队列仍有未领取问题时，剩余问题标记为 `no_available_profile`，不会让整个任务永久挂起。
- 任务状态按最终队列统计：全部完成是 `completed`，部分完成是 `completed_with_errors`，全部失败是 `failed`。

## 结果与验收

任务完成后读取 `summary.md` 和 `summary.json`；需要重建汇总时运行：

```bash
node scripts/report.mjs --task ./output/<task-id>
```

摘要按 Profile 分隔，并包含平台、登录态标签、完成数、品牌出现率、自有域名引用率和来源采集数。详细目录和字段见 [references/task-contract.md](references/task-contract.md)，平台差异见 [references/platform-notes.md](references/platform-notes.md)。

不要将“平台报告来源数”“页面可见来源数”“实际采集来源数”混为一谈。若平台报告 15 个来源而只采集到 12 个，必须明确报告差异。相同 URL 在不同平台或不同 Profile 的回答中应保留为独立记录；只在同一回答内按规范 URL 去重。

每个问题默认打开独立页面并从平台入口开始，以避免上一个问题污染对话。问题、回答、来源、截图和 HTML 都保存在对应 Profile 的任务目录中。

分享采集是 best-effort：共享队列成功条件仍取决于回答和引用采集是否完成。`share.json` 的 `status` 为 `captured`、`unavailable` 或 `failed`；只有 `captured` 时 `url` 才是可复用的公开分享链接。DeepSeek 未禁言时会从“朗读”后的分享按钮创建公开链接；账号处于禁言状态时前端隐藏入口，记录 `unavailable`，不得用普通会话 URL 代替。

## 取消与异常

运行任务是外部操作。用户要求停止时，向运行 `run-task.mjs` 的终端发送 `Ctrl+C`；调度器会停止新 Worker，并向已启动的 Worker 发送取消信号以关闭其 BrowserContext。不要删除 Profile 或 `output/` 来达到取消目的。

出现选择器变化、登录失效或来源数不一致时，保留任务目录中的截图和 HTML，报告具体平台、Profile、问题编号和错误分类，再决定是否修改平台适配脚本。
