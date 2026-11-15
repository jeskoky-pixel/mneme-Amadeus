// Shared fail-closed boundary for workspace-aware integrations.
//
// Mneme's historical resolver is intentionally fail-open for ordinary DSH
// sessions: a missing header becomes an unscoped row.  QQ Bridge cannot use
// that default because a missing workspace would expose the whole database.
// This module keeps the legacy resolver intact and adds an opt-in required
// boundary for adapters that can prove their workspace.
import { normalize as normalizePath, win32 as win32Path } from "node:path";
import { createScopeResolver, scopeKeyOf } from "./scope.js";

export function normalizeWorkspacePath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let raw = value.trim();
  const drivePath = /^[A-Za-z]:[\\/]/.test(raw);
  const uncPath = /^\\\\/.test(raw);
  try {
    // The host running tests may be Linux even when the configured workspace
    // is a Windows path.  Normalise according to the path syntax we received,
    // not according to the host process.
    raw = /^[A-Za-z]:[\\/]/.test(raw) || raw.includes("\\")
      ? win32Path.normalize(raw)
      : normalizePath(raw);
  } catch { /* keep the trimmed path */ }
  raw = raw.replaceAll("/", "\\");
  if (drivePath && /^[A-Za-z]:\\$/.test(raw)) return `${raw[0].toLowerCase()}:\\`;
  raw = raw.replace(/[\\]+$/, "");
  // Windows drive letters are case-insensitive.  Lower-casing the rest only
  // on a drive path avoids changing case-sensitive POSIX workspace labels.
  if (/^[A-Za-z]:\\/.test(raw) || uncPath) raw = raw.toLowerCase();
  return raw || null;
}

export function normalizeScope(scope) {
  if (!scope || typeof scope !== "object") return null;
  const agent = scopeKeyOf(scope.agent_scope);
  const workspace = normalizeWorkspacePath(scope.workspace_scope);
  return agent || workspace ? { agent_scope: agent, workspace_scope: workspace } : null;
}

export function resolveRequiredWorkspaceScope({ ctx, config, session, logger } = {}) {
  const resolver = createScopeResolver({ ctx, config, logger });
  const resolved = normalizeScope(resolver({ agent: { session } }));
  if (!resolved?.workspace_scope) return { ok: false, scope: null, reason: "workspace-unresolved" };
  return { ok: true, scope: resolved, reason: null };
}

export function scopeMatchesWorkspace(memory, scope) {
  const expected = normalizeWorkspacePath(scope?.workspace_scope);
  if (!expected) return false;
  const actual = normalizeWorkspacePath(memory?.workspace_scope);
  return actual === expected;
}

export function requiredScopeAvailable(config, scope) {
  if (config?.workspaceScopeRequired !== true) return true;
  return Boolean(normalizeWorkspacePath(scope?.workspace_scope));
}
