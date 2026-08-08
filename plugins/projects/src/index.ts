// @ts-ignore — re-export chain is broken for external consumers (pinned-sdk.md §1)
import { definePluginEntry } from "@openclaw/plugin-sdk/plugin-entry";
import { load, save, mutate, resolveStorePath, type ProjectsAndSessionsStore, setSessionState, setNoInbox, setProjectState } from "./store.ts";
import {
  listAgents,
  listSessions,
  createAgent,
  createSession,
  createSessionFork,
  deleteSession,
  type Result,
} from "./gateway.ts";

/** Parse session key `agent:<projectId>:<thread>` → extract projectId. */
function parseAgentIdFromKey(key: string): string | null {
  const parts = key.split(":");
  if (parts.length >= 2 && parts[0] === "agent") {
    return parts[1];
  }
  return null;
}

export default definePluginEntry({
  id: "projects",
  name: "Project Management",
  description:
    "Agent-based projects (one agent = one project) with 3-state (active/deferred/done) conversation lifecycle + noInbox exceptions, backed by a plugin-owned JSON store.",
  activation: { onStartup: true },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      storePath: {
        type: "string",
        description: "Path to the projects JSON state store. Default /data/.openclaw/projects.json",
      },
    },
  },
  contracts: { gatewayMethodDispatch: ["authenticated-request"] },

  register(api: any) {
    const storePath = resolveStorePath(api);
    api.logger?.info?.(`[projects] store=${storePath}`);

    // ─── HTTP ROUTE: /plugins/projects/api ─────────────────────────────
    api.registerHttpRoute?.({
      path: "/plugins/projects/api",
      auth: "gateway",
      // Dispatch gateway methods (agents.create/sessions.create/...) with the
      // plugin's trusted-operator scopes (incl. operator.admin) so createProject
      // can call agents.create. Plugins are admin-installed, so this is trusted.
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: async (req: any, res: any) => {
        const method = (req?.method ?? "GET").toUpperCase();

        if (method === "GET") {
          try {
            // Load state store
            const state = load(storePath);

            // Fetch agents + sessions from gateway
            const [agentsRes, sessionsRes] = await Promise.all([
              listAgents(),
              listSessions(),
            ]);

            if (!agentsRes.ok || !sessionsRes.ok) {
              const err = agentsRes.ok ? (sessionsRes as { ok: false; error: string }).error : (agentsRes as { ok: false; error: string }).error;
              res.statusCode = 500;
              res.setHeader?.("Content-Type", "application/json; charset=utf-8");
              res.end?.(JSON.stringify({ ok: false, error: err }));
              return;
            }

            // Enrich sessions with parsed agentId
            const enrichedSessions = sessionsRes.payload.map((s) => ({
              ...s,
              agentId: parseAgentIdFromKey(s.key),
            }));

            res.setHeader?.("Content-Type", "application/json; charset=utf-8");
            res.end?.(
              JSON.stringify({
                ok: true,
                state,
                agents: agentsRes.payload,
                sessions: enrichedSessions,
              })
            );
          } catch (err) {
            res.statusCode = 500;
            res.setHeader?.("Content-Type", "application/json; charset=utf-8");
            res.end?.(JSON.stringify({ ok: false, error: String(err) }));
          }
          return;
        }

        if (method === "POST") {
          // Read the request body as an awaited promise so the gateway-method
          // dispatch below runs INSIDE the route's async request scope (the
          // `req.on("end")` callback would otherwise fire after the handler
          // returns and the plugin request scope is gone).
          const body = await new Promise<string>((resolve) => {
            let data = "";
            req.on?.("data", (chunk: any) => (data += chunk.toString()));
            req.on?.("end", () => resolve(data));
            req.on?.("error", () => resolve(data));
          });
          try {
            const payload = JSON.parse(body || "{}") as {
                op?: string;
                key?: string;
                state?: "active" | "deferred" | "done";
                value?: boolean;
                agentId?: string;
                name?: string;
                emoji?: string;
                label?: string;
                destAgentId?: string;
              };

              if (payload.op === "setSessionState") {
                if (!payload.key || !payload.state) {
                  res.statusCode = 400;
                  res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                  res.end?.(
                    JSON.stringify({ ok: false, error: "setSessionState requires key and state" })
                  );
                  return;
                }
                await mutate(storePath, (s) => setSessionState(s, payload.key!, payload.state!));
                res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                res.end?.(JSON.stringify({ ok: true }));
                return;
              }

              if (payload.op === "setNoInbox") {
                if (!payload.key || typeof payload.value !== "boolean") {
                  res.statusCode = 400;
                  res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                  res.end?.(
                    JSON.stringify({ ok: false, error: "setNoInbox requires key and boolean value" })
                  );
                  return;
                }
                await mutate(storePath, (s) => setNoInbox(s, payload.key!, payload.value!));
                res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                res.end?.(JSON.stringify({ ok: true }));
                return;
              }

              if (payload.op === "setProjectState") {
                if (!payload.agentId || !payload.state) {
                  res.statusCode = 400;
                  res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                  res.end?.(
                    JSON.stringify({ ok: false, error: "setProjectState requires agentId and state" })
                  );
                  return;
                }
                await mutate(storePath, (s) => setProjectState(s, payload.agentId!, payload.state!));
                res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                res.end?.(JSON.stringify({ ok: true }));
                return;
              }

              // ─── Gateway ops (need dispatchGatewayMethod via gateway.ts) ───
              if (payload.op === "createProject") {
                if (!payload.name) {
                  res.statusCode = 400;
                  res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                  res.end?.(
                    JSON.stringify({ ok: false, error: "createProject requires name" })
                  );
                  return;
                }
                const createRes = await createAgent(payload.name, payload.emoji);
                if (!createRes.ok) {
                  res.statusCode = 500;
                  res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                  res.end?.(JSON.stringify({ ok: false, error: createRes.error }));
                  return;
                }
                res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                res.end?.(JSON.stringify({ ok: true, project: createRes.payload }));
                return;
              }

              if (payload.op === "createThread") {
                if (!payload.agentId) {
                  res.statusCode = 400;
                  res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                  res.end?.(
                    JSON.stringify({ ok: false, error: "createThread requires agentId" })
                  );
                  return;
                }
                const createRes = await createSession(payload.agentId, {
                  label: payload.label,
                });
                if (!createRes.ok) {
                  res.statusCode = 500;
                  res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                  res.end?.(JSON.stringify({ ok: false, error: createRes.error }));
                  return;
                }
                res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                res.end?.(JSON.stringify({ ok: true, session: createRes.payload }));
                return;
              }

              if (payload.op === "moveThread") {
                if (!payload.key || !payload.destAgentId) {
                  res.statusCode = 400;
                  res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                  res.end?.(
                    JSON.stringify({ ok: false, error: "moveThread requires key and destAgentId" })
                  );
                  return;
                }
                // CRITICAL ORDER: fork → delete old → carry state
                // 1. Fork onto destination agent
                const forkRes = await createSessionFork(payload.destAgentId, payload.key);
                if (!forkRes.ok) {
                  res.statusCode = 500;
                  res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                  res.end?.(JSON.stringify({ ok: false, error: forkRes.error }));
                  return;
                }
                const newKey = forkRes.payload.key;

                // 2. Delete old session + transcript
                const deleteRes = await deleteSession(payload.key);
                if (!deleteRes.ok) {
                  // If delete fails, we have a zombie duplicate. Log and return error.
                  api.logger?.error?.(
                    `[projects] moveThread: delete failed for ${payload.key} after fork to ${newKey}: ${deleteRes.error}`
                  );
                  res.statusCode = 500;
                  res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                  res.end?.(
                    JSON.stringify({
                      ok: false,
                      error: `Move failed: old session not deleted (zombie at ${newKey})`,
                    })
                  );
                  return;
                }

                // 3. Carry state in store: sessions[newKey] = sessions[oldKey], then delete old
                await mutate(storePath, (s) => {
                  const oldEntry = s.sessions[payload.key!];
                  if (oldEntry) {
                    s.sessions[newKey] = { ...oldEntry };
                    delete s.sessions[payload.key!];
                  }
                });

                res.setHeader?.("Content-Type", "application/json; charset=utf-8");
                res.end?.(JSON.stringify({ ok: true, newKey }));
                return;
              }

              res.statusCode = 400;
              res.setHeader?.("Content-Type", "application/json; charset=utf-8");
              res.end?.(JSON.stringify({ ok: false, error: `Unknown op: ${payload.op}` }));
          } catch (err) {
            res.statusCode = 500;
            res.setHeader?.("Content-Type", "application/json; charset=utf-8");
            res.end?.(JSON.stringify({ ok: false, error: String(err) }));
          }
          return;
        }

        res.statusCode = 405;
        res.end?.("Method not allowed");
      },
    });

    // ─── SLASH COMMANDS (store-only, no gateway) ───────────────────────
    // /defer → setSessionState(ctx.sessionKey, "deferred")
    api.registerCommand?.({
      name: "defer",
      description: "Defer the current session (set state to deferred).",
      acceptsArgs: false,
      handler: async (ctx: any) => {
        const sessionKey = ctx?.sessionKey;
        if (!sessionKey) return "No active session.";
        await mutate(storePath, (s) => setSessionState(s, sessionKey, "deferred"));
        return `Session ${sessionKey} → deferred.`;
      },
    });

    // /done → setSessionState(ctx.sessionKey, "done")
    api.registerCommand?.({
      name: "done",
      description: "Mark the current session done.",
      acceptsArgs: false,
      handler: async (ctx: any) => {
        const sessionKey = ctx?.sessionKey;
        if (!sessionKey) return "No active session.";
        await mutate(storePath, (s) => setSessionState(s, sessionKey, "done"));
        return `Session ${sessionKey} → done.`;
      },
    });

    // /active → setSessionState(ctx.sessionKey, "active")
    api.registerCommand?.({
      name: "active",
      description: "Set the current session back to active.",
      acceptsArgs: false,
      handler: async (ctx: any) => {
        const sessionKey = ctx?.sessionKey;
        if (!sessionKey) return "No active session.";
        await mutate(storePath, (s) => setSessionState(s, sessionKey, "active"));
        return `Session ${sessionKey} → active.`;
      },
    });

    // /setNoInbox → setNoInbox(ctx.sessionKey, value) — accepts true|false
    api.registerCommand?.({
      name: "setNoInbox",
      description: "Toggle noInbox flag on the current session. Usage: /setNoInbox true|false",
      acceptsArgs: true,
      handler: async (ctx: any) => {
        const sessionKey = ctx?.sessionKey;
        if (!sessionKey) return "No active session.";
        const args = String(ctx?.args ?? "").trim().toLowerCase();
        const value = args === "true" || args === "1" || args === "yes";
        await mutate(storePath, (s) => setNoInbox(s, sessionKey, value));
        return `Session ${sessionKey} noInbox = ${value}.`;
      },
    });

    // NOTE: no /move command — move is a panel-only hover button (Pranav 2026-08-06)
    // NOTE: no /newproject — project creation is a panel button
  },
});