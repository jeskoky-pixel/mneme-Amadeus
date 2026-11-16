# QQ Bridge memory adapter

`mneme-Amadeus` keeps Mneme's existing SQLite store, distillation, recall, provenance, and consolidation paths. The QQ adapter is a boundary module enabled in the fork's config; it does not change the DSH host or QQ Bridge runtime.

## Recommended configuration

Enable the existing scope system together with the opt-in adapter in the Mneme config:

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

The same three controls are available in the DSH settings GUI under **功能开关**:
`作用域 → 强制按工作区隔离`, `QQ 记忆 → 启用 QQ 真实会话适配`, and
`QQ 记忆 → 持续采集 QQ 消息`. The panel writes through Mneme's existing
`/features` settings path; restart DSH after changing them so the startup config
and the live adapter agree.

`workspaceScopeRequired` is fail-closed. If the session header or workspace registry does not provide a workspace, a QQ distillation window is skipped and its cursor is not advanced. This prevents an unresolved QQ task from silently reading or writing the global pool. Explicit `workspace_scope: "global"` remains an intentional shared write.

## What enters memory

The adapter reads actual QQ messages from the `【本次消息快照】` embedded in `user/message`, and from the `messages`/`newMessages` payloads returned by `qq_get_unread_messages` and `qq_wait_for_messages`. `qq_get_prompt` is treated as control/status context; role-card text and tool status are not chat unless an actual message array is present. It parses JSON text blocks instead of storing the tool result as a chat message, ignores `isSelf` messages on inbound reads, keeps QQ message IDs/sequence/sender/channel metadata, and deduplicates repeated delivery of the same message. Equal text at different QQ sequence numbers remains separate.

Assistant text enters memory only after `qq_send_message`, `qq_send_group_message`, `qq_send_private_message`, `qq_reply`, or `qq_send_burst` returns an explicit `sent` count or identifiable sent records. A partial result contributes only the explicitly confirmed prefix; an HTTP error whose internal `error.sent` count is not exposed is discarded conservatively. DSH final assistant text, internal reasoning, tool arguments, wait/timeout status, and memory recall output are excluded. Non-text sends such as poke, sticker, and voice are intentionally not converted into text memories.

## Scope and consolidation

The workspace label is normalised for Windows and POSIX spelling before it is written. Required workspace filtering applies to search, injection, tool list/get/update/delete/forget/archive/pin visibility, distillation writes, and the bounded dream candidate/summary/narrative pools. Legacy rows with no workspace label are treated as intentional global rows; newly captured QQ rows always carry the current workspace label. Dream candidate selection is fail-closed and latched to the latest stamped workspace, so one run never combines rows from two labelled workspaces. Its scheduler threshold still counts the whole store, and alternating workspaces may delay one side; a later per-workspace queue can remove that limitation. Sleep is skipped in required mode because its legacy scheduler has no workspace carrier; this is a deliberate fail-closed limitation for a later scoped sleep scheduler.

Ordinary DSH sessions keep Mneme's existing behavior when `qqBridgeMemory.enabled` and `workspaceScopeRequired` are false. The adapter is intentionally concentrated in `src/qq-bridge-normalizer.js`, `src/scope-boundary.js`, and the small integration points in `summarize.js`, `service.js`, `tools.js`, `dream.js`, and `store.js`.

## Validation

The fork includes focused tests in `test/qq-bridge-normalizer.test.js` and `test/scope-boundary.test.js`, plus a continuous-capture replay regression in `test/summarize.test.js`. Run the full project suite with `npm test` after installing the fork's dependencies; all validation is performed in the isolated checkout without modifying any live DSH files.

