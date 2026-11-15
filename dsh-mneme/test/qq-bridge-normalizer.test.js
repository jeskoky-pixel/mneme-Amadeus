import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQqEvents, isQqBridgeSession } from "../src/qq-bridge-normalizer.js";

test("normalizes unread tool JSON and deduplicates a wake snapshot by QQ message id", () => {
  const snapshot = { messages: [{ messageId: "m-1", seq: 10, userId: "42", text: "今晚继续修记忆" }], recent: [] };
  const events = [
    { seq: 1, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: `角色卡\n【本次消息快照】\n${JSON.stringify(snapshot)}\n以上消息已提供` }] } },
    { seq: 2, type: "tool/call", data: { name: "qq_get_unread_messages", callId: "c-in" } },
    { seq: 3, type: "tool/result", data: { message: { source: { name: "qq_get_unread_messages", callId: "c-in" }, content: [{ type: "text", text: JSON.stringify({ ok: true, messages: snapshot.messages }) }] } } }
  ];
  const parts = normalizeQqEvents(events, { sessionId: "s" });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].role, "user");
  assert.equal(parts[0].text, "今晚继续修记忆");
  assert.equal(parts[0].metadata.qqSeq, 10);
  assert.equal(parts[0].metadata.dshEventSeq, 1);
});

test("keeps distinct same-text QQ messages and ignores self messages", () => {
  const events = [{ seq: 4, type: "tool/call", data: { name: "qq_wait_for_messages", callId: "wait" } }, { seq: 5, type: "tool/result", data: { message: { source: { name: "qq_wait_for_messages", callId: "wait" }, content: [{ type: "text", text: JSON.stringify({ newMessages: [{ seq: 20, text: "嗯", isSelf: false }, { seq: 21, text: "嗯", isSelf: false }, { seq: 22, text: "机器人", isSelf: true }] }) }] } } }];
  const parts = normalizeQqEvents(events);
  assert.deepEqual(parts.map((part) => part.text), ["嗯", "嗯"]);
  assert.deepEqual(parts.map((part) => part.metadata.qqSeq), [20, 21]);
});

test("does not merge equal QQ sequence numbers from different conversations", () => {
  const events = [
    { seq: 1, type: "tool/call", data: { name: "qq_get_unread_messages", callId: "g" } },
    { seq: 2, type: "tool/result", data: { message: { source: { name: "qq_get_unread_messages", callId: "g" }, content: [{ type: "text", text: JSON.stringify({ key: "group:1", messages: [{ seq: 9, text: "同序号" }] }) }] } } },
    { seq: 3, type: "tool/call", data: { name: "qq_get_unread_messages", callId: "p" } },
    { seq: 4, type: "tool/result", data: { message: { source: { name: "qq_get_unread_messages", callId: "p" }, content: [{ type: "text", text: JSON.stringify({ key: "private:2", messages: [{ seq: 9, text: "同序号" }] }) }] } } }
  ];
  const parts = normalizeQqEvents(events);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((part) => part.metadata.channel), ["group", "private"]);
});

test("records only confirmed outbound messages, including partial sends", () => {
  const events = [
    { seq: 1, type: "tool/call", data: { name: "qq_send_burst", callId: "send", arguments: { messages: ["第一条", "第二条"] } } },
    { seq: 2, type: "tool/result", data: { isError: true, message: { source: { name: "qq_send_burst", callId: "send" }, content: [{ type: "text", text: JSON.stringify({ ok: false, sent: 1, failed: 1 }) }] } } },
    { seq: 3, type: "assistant/message", data: { content: [{ type: "text", text: "这句没有发到 QQ" }] } }
  ];
  const parts = normalizeQqEvents(events);
  assert.deepEqual(parts.map((part) => part.text), ["第一条"]);
  assert.equal(parts[0].role, "assistant");
  assert.equal(parts[0].metadata.confirmation, "sent");
});

test("does not turn outbound status prose into assistant speech", () => {
  const events = [
    { seq: 1, type: "tool/call", data: { name: "qq_send_message", callId: "send", arguments: { message: "实际发送内容" } } },
    { seq: 2, type: "tool/result", data: { message: { source: { name: "qq_send_message", callId: "send" }, content: [{ type: "text", text: JSON.stringify({ ok: true, sent: 1, message: "sent" }) }] } } }
  ];
  assert.deepEqual(normalizeQqEvents(events).map((part) => part.text), ["实际发送内容"]);
});

test("QQ session detection is opt-in by header or tool event", () => {
  assert.equal(isQqBridgeSession({ header: { agentPreset: "qq-chat-v3" } }, []), true);
  assert.equal(isQqBridgeSession({ header: {} }, [{ data: { name: "qq_wait_for_messages" } }]), true);
  assert.equal(isQqBridgeSession({ header: {} }, [{ data: { name: "memory_search" } }]), false);
});
