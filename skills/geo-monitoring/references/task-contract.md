# 任务与结果格式

`create-task.mjs` 在 `output/<task-id>/` 创建任务。任务格式版本为 `4`。`task.json` 是用户确认后的不可变输入；`manifest.json` 记录运行状态、Profile 绑定状态、内存调度决定和共享队列摘要。

## 目录结构

```text
output/<task-id>/
├─ task.json
├─ manifest.json
├─ manifest.backup.json
├─ events.jsonl
├─ summary.json
├─ summary.md
├─ runtime/
│  ├─ queue.json
│  ├─ queue.backup.json
│  └─ coordinator.lock
└─ platforms/<platform>/
   └─ profiles/<profile-id>/
      ├─ status.json
      └─ questions/<question-id>/
         ├─ answer.json
         ├─ citations.json
         ├─ share.json
         ├─ 01-opened.png / .html
         ├─ 02-submitted.png / .html
         ├─ 03-answer.png / .html
         ├─ 04-citations.png
         └─ 05-share.png / .html（分享入口可用时）
```

同一平台的多个登录态使用不同 `profile-id` 目录，结果和状态互不覆盖。

## task.json

`platforms` 是 Profile 绑定数组，不包含预分配的 `questionIds`。问题放在任务级共享队列中，由可运行 Profile 动态领取：

```json
{
  "version": 4,
  "questions": [
    { "id": "q01", "text": "问题一" },
    { "id": "q02", "text": "问题二" }
  ],
  "platforms": [
    {
      "id": "doubao",
      "profileId": "13220602153",
      "account": "13220602153",
      "bindingId": "doubao:13220602153",
      "mode": "headed"
    },
    {
      "id": "doubao",
      "profileId": "13800001111",
      "account": "13800001111",
      "bindingId": "doubao:13800001111",
      "mode": "headed"
    }
  ]
}
```

`bindingId` 是平台与 Profile 的稳定组合键，格式为 `<platform>:<profile-id>`。`profile-id` 由账号派生（短信平台就是手机号），`account` 保存该 Profile 规范化后的账号；两者对手机号来说相同。任务内按 `bindingId` 去重，同一个账号在同一平台只会出现一次。每个平台的问题只处理一次，但不会在开始前均分给多个 Profile；谁先完成上一题，谁继续领取下一题。`storage.profilesDirectory` 指向本次任务使用的 Profile 根目录。

`settings.globalMaxWorkerConcurrency` 控制同一任务最多同时运行的 Profile Worker 数，默认 `3`。实际并发数还受可用内存和待运行绑定数限制；同一 Profile 由锁保证不会并发。

队列调度参数：

| 字段 | 默认值 | 含义 |
| --- | ---: | --- |
| `claimLeaseMs` | `360000` | 单次问题租约时长，6 分钟 |
| `heartbeatIntervalMs` | `30000` | Worker 续租间隔，30 秒 |
| `maxQuestionAttempts` | `3` | 普通平台错误的最大尝试次数 |
| `retryBaseDelayMs` | `5000` | 普通错误重试的基础退避时间 |

## runtime/queue.json

每个平台有一份独立共享队列。账号不是队列的所有者，完成记录才记录最终处理该题的 `bindingId`。

```json
{
  "version": 1,
  "taskId": "geo-...",
  "platforms": {
    "kimi": {
      "pending": ["q03"],
      "claimed": {
        "q02": {
          "questionId": "q02",
          "bindingId": "kimi:work",
          "leaseId": "...",
          "attempt": 1,
          "claimedAt": "2026-09-15T08:00:00.000Z",
          "expiresAt": "2026-09-15T08:06:00.000Z"
        }
      },
      "completed": {
        "q01": { "bindingId": "kimi:backup", "attempt": 1, "completedAt": "..." }
      },
      "failed": {},
      "attempts": { "q01": 1, "q02": 1 },
      "retryAfter": {}
    }
  }
}
```

- `pending`：等待任意可用 Profile 领取。
- `claimed`：已被某 Profile 租用，尚未提交最终结果。
- `completed`：已成功处理，记录最终处理账号。
- `failed`：已达到重试上限或没有可运行 Profile。
- `attempts`：每个问题的累计领取次数。
- `retryAfter`：普通平台错误退避后的最早可领取时间。

Worker 异常退出时，其所有活动租约会回到 `pending`。若 Worker 仍在运行但心跳中断，租约到期后由协调器回队。

## 协调器锁与持久化恢复

`runtime/coordinator.lock` 是任务级协调器锁，同一任务只允许一个 `run-task.mjs` 持有并写入队列。锁文件至少包含：

```json
{
  "version": 1,
  "taskId": "geo-...",
  "ownerId": "...",
  "pid": 12345,
  "hostname": "host",
  "startedAt": "2026-09-15T08:00:00.000Z",
  "heartbeatAt": "2026-09-15T08:00:15.000Z"
}
```

协调器默认每 15 秒刷新 `heartbeatAt`。如果锁超过 120 秒未刷新，或同主机上的 PID 已不存在，新协调器可以接管；接管时会把旧协调器遗留的所有 `claimed` 问题重新放回 `pending`。旧协调器一旦发现 `ownerId` 或 PID 不再匹配，会停止 Worker，并在后续队列或清单写入前抛出 `coordinator_lock_lost`，避免覆盖新协调器的状态。

队列和清单都采用“先写同目录临时文件，再原子替换主文件”的方式，并在成功后写一份同步备份：

1. 主队列 `runtime/queue.json`，备份 `runtime/queue.backup.json`。
2. 主清单 `manifest.json`，备份 `manifest.backup.json`。

读取时先验证主文件；主文件缺失、损坏或与当前任务不匹配时回退到备份。若队列主文件和备份都不可用，则扫描各 Profile 目录中的 `answer.json`，以状态为 `completed` 的记录重建 `completed` 和 `attempts`，再继续处理剩余问题。恢复后的队列会同时重写主文件和备份。

## manifest.json

主要字段：

```json
{
  "version": 4,
  "taskId": "geo-...",
  "status": "created",
  "bindingStates": {
    "doubao:work": "pending",
    "doubao:personal": "pending"
  },
  "queue": { "version": 1, "path": "runtime/queue.json" },
  "queueSummary": [],
  "scheduler": { "decisions": [] }
}
```

任务状态为 `created`、`running`、`completed`、`completed_with_errors`、`failed` 或 `cancelled`。`bindingStates` 的键是 `bindingId`，值独立记录每个 Profile 绑定，取值为 `pending`、`starting`、`running`、`completed`、`completed_with_errors`、`failed` 或 `cancelled`。

任务最终状态由队列结果决定：

- 全部成功：`completed`。
- 部分成功、部分失败：`completed_with_errors`。
- 全部失败：`failed`。

## 问题与来源结果

`status.json` 记录某个平台 Profile 绑定实际处理过的问题、完成数、失败数和当前状态，包括 `claimedQuestionIds`、`processedQuestionIds`、`completedQuestionIds`、`failedQuestionIds` 和 `questionStates`。它不再包含静态的 `assignedQuestionIds`。

`answer.json` 保存实际提交的问题、回答、提交方式、品牌命中、自有域名引用、引用统计、分享链接摘要、证据文件和错误。问题按最终结果归入 `runtime/queue.json` 的 `completed` 或 `failed`；一个账号失败后，问题可以由其他账号重新领取。不同账号曾经处理过的证据和失败记录仍保留在各自 Profile 目录中。

`share.json` 保存平台分享入口生成并复制的链接、采集方式、状态、是否打开分享弹窗、勾选状态和错误。`captured` 表示拿到公开分享链接；`unavailable` 表示平台没有可识别分享入口；`failed` 表示入口存在但本次采集失败。分享采集是 best-effort，任何分享失败都不改变问题本身为 `completed` 的条件。DeepSeek 未禁言时会通过“创建分享链接 / 创建并复制”生成 `chat.deepseek.com/share/` 链接；账号被禁言时入口会被前端隐藏，应记录 `unavailable`，不得用当前普通会话 URL 冒充分享链接。

`citations.json` 保存规范化 URL、来源域名、行内引用次数、平台报告来源数、可见来源数、抓到的来源卡数和缺失来源索引。一个问题失败不阻止其他账号继续处理后续问题，也不会阻断其他 Profile。

汇总写入 `summary.json` 和 `summary.md`，并按 Profile 输出平台标签、实际完成数、品牌出现率、自有域名引用率和来源采集数。共享队列统计单独输出总量、完成、待领取、租用中、失败和领取尝试次数。需要重建时运行：

```bash
node scripts/report.mjs --task ./output/<task-id>
```

## 任务输入模板

可选的 xlsx 输入模板：`templates/geo-monitoring-task-template-v2.xlsx`，共 4 个工作表。

- `任务`：任务信息（品牌名、自有域名等）与平台账号（启用 / 平台ID / 账号 / 备注），一行一个账号，同一平台可填多个账号。
- `问题`：只处理「启用=是」的行，问题数量不设上限。
- `结果` / `来源`：示例输出，运行时由脚本自动生成，不必手工填写。

模板只用于人工整理输入，实际运行仍以 `task.json` 为准。
