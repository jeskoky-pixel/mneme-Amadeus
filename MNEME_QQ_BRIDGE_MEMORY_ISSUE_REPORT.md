# Mneme 在 QQ Bridge 场景下的记忆质量问题与 fork 实施报告

日期：2026-11-16
状态：已建立 `mneme-Amadeus` fork，并完成实现、持续采集修复与回归验证

## 结论

问题的核心不是 Mneme 的 SQLite、蒸馏、检索或来源追溯能力不足，而是 DSH 事件和 QQ 自然对话没有被区分。QQ Bridge 的真实助手发言来自发送工具；回合末尾的普通 `assistant/message` 可能根本没有发送到 QQ。原有采集路径因此会把工具 JSON、等待状态、记忆检索结果、persona/部署提示和一次性运行状态混进记忆库。

没有找到一个公开、可直接接入且已经实现这套 QQ Bridge 发送语义的记忆插件。Mneme 自己已有工作区作用域和完整的存储/蒸馏/检索/巩固链路，最小风险的方案是从 Mneme fork，在边界增加 QQ 事件归一化，并让现有作用域机制成为唯一隔离出口。

## 现有记忆库的只读检查

本轮只读检查了当前本地 Mneme 记忆库，没有删除、归档或重写任何旧记忆。样本中有一部分内容是有价值的，例如稳定偏好、可复用的部署关系和持续任务；另一部分只是：

- `memory_recall` 命中/未命中的系统自述；
- `qq_wait_for_messages` 的 timeout、潜水和收尾状态；
- QQ 身份、persona、部署配置的重复描述；
- 一次性问候、短确认和高度重复的闲聊。

这些内容说明 Mneme 并非完全没有提取能力，而是缺少“真实 QQ 消息”和“DSH 内部执行面”的边界。旧库治理不在本轮范围内，后续应继续先做 dry-run，再人工确认归档。

## 公开方案调研

- [Mneme upstream](https://github.com/slow-stack/mneme)：已有 agent/workspace scope、SQLite、自动蒸馏、检索、dream/consolidation 和 provenance，适合作为维护基线。
- [DSH-Mem0](https://github.com/light-cheng/DSH-Mem0)：只采集用户消息和最终助手回复，能参考“排除工具过程”的方向，但不能识别 QQ 工具参数中的真实发言。
- [Mneme-Bridge](https://github.com/SternChiri/Mneme-Bridge)：提供社区侧桥接思路，但没有覆盖本项目要求的 QQ 入站快照、实际发送确认、部分发送和工作区严格边界语义。

因此本项目没有另起炉灶重写记忆系统，而是在 Mneme fork 中保留原有链路。

## 已完成的 fork 实现

Fork：[jeskoky-pixel/mneme-Amadeus](https://github.com/jeskoky-pixel/mneme-Amadeus)

实现分支：`codex/mneme-amadeus-qq-memory`
Draft PR：[Add QQ Bridge memory normalization and workspace isolation](https://github.com/jeskoky-pixel/mneme-Amadeus/pull/1)

### 工作区边界

新增 `workspaceScopeRequired` 配置，并复用 Mneme 的 `createScopeResolver`、`workspace_scope`、严格可见性和 SQL 过滤：

- 同一 QQ Bridge 工作区下的私聊、群聊和多个 Session 共享长期记忆；
- 其他工作区的带标签记忆不会进入搜索、注入、工具读取、蒸馏和 dream 候选；
- 作用域无法解析时，QQ 蒸馏不推进游标、不回退到全库；写入工具也 fail-closed；
- `workspaceScopeRequired` 还在 `service.saveWithDedupe` 这一写入总闸上生效：API、standalone、bootstrap 等无会话入口若未显式提供工作区会拒绝写入，只有显式 global 才允许共享；
- Windows 驱动器路径、UNC 路径和 POSIX 路径在边界处统一规范化；
- `workspace_scope: "global"` 是显式共享写入；历史无标签行继续按兼容策略视为全局行；
- `memory_get/update/delete/forget/archive/pin` 都经过同一可见性判断，避免仅凭 ID 跨工作区修改；
- 普通 DSH 会话在开关关闭时保留原有行为。

新增/修改的主要文件：

- `dsh-mneme/src/scope-boundary.js`：路径规范化和 required scope 解析；
- `src/store.js`、`src/service.js`、`src/tools.js`：读写、检索、注入和工具操作边界；
- `src/dream.js`、`src/dream/sleep.js`：巩固边界和安全降级；
- 对应 `lib/` 文件由仓库要求的同步脚本生成。

### QQ Bridge 消息归一化

新增 `dsh-mneme/src/qq-bridge-normalizer.js`，在进入现有 summarize 管线前把 DSH 事件转换为真实聊天消息：

- 入站读取 `user/message` 中的 `【本次消息快照】`，以及 `qq_get_unread_messages`、`qq_wait_for_messages` 返回的 `messages/newMessages`；`qq_get_prompt` 的角色卡和状态文本不会被当成聊天；
- 解析工具返回中的 JSON text block，不把整个工具 JSON 写成用户发言；
- 保留 messageId、QQ seq、发送者、群/私聊、conversation key、来源 session 和 DSH 事件序号；
- 这些参与者元数据会以稳定的 QQ 来源标记进入蒸馏转录和 `distill_records`，使同一工作区内不同群友/私聊对象的偏好与经历仍可区分；
- 忽略 `isSelf` 消息；相同 QQ 消息从唤醒快照和 unread/wait 重复到达时合并；不同时间、不同 QQ seq 的相同文字保留为两条；
- 出站支持 `qq_send_message`、`qq_send_group_message`、`qq_send_private_message`、`qq_reply` 和 `qq_send_burst`；只在结果明确报告 `sent` 数量或可识别的已发送记录时写入助手发言；
- 发送失败、歧义结果和未发送的回合末尾 assistant 文本不进入聊天记忆；部分发送只保留明确确认的前缀。HTTP 错误中只有内部 `error.sent` 而没有公开 sent 数量时，适配层会保守丢弃；
- poke、sticker、voice 等非文本工具不伪造为文字记忆；
- 连续运行中新的 QQ 事件若在上一轮 LLM 蒸馏期间到达，会合并为 pending/latest trigger，在上一轮完成后补跑，避免没有后续 `turn/end` 时丢窗口。

归一化后的消息继续进入 Mneme 原有的蒸馏、去重、来源关联、写入和检索流程，没有新建第二套数据库。

### 配置入口

```json
{
  "scopeEnabled": true,
  "strictScope": true,
  "workspaceScopeRequired": true,
  "qqBridgeMemory": {
    "enabled": true,
    "captureContinuous": true
  }
}
```

详细说明见 fork 内的 [`dsh-mneme/docs/QQ-BRIDGE.md`](dsh-mneme/docs/QQ-BRIDGE.md)。

### DSH 设置 GUI

本轮同步修改的是 DSH 插件自己的原生设置面板，不是 Mneme 的 Web UI，也没有新增一套配置存储：

- “作用域”分组新增“强制按工作区隔离”；
- 新增“QQ 记忆”分组，包含“启用 QQ 真实会话适配”和“持续采集 QQ 消息”；
- 三个开关都复用现有 `/features`、`feature_flags` 和待重启提示，改动后重启 DSH 使启动配置生效；
- 面板只增加这三个新功能入口，普通 DSH 的既有设置和 Web UI 不改。

### 持续采集触发修复

持续采集监听器现在会缓存前置 `tool/call` 的 `callId → 工具名`，在正常的
`tool/result`（只带 `kind: "tool"` 与 `callId`）到达时回查工具名，再判断是否为
QQ Bridge 工具。这样等待、读取和实际发送工具的结果都能在结果到达时触发连续蒸馏；
没有匹配调用或没有 QQ 工具名时仍不会触发。关联表按 Session 隔离、结果消费后删除，
并有上限，避免长期运行任务积累悬挂调用。

## 巩固边界与已知限制

`runDream` 在 required 模式下只使用最近带标签工作区的候选，并且不会把两个带标签工作区合并到同一轮；为避免旧 scheduler 没有工作区载体而越界，`runSleep` 在 required 模式下安全跳过。当前 dream 的触发阈值仍按全库数量计算，A/B 工作区交替写入时最近工作区优先，另一侧可能延迟。这些是明确的安全降级，不是会话级隔离缺失；后续可把 scheduler 改成按 workspace 分桶的队列。

本轮没有清理旧记忆，也没有把 persona/config 复读做成关键词硬过滤。当前实现先确保消息事实、来源和作用域正确；后续可在现有蒸馏 prompt/写入准入扩展点继续增加内容意义过滤。

## 验证

在独立 fork checkout 中执行：

- 全量：`node --test test/*.test.js` → **3604 tests，3603 pass，0 fail，1 skipped**；
- QQ 归一化与作用域边界：10/10 pass；
- dream narrative 工作区隔离：10/10 pass；
- summarize 全文件：100/100 pass；
- `git diff --check` 通过，`src/` 与 `lib/` 已用项目同步脚本更新；
- 未安装、链接或修改当前本地 DSH/QQ Bridge 组件，未改动现有记忆库。

子代理对最终实现做了只读审查，确认了 scope 入口、QQ 适配边界、部分发送策略、连续捕获补跑、narrative 工作区过滤和工具可见性检查；同时指出 dream scheduler 仍是全库阈值、sleep required 模式安全跳过、旧无标签行兼容可见等已在本报告中列明的限制。

## 后续建议

1. 先在新产生的 QQ 记忆上观察质量，不迁移旧库。
2. 为现有记忆生成只读分类报告，再人工决定归档配置复读和运行噪声。
3. 若需要完整巩固隔离，把 dream trigger/baseline 和 sleep phases 改为 workspace 队列/载体。
4. 继续跟进 Mneme upstream，在适配层保持小而清晰的改动，避免把 QQ 专用判断散落到核心存储代码。
