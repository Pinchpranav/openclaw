// @ts-ignore — re-export chain is broken for external consumers (pinned-sdk.md §1)
import { dispatchGatewayMethod } from "@openclaw/plugin-sdk/gateway-method-runtime";

/** Result wrapper mirroring the inbox plugin's dispatch helper. */
export type Result<T> = { ok: true; payload: T } | { ok: false; error: string };

/** Internal helper: call a gateway method and normalize to Result<T>. */
async function dispatch<T>(method: string, params: unknown): Promise<Result<T>> {
  try {
    const result = await dispatchGatewayMethod(method, params, { expectFinal: true });
    // dispatchGatewayMethod returns the full GatewayMethodDispatchResponse envelope:
    // { ok: boolean, payload?: unknown, error?: GatewayMethodDispatchError, meta?: Record<string, unknown> }
    // We need to unwrap the inner payload.
    if (!result.ok) {
      return { ok: false, error: result.error?.message ?? "Gateway method failed" };
    }
    return { ok: true, payload: result.payload as T };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Trim the gateway agent row to only what the Project Management view needs.
 * Full GatewayAgentRow has: id, name, identity, workspace, model, agentRuntime, thinkingLevels, thinkingOptions, thinkingDefault.
 * We keep only: id, name, identity?.emoji
 */
function trimAgentRow(row: any): { id: string; name?: string; identity?: { emoji?: string } } {
  return {
    id: row.id,
    name: row.name,
    identity: row.identity ? { emoji: row.identity.emoji } : undefined,
  };
}

/**
 * Trim the gateway session row to only what the Project Management view needs.
 * Full GatewaySessionRow has: key, displayName, label, category, channel, updatedAt, archived, pinned, status, hasActiveRun, pluginExtensions.
 * We keep only: key, displayName, label, updatedAt, archived
 */
function trimSessionRow(row: any): {
  key: string;
  displayName?: string;
  label?: string;
  updatedAt: number | null;
  archived?: boolean;
} {
  return {
    key: row.key,
    displayName: row.displayName,
    label: row.label,
    updatedAt: row.updatedAt ?? null,
    archived: row.archived,
  };
}

// ─── READ ────────────────────────────────────────────────────────────────

/** List all agents (projects). */
export async function listAgents(): Promise<
  Result<{ id: string; name?: string; identity?: { emoji?: string } }[]>
> {
  const res = await dispatch<any>("agents.list", {});
  if (!res.ok) return res;
  // res.payload is the gateway method's inner payload (after unwrap in dispatch).
  // Shape: { agents: [...] } OR (if ever unwrapped further) [...] directly.
  const agents = Array.isArray(res.payload) ? res.payload : (res.payload?.agents ?? []);
  return { ok: true, payload: agents.map(trimAgentRow) };
}

/** List all sessions across all projects (single call, no agentId filter). */
export async function listSessions(): Promise<
  Result<{ key: string; displayName?: string; label?: string; updatedAt: number | null; archived?: boolean }[]>
> {
  const res = await dispatch<any>("sessions.list", { includeDerivedTitles: true });
  if (!res.ok) return res;
  // res.payload is the gateway method's inner payload (after unwrap in dispatch).
  // Shape: { sessions: [...] } OR (if ever unwrapped further) [...] directly.
  const sessions = Array.isArray(res.payload) ? res.payload : (res.payload?.sessions ?? []);
  return { ok: true, payload: sessions.map(trimSessionRow) };
}

// ─── WRITE ────────────────────────────────────────────────────────────────

/** Create a new agent = new project. No model/workspace (gateway auto-creates). */
export async function createAgent(
  name: string,
  emoji?: string
): Promise<Result<{ id: string }>> {
  const res = await dispatch<any>("agents.create", { name, emoji });
  if (!res.ok) return res;
  return { ok: true, payload: { id: res.payload?.id ?? "" } };
}

/** Create a new session (thread) in a project. No message param — new sessions have no messages. */
export async function createSession(
  agentId: string,
  opts?: { label?: string }
): Promise<Result<{ key: string }>> {
  const res = await dispatch<any>("sessions.create", { agentId, label: opts?.label });
  if (!res.ok) return res;
  return { ok: true, payload: { key: res.payload?.key ?? "" } };
}

/** Fork a session onto a different agent (for MOVE). Preserves transcript, new key. */
export async function createSessionFork(
  destAgentId: string,
  parentSessionKey: string
): Promise<Result<{ key: string }>> {
  const res = await dispatch<any>("sessions.create", {
    agentId: destAgentId,
    fork: true,
    parentSessionKey,
  });
  if (!res.ok) return res;
  return { ok: true, payload: { key: res.payload?.key ?? "" } };
}

/** Delete a session + its transcript (for MOVE cleanup). */
export async function deleteSession(key: string): Promise<Result<void>> {
  const res = await dispatch<any>("sessions.delete", { key, deleteTranscript: true });
  if (!res.ok) return res;
  return { ok: true, payload: undefined };
}