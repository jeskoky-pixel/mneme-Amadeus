// 叙述条（#164 对齐，PR-4）测试。
// 覆盖：evidence 列迁移与透传（save/update/parse 回环）/ clusterByTag 纯函数
// （≥K 门槛、降序、cap）/ intersectEvidence（捏造 id 剔除、交空回落全簇）/
// dream 叙述阶段端到端（enabled 时第三次 LLM 调用、求交落库、source=narrative）/
// 默认关零调用 / 低于门槛零调用 / 注入排除（narrative 不进候选，dream 总览保留）。
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDreamScheduler } from "../src/dream.js";
import { clusterByTag, intersectEvidence } from "../src/dream/narratives.js";
import { testConfig } from "./helpers/test-config.js";

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig(config) });
  return { store, service };
}

function mockCtx(sequence, callsRef) {
  return {
    llm: {
      stream: async function* () {
        const step = sequence[callsRef.n] ?? { summary: "空转" };
        callsRef.n++;
        const text = step.decisions !== undefined ? JSON.stringify(step.decisions) : step.summary;
        yield { type: "text-delta", text };
        yield { type: "finish", reason: { kind: "ok" } };
      }
    },
    logger: { warn: () => {} }
  };
}

// ============================================================ store evidence 回环

test("evidence column roundtrips through save and update", () => {
  const { store, service } = setup();
  const ev = [{ memory_id: "m1", op: "support", at: "2026-09-17T00:00:00.000Z" }];
  const { memory } = service.saveWithDedupe({
    type: "summary", title: "叙述：部署", content: "叙述正文", source: "narrative", evidence: ev
  });
  assert.deepEqual(store.getById(memory.id).evidence, ev);
  const ev2 = [{ memory_id: "m2", op: "weaken", at: "2026-09-18T00:00:00.000Z" }];
  store.update(memory.id, { evidence: ev2 });
  assert.deepEqual(store.getById(memory.id).evidence, ev2);
  store.close();
});

test("rows without evidence parse to an empty array", () => {
  const { store, service } = setup();
  const { memory } = service.saveWithDedupe({ type: "project", title: "普通", content: "无证据" });
  assert.deepEqual(store.getById(memory.id).evidence, []);
  store.close();
});

// ============================================================ 纯函数

test("clusterByTag: threshold, size desc, cap", () => {
  const mems = [
    { id: "a", tags: ["部署"] }, { id: "b", tags: ["部署"] }, { id: "c", tags: ["部署"] },
    { id: "d", tags: ["检索"] }, { id: "e", tags: ["检索"] }, { id: "f", tags: ["检索"] },
    { id: "g", tags: ["检索"] }, { id: "h", tags: ["孤儿"] }, { id: "i", tags: [123] }
  ];
  const clusters = clusterByTag(mems, { minCluster: 3, cap: 1 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].tag, "检索");
  assert.equal(clusters[0].members.length, 4);
  const two = clusterByTag(mems, { minCluster: 3, cap: 3 });
  assert.deepEqual(two.map((c) => c.tag), ["检索", "部署"]);
});

test("intersectEvidence drops fabricated ids; empty falls back to all members", () => {
  const members = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(intersectEvidence(["a", "fabricated"], members), ["a"]);
  assert.deepEqual(intersectEvidence(["x", "y"], members), ["a", "b", "c"]);
  assert.deepEqual(intersectEvidence(undefined, members), ["a", "b", "c"]);
});

// ============================================================ dream 叙述阶段

function seedDeploy(store, service) {
  const mems = [];
  for (const t of ["发布", "回滚", "盯盘"]) {
    mems.push(service.saveWithDedupe({ type: "project", title: t, content: `${t}相关的事实记录。`, tags: ["部署"] }).memory);
  }
  service.saveWithDedupe({ type: "preference", title: "无关", content: "别的话题。", tags: ["其他"] });
  return mems;
}

test("narrative phase synthesizes per-topic bars with intersected evidence", async () => {
  const { store, service } = setup();
  const mems = seedDeploy(store, service);
  const callsRef = { n: 0 };
  const narrativeJson = JSON.stringify([
    { tag: "部署", content: "部署主题已积累三条事实：发布、回滚与盯盘均已闭环。", evidence: [mems[0].id, "fabricated-id"] }
  ]);
  const ctx = mockCtx([{ decisions: [] }, { summary: "总览叙述" }, { summary: narrativeJson }], callsRef);
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat", dreamNarrativeEnabled: true });
  assert.equal(result.narratives, 1, "one narrative stored");
  const bar = store.all().find((m) => m.source === "narrative");
  assert.ok(bar, "narrative row exists");
  assert.equal(bar.title, "叙述：部署");
  assert.equal(bar.type, "summary");
  assert.equal(bar.evidence.length, 1, "fabricated id dropped by intersection");
  assert.equal(bar.evidence[0].memory_id, mems[0].id);
  assert.equal(bar.evidence[0].op, "support");
  store.close();
});

test("required workspace dream narratives exclude another workspace", async () => {
  const workspaceA = "C:\\Workspaces\\A";
  const workspaceB = "C:\\Workspaces\\B";
  const { store, service } = setup({ workspaceScopeRequired: true, scopeEnabled: true });
  const byWorkspace = new Map();
  for (const [workspace, prefix] of [[workspaceA, "A"], [workspaceB, "B"]]) {
    const rows = [];
    for (const title of ["发布", "回滚", "盯盘"]) {
      rows.push(service.saveWithDedupe({
        type: "project", title: `${prefix}-${title}`, content: `${prefix} 工作区的部署事实。`, tags: ["部署"],
        workspace_scope: workspace, workspace_scope_source: "auto"
      }).memory);
    }
    byWorkspace.set(workspace, rows);
  }
  // The latest stamped workspace is the bounded dream context in the current
  // scheduler; make A the active workspace after seeding both buckets.
  service.saveWithDedupe({ type: "project", title: "A-最新", content: "A 仍是当前工作区。", tags: ["其他"], workspace_scope: workspaceA, workspace_scope_source: "auto" });
  const callsRef = { n: 0 };
  const narrativeJson = JSON.stringify([{ tag: "部署", content: "A 工作区叙述", evidence: byWorkspace.get(workspaceA).map((m) => m.id) }]);
  const ctx = mockCtx([{ decisions: [] }, { summary: "A 总览" }, { summary: narrativeJson }], callsRef);
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat", dreamNarrativeEnabled: true, workspaceScopeRequired: true });
  assert.equal(result.narratives, 1);
  const bar = store.all().find((m) => m.source === "narrative");
  assert.equal(bar.workspace_scope, "c:\\workspaces\\a");
  assert.deepEqual(bar.evidence.map((item) => item.memory_id).sort(), byWorkspace.get(workspaceA).map((m) => m.id).sort());
  store.close();
});

test("narrative phase off by default: no extra LLM call", async () => {
  const { store, service } = setup();
  seedDeploy(store, service);
  const callsRef = { n: 0 };
  const ctx = mockCtx([{ decisions: [] }, { summary: "总览叙述" }], callsRef);
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat" });
  assert.equal(callsRef.n, 2, "only consolidation + summary calls");
  assert.equal(store.all().filter((m) => m.source === "narrative").length, 0);
  store.close();
});

test("below minCluster threshold: no narrative call even when enabled", async () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "project", title: "甲", content: "c", tags: ["部署"] });
  service.saveWithDedupe({ type: "project", title: "乙", content: "c", tags: ["部署"] });
  const callsRef = { n: 0 };
  const ctx = mockCtx([{ decisions: [] }, { summary: "总览叙述" }], callsRef);
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await dream.runDream(ctx, service, { dreamProvider: "deepseek", dreamModel: "deepseek-chat", dreamNarrativeEnabled: true });
  assert.equal(callsRef.n, 2, "no narrative call without a qualifying cluster");
  store.close();
});

// ============================================================ 注入排除

test("narrative dedupes by tag across language switches (no duplicate row)", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "summary", title: "叙述：部署", content: "中文叙述", importance: 3, source: "narrative", tags: ["部署"] });
  // generateNarratives 落库恒走 _overwrite（标题=主题键，原地刷新）。
  service.saveWithDedupe({ type: "summary", title: "Narrative: 部署", content: "English narrative", importance: 3, source: "narrative", tags: ["部署"], _overwrite: true });
  const bars = store.all().filter((m) => m.source === "narrative");
  assert.equal(bars.length, 1, "language switch must not create a duplicate narrative row");
  assert.equal(bars[0].title, "Narrative: 部署", "row refreshes to the new language title");
  assert.equal(bars[0].content, "English narrative");
  store.close();
});

test("narrative bars are on-demand: excluded from injection, reachable via search", async () => {
  const { store, service } = setup({ dreamNarrativeEnabled: false });
  service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: "当前状态叙述", importance: 5, source: "dream" });
  service.saveWithDedupe({ type: "summary", title: "叙述：部署", content: "部署主题的事实聚合，含部署关键词。", importance: 3, source: "narrative" });
  const candidates = service.injectCandidates({ query: "", maxItems: 5 });
  const ids = new Set(candidates.map((c) => c.id));
  const overview = store.all().find((m) => m.source === "dream");
  const bar = store.all().find((m) => m.source === "narrative");
  assert.ok(ids.has(overview.id), "dream overview stays resident-injectable");
  assert.ok(!ids.has(bar.id), "per-topic narrative excluded from injection");
  const rows = await service.searchMemories("部署", { mode: "keyword" });
  assert.ok(rows.some((r) => r.id === bar.id), "narrative reachable via search");
  store.close();
});
