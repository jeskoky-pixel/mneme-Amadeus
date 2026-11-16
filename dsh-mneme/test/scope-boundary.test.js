import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkspacePath, normalizeScope, resolveRequiredWorkspaceScope } from "../src/scope-boundary.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { testConfig } from "./helpers/test-config.js";

test("normalizes Windows workspace paths consistently on any host", () => {
  assert.equal(normalizeWorkspacePath("C:/Work/../Amadeus/"), "c:\\amadeus");
  assert.equal(normalizeWorkspacePath("c:\\AMADEUS\\"), "c:\\amadeus");
  assert.equal(normalizeWorkspacePath("/tmp/demo/../x/"), "\\tmp\\x");
});

test("required scope fails closed when session workspace is missing", () => {
  const config = { workspaceScopeRequired: true };
  const ctx = { workspaceRegistry: { list: () => [] } };
  assert.equal(resolveRequiredWorkspaceScope({ ctx, config, session: { id: "s", header: {} } }).ok, false);
  assert.deepEqual(normalizeScope({ agent_scope: "qq", workspace_scope: "C:/Work" }), { agent_scope: "qq", workspace_scope: "c:\\work" });
});

test("required scope accepts registry workspace and canonicalizes it", () => {
  const result = resolveRequiredWorkspaceScope({
    ctx: { workspaceRegistry: { list: () => [{ path: "C:/Work", sessionIds: ["s"] }] } },
    config: { workspaceScopeRequired: true },
    session: { id: "s", header: { cwd: "C:/other" } }
  });
  assert.equal(result.ok, true);
  assert.equal(result.scope.workspace_scope, "c:\\work");
});

test("required mode rejects unscoped service writes but permits explicit global", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: testConfig({ workspaceScopeRequired: true }) });
  assert.throws(
    () => service.saveWithDedupe({ type: "project", title: "无作用域", content: "不应静默落全局" }),
    /workspace scope is required/
  );
  assert.throws(
    () => service.saveWithDedupe({ type: "project", title: "自动空作用域", content: "不应伪装全局", workspace_scope: null, workspace_scope_source: "auto" }),
    /workspace scope is required/
  );
  assert.throws(
    () => service.saveWithDedupe({ type: "project", title: "自动 global 路径", content: "不应伪装全局", workspace_scope: "global", workspace_scope_source: "auto" }),
    /workspace scope is required/
  );
  const global = service.saveWithDedupe({ type: "project", title: "显式全局", content: "明确共享", workspace_scope: null, workspace_scope_source: "explicit" }).memory;
  assert.equal(global.workspace_scope ?? null, null);
  store.close();
});
