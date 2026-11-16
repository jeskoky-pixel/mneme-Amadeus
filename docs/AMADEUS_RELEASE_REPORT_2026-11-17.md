# Amadeus 插件正式发布报告

日期：2026-11-17

## 发布结果

| 项目 | GitHub Release | npm 包 | 状态 |
| --- | --- | --- | --- |
| Mneme Amadeus | [v0.17.1](https://github.com/jeskoky-pixel/mneme-Amadeus/releases/tag/v0.17.1) | [@fg-lab/dsh-mneme@0.17.1](https://www.npmjs.com/package/@fg-lab/dsh-mneme/v/0.17.1) | 已发布 |
| QQ Bridge Amadeus | [v0.3.1](https://github.com/jeskoky-pixel/qq-bridge-Amadeus/releases/tag/v0.3.1) | [@fg-lab/qq-bridge@0.3.1](https://www.npmjs.com/package/@fg-lab/qq-bridge/v/0.3.1) | 已发布 |

两个 GitHub Release 均以合并到 main 的提交为目标，未上传额外二进制附件；GitHub 会提供对应源码压缩包，npm 提供可安装 tarball。

## Mneme 本轮改动

- 以 DSH 工作区作为主要记忆边界，统一贯穿采集、写入、自动召回、主动检索和巩固。
- 复用既有 agent_scope、workspace_scope 和严格作用域过滤；作用域无法确定时不静默回退到全库。
- 保留发送者、群聊/私聊、来源会话等参与者信息，工作区共享不等于人物信息混淆。
- 增加 QQ Bridge 消息归一化：提取真实入站消息和实际发送的助手消息，关联工具调用与发送回执，过滤 DSH 工具 JSON、内部思考、等待/超时和未发送的回合尾部消息。
- 同一消息从多个入口重复出现时在蒸馏前合并；不同时间的相同文本不因文字相同而去重。
- 持续采集监听器通过 tool call 的 callId 关联 tool result，支持一次持续 Agent 任务中的多次等待、收取和回复。
- DSH GUI 设置增加 QQ 工作区记忆适配和工作区隔离相关入口。
- 默认安装不携带 ONNX runtime；运行时 dependencies 只有 yaml 和 morphicons，transformers 是可选 peer，Embedding/Rerank 运行时按需配置。
- 修复 Windows npm 生命周期中 prepack 找不到 npm 命令的问题，改为直接调用 Node 同步脚本。

## QQ Bridge 本轮改动

- 正式包名为 @fg-lab/qq-bridge，版本 0.3.1。
- README 和安装入口切换到 Amadeus fork。
- 发布 tarball 不包含 node_modules 或运行状态目录。
- 保留现有 bridge 状态目录、配置和 DSH 安装脚本的运行方式。

## 验证

- Mneme 重点回归测试：38/38 通过。
- Mneme src/lib 同步检查通过：131 个文件一致。
- Mneme npm tarball：582 个文件，未发现 onnxruntime 路径。
- QQ Bridge 插件测试：6/6 通过。
- QQ Bridge npm tarball：195 个文件，未打入 node_modules。
- 两个 npm registry tarball 均可直接下载。

## 主 DSH 更新原则

本次开发没有修改主 DSH，也没有迁移、清理或重写现有记忆库。更新前先备份 DSH profile 配置和 Mneme 数据目录；更新插件包后重启 DSH/QQ Bridge。现有记忆数据应由新版本继续读取，工作区隔离开关启用后，旧的无工作区标签记忆仍按兼容规则保留为可共享内容。

推荐安装包：

```powershell
dsh plugin --profile web add @fg-lab/dsh-mneme@0.17.1
npm install @fg-lab/qq-bridge@0.3.1
```

QQ Bridge 更新应在独立的 bridge 部署目录执行，保留现有 config.json 和 state 目录；不要在主 DSH 仓库目录运行 npm install。


