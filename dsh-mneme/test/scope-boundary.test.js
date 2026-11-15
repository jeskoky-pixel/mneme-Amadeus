import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkspacePath, normalizeScope, resolveRequiredWorkspaceScope } from "../src/scope-boundary.js";

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
