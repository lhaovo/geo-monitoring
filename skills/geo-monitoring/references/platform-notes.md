# 平台说明

支持六个平台。第一登录方式固定如下；扫码登录暂不实现，也不作为自动回退。

| ID | 平台 | 第一登录方式 | 问答模式 | 回答完成与来源采集要点 |
| --- | --- | --- | --- | --- |
| `deepseek` | DeepSeek | 密码登录 | 无头 | 回答文本稳定后采集；尝试打开“个网页”来源入口。 |
| `doubao` | 豆包 | 短信验证码登录 | 有头 | 等待回答文本稳定后采集；从回答区域识别引用来源。 |
| `kimi` | Kimi | 短信验证码登录 | 无头 | 等待停止生成控件消失与回答操作栏出现；打开并滚动“引用来源”侧栏。 |
| `qwen` | 千问 | 短信验证码登录 | 无头 | 从回答底部“篇来源”入口读取来源卡数据。 |
| `wenxiaoyan` | 文小言 | 短信验证码登录 | 无头 | 未登录页也会显示聊天输入框，需结合“请登录/登录同步历史对话”判断；以 `data-status=COMPLETE` 判定回答完成；来源同时读取回答区外链和 `_reference-item_*` 中的 `data-long-press-ext-info`。 |
| `yuanbao` | 腾讯元宝 | 短信验证码登录 | 无头 | 从末条回答的来源触发器逐页读取来源卡，并记录未取得的索引。 |

## 账号身份与多登录态

- Profile 由账号唯一确定：`profile.mjs create --account <account-or-phone>` 会把账号规范化后写入 `profile.json` 的 `account`，并用它派生 Profile ID（短信平台就是手机号）。因此不存在主号 / 工作号之类的角色，也不需要单独的账号指纹。
- `create` 是幂等的：同一账号重复执行返回 `created=false` 和已有 Profile，不会新建第二个。历史遗留的 Profile ID 用 `profile.mjs rebind --profile <old-id> --account <account>` 改成账号并移动目录。
- 登录时提交的账号必须与 Profile 的 `account` 一致，否则命令返回 `account_mismatch`，应为新账号单独建 Profile。不要提交 `profiles/`、Session 或浏览器 Profile 内容。

## 统一登录状态与清理

- 登录命令统一返回 `state` / `status`、`stage`、`nextAction`、`message`、`terminal`、`requiresUserAction`、`account`、`accountBinding`、时间戳和 `error`。Agent 应严格按 `nextAction` 继续，不要根据旧版本自然语言猜测。
- `requiresUserAction=true` 只用于需要用户提供账号、手机号、验证码或人工完成安全验证的状态；`wait_*` 状态不要重复向用户索取或提交材料。
- `login start` 会在创建新会话前自动清理遗留 Session、control、evidence 和 staging。默认终态 Session 保留 24 小时，孤立 control/evidence/staging 保留 1 小时；Broker 仍存活时不会清理。必要时运行 `login cleanup --dry-run` 检查，再运行 `login cleanup`。

## 登录验证

- 登录流程（含登录态保存后的重新打开复验）始终使用有头可见浏览器；检测到登录后用该 Profile 重新打开验证聊天界面，再写入 `health=ready`。
- 登录状态优先检查可见聊天输入框、登录弹窗、登录 URL 和平台安全验证元素。
- DeepSeek 未禁言时，分享入口位于“朗读”按钮之后，选择器为 `div[role=button][aria-label="朗读"] ~ div[role=button]`；先点“创建分享链接”，再点“创建并复制”，链接写入剪贴板，域名匹配 `chat.deepseek.com/share/`。账号被禁言时前端会直接隐藏分享入口，此时记录 `unavailable`，不要点击坐标或普通会话 URL。
- 登录材料通过本地控制文件短暂传给 Broker，Broker 消费后清空；不得写入 Session、任务输出或日志。Profile 只保存规范化后的账号。
- 如页面结构与通用判断不同，只修改对应适配器或通用登录流程，不要把扫码登录接成回退。
- 图形验证码、滑块和安全校验只提示用户在可见浏览器中完成，不自动绕过。
- 监控问答固定为豆包有头，其余平台无头；任务绑定和运行时都会按此规则规范化。登录流程不受该设置影响，始终有头。

## 账号限制检测

- 登录、登录态复验和监测问答会检测账号被禁言、封禁或限制的页面提示，返回 `status=restricted` / `reason=account_restricted`。
- 能识别“账号已被禁言至 YYYY 年 M 月 D 日 HH:mm”等日期形式，写入 `restrictedUntil`；Profile 健康状态记为 `restricted`。
- 监测任务遇到账号限制时停止该 Profile 的 Worker，未完成问题立即回到共享队列，由同平台其他可用 Profile 继续处理。
- 账号受限不是普通登录失效，不应立即重新提交账号密码或验证码；应先等待平台解除限制或改用其他账号。


## 分享链接采集

- 每个问题完成回答和来源采集后，best-effort 打开回答底部分享入口，勾选“全选”，优先读取弹窗中的链接，否则点击“复制链接”并读取剪贴板。
- 豆包分享按钮为 `[data-testid="message_action_share"]`，复制按钮为 `[data-testid="thread_share_copy_btn"]`。
- Kimi 分享弹窗使用 `.select-all` 和“复制链接”按钮，链接域名匹配 `kimi.com/share/`。
- 千问需要先 hover 回答操作区，分享链接域名匹配 `qianwen.my.cn/share/chat/`；选择器变化时保留 `05-share.png/html` 定位。
- 文小言分享入口为 `[data-testid="menu-btn-share"]`，点击后会调用 `shortURL` 接口；若剪贴板读取不稳定，从 JSON 响应中提取分享链接，分享链接域名匹配 `mr.baidu.com` 或 `wenxin.baidu.com`。
- 元宝分享入口为 `[aria-label="分享"]`，复制按钮为 `[data-share-type="link"]`，分享链接域名为 `yb.tencent.com/s/`。元宝发送按钮是 `#yuanbao-send-btn`，不能只依赖 `button[class*=send]`。
- 分享失败不得抛到问题成功流程之外；问题仍按回答与来源结果决定是否完成。

## 选择器维护

页面结构会变化。修改任一平台时只改对应适配器或来源逻辑；不要为了表面统一而删除 Kimi 的侧栏滚动或元宝的卡片分页处理。平台 Worker 失败时保留截图和 HTML，并根据具体 `platformId`、`profileId`、问题编号和错误分类定位问题。