// Projects panel logic (vanilla JS — no framework, no build step).
// Loaded from /plugins/projects/panel.html via <script src="/plugins/projects/panel.js">.
//
// Data path: same-origin fetch to the gateway-served API:
//   GET  /plugins/projects/api  → { ok, state, agents, sessions }
//   POST /plugins/projects/api  → mutations (see index.ts for ops)
//
// MVP: polling for updates, no WebSocket push, no drag-drop, no bulk ops.

const API = "/plugins/projects/api";
const POLL_MS = 5000;
const INBOX_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

// ---------------------------------------------------------------------------
// AUTH — reads the gateway bearer token from sessionStorage (mirrors inbox panel)
// ---------------------------------------------------------------------------
// The panel is served by the gateway at /plugins/projects/panel inside a
// sandboxed frame (embedSandbox:"trusted" → allow-scripts allow-same-origin).
// With allow-same-origin, the frame shares origin with the Control UI, so it
// can read the gateway token the Control UI keeps in sessionStorage.
//
// Documented facts (verified 2026-08-02):
//   - docs/web/dashboard.md: "The Control UI keeps it in sessionStorage for
//     the current tab and selected gateway URL, not localStorage."
//   - ui/src/app/settings.ts: token persisted under
//       `openclaw.control.token.v1:` + normalizeGatewayTokenScope(gatewayUrl)
//       where scope = <protocol>//<host><pathname-no-trailing-slash>
//   - ui/src/app/gateway-scope.ts: normalizeGatewayTokenScope()
//
// Because the gateway token is scoped per normalized gateway URL, and the
// panel can't perfectly reconstruct the dashboard's exact pathname, we scan
// sessionStorage for any `openclaw.control.token.v1:*` key whose normalized
// host matches this frame's host. For a single-gateway setup (claw.pranavself.uk)
// this reliably finds the dashboard's token. The panel then sends it as the
// standard Authorization: Bearer header the gateway expects for auth:"gateway"
// routes (src/gateway/http-auth-utils.ts getBearerToken).

const TOKEN_SESSION_PREFIX = "openclaw.control.token.v1:";

/** Read the gateway bearer token from sessionStorage (same-origin frame). */
function readGatewayToken() {
  try {
    const storage = window.sessionStorage;
    if (!storage) return null;
    const host = window.location.host;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !key.startsWith(TOKEN_SESSION_PREFIX)) continue;
      const scope = key.slice(TOKEN_SESSION_PREFIX.length);
      try {
        const url = new URL(scope);
        if (url.host === host) return storage.getItem(key);
      } catch {
        // Malformed scope — skip.
      }
    }
  } catch {
    // sessionStorage unavailable — return null.
  }
  return null;
}

/** @type {string | null} */
let TOKEN = null;

try {
  TOKEN = readGatewayToken();
} catch {
  TOKEN = null;
}

function authHeaders() {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/** Fetch the full merged view from the API. */
async function fetchView() {
  const res = await fetch(API, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET ${API} → ${res.status}`);
  return await res.json();
}

/** Generic POST to the API. */
async function post(op, payload) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ op, ...payload }),
  });
  if (!res.ok) throw new Error(`POST ${API} → ${res.status}`);
  return await res.json();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function sessionName(s) {
  return s.displayName || s.label || s.key;
}

function isInInbox(s, sessionState) {
  // Inbox = active + touched within 48h + not noInbox
  // updatedAt null → treated as recent (included)
  if (sessionState !== "active") return false;
  if (sessionState.noInbox === true) return false;
  const updatedAt = s.updatedAt ?? 0;
  if (updatedAt === 0) return true; // null/unknown → treated as recent
  return Date.now() - updatedAt <= INBOX_WINDOW_MS;
}

function projectStateLabel(state) {
  return { active: "Active", deferred: "Deferred", done: "Done" }[state] || state;
}

function sessionStateLabel(state) {
  return { active: "Active", deferred: "Deferred", done: "Done" }[state] || state;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Current view snapshot (cache for re-renders). */
let view = { state: { projects: {}, sessions: {} }, agents: [], sessions: [] };

function render() {
  const root = document.getElementById("root");
  root.textContent = "";

  // ─── INBOX SECTION ──────────────────────────────────────────────────
  const inboxSessions = view.sessions
    .filter((s) => {
      const ss = view.state.sessions[s.key];
      return isInInbox(s, ss);
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const inboxSection = document.createElement("section");
  inboxSection.className = "section";
  inboxSection.innerHTML = `
    <div class="section-head">
      <span class="caret">▾</span>
      <span class="title">Inbox</span>
      <span class="count">${inboxSessions.length} active (last 48h)</span>
    </div>
    <div class="section-body"></div>
  `;
  const inboxHead = inboxSection.querySelector(".section-head");
  const inboxBody = inboxSection.querySelector(".section-body");
  inboxHead.addEventListener("click", () => inboxSection.classList.toggle("collapsed"));

  if (inboxSessions.length === 0) {
    inboxBody.innerHTML = '<div class="empty">No active sessions in the last 48h.</div>';
  } else {
    for (const s of inboxSessions) {
      inboxBody.appendChild(inboxRow(s, view.state.sessions[s.key]));
    }
  }
  root.appendChild(inboxSection);

  // ─── PROJECT SECTIONS ───────────────────────────────────────────────
  for (const agent of view.agents) {
    const projectId = agent.id;
    const projectState = view.state.projects[projectId] || "active";
    const projectSessions = view.sessions.filter((s) => s.agentId === projectId);

    const section = document.createElement("section");
    section.className = "section";
    section.innerHTML = `
      <div class="section-head">
        <span class="caret">▾</span>
        <span class="title">${agent.name || projectId}</span>
        <span class="project-state ${projectState}">${projectStateLabel(projectState)}</span>
        <span class="count">${projectSessions.length} sessions</span>
      </div>
      <div class="section-body"></div>
    `;
    const head = section.querySelector(".section-head");
    const body = section.querySelector(".section-body");
    head.addEventListener("click", () => section.classList.toggle("collapsed"));

    if (projectSessions.length === 0) {
      body.innerHTML = '<div class="empty">No sessions in this project.</div>';
    } else {
      for (const s of projectSessions) {
        body.appendChild(sessionRow(s, view.state.sessions[s.key], agent));
      }
    }
    root.appendChild(section);
  }
}

function inboxRow(session, sessionState) {
  const row = document.createElement("div");
  row.className = `session-row ${sessionState?.state || "active"}`;
  row.dataset.key = session.key;

  const dot = document.createElement("span");
  dot.className = "state-dot";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = sessionName(session);

  const badge = document.createElement("span");
  badge.className = "noinbox-badge" + (sessionState?.noInbox === true ? " on" : "");
  badge.textContent = sessionState?.noInbox === true ? "noInbox" : "";

  row.appendChild(dot);
  row.appendChild(name);
  row.appendChild(badge);
  row.appendChild(actionMenu(session, sessionState));

  return row;
}

function sessionRow(session, sessionState, agent) {
  const row = document.createElement("div");
  row.className = `session-row ${sessionState?.state || "active"}`;
  row.dataset.key = session.key;

  const dot = document.createElement("span");
  dot.className = "state-dot";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = sessionName(session);

  const badge = document.createElement("span");
  badge.className = "noinbox-badge" + (sessionState?.noInbox === true ? " on" : "");
  badge.textContent = sessionState?.noInbox === true ? "noInbox" : "";

  row.appendChild(dot);
  row.appendChild(name);
  row.appendChild(badge);
  row.appendChild(actionMenu(session, sessionState, agent));

  return row;
}

/** Per-row actions dropdown. */
function actionMenu(session, sessionState, agent) {
  const wrap = document.createElement("div");
  wrap.className = "menu";

  const btn = document.createElement("button");
  btn.className = "action";
  btn.textContent = "⋯";
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    wrap.classList.toggle("open");
  });

  const dd = document.createElement("div");
  dd.className = "dropdown";

  // State actions
  const states = ["active", "deferred", "done"];
  for (const st of states) {
    const b = document.createElement("button");
    b.textContent = `Set ${st.charAt(0).toUpperCase() + st.slice(1)}`;
    if (sessionState?.state === st) b.style.color = "var(--muted)";
    b.addEventListener("click", async () => {
      wrap.classList.remove("open");
      renderStatus(`setting ${sessionName(session)} → ${st}…`);
      try {
        await post("setSessionState", { key: session.key, state: st });
        await refresh();
      } catch (err) {
        renderStatus(`error: ${err.message}`);
      }
    });
    dd.appendChild(b);
  }

  // noInbox toggle
  const noInboxBtn = document.createElement("button");
  noInboxBtn.textContent = sessionState?.noInbox === true
    ? "Remove from noInbox"
    : "Add to noInbox (exclude from Inbox)";
  noInboxBtn.addEventListener("click", async () => {
    wrap.classList.remove("open");
    const value = sessionState?.noInbox !== true;
    renderStatus(`${value ? "adding" : "removing"} noInbox…`);
    try {
      await post("setNoInbox", { key: session.key, value });
      await refresh();
    } catch (err) {
      renderStatus(`error: ${err.message}`);
    }
  });
  dd.appendChild(noInboxBtn);

  // Move button (hover button on row also triggers this via moveBtn click)
  const moveDivider = document.createElement("hr");
  dd.appendChild(moveDivider);

  const moveBtn = document.createElement("button");
  moveBtn.textContent = "Move to project…";
  moveBtn.addEventListener("click", () => {
    wrap.classList.remove("open");
    pickProject(session, agent);
  });
  dd.appendChild(moveBtn);

  wrap.appendChild(btn);
  wrap.appendChild(dd);
  return wrap;
}

/** Inline project picker for moving a session. */
async function pickProject(session, currentAgent) {
  const agents = view.agents.filter((a) => a.id !== currentAgent.id);
  if (agents.length === 0) {
    renderStatus("No other projects to move to.");
    return;
  }

  const options = agents.map((a) => `${a.name || a.id}`).join(", ");
  const title = prompt(
    `Move “${sessionName(session)}” to project:\n(enter the project name)\n\nAvailable: ${options}`
  );
  if (title === null) return; // cancelled

  const targetAgent = agents.find((a) => (a.name || a.id).toLowerCase() === title.trim().toLowerCase());
  if (!targetAgent) {
    renderStatus(`Project “${title}” not found.`);
    return;
  }

  renderStatus(`moving to ${targetAgent.name || targetAgent.id}…`);
  try {
    await post("moveThread", { key: session.key, destAgentId: targetAgent.id });
    await refresh();
  } catch (err) {
    renderStatus(`error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Header actions: New Project
// ---------------------------------------------------------------------------

document.getElementById("newProjectBtn")?.addEventListener("click", async () => {
  const name = prompt("New project name:");
  if (!name) return;
  const emoji = prompt("Emoji (optional):") || undefined;
  renderStatus(`creating project “${name}”…`);
  try {
    await post("createProject", { name, emoji });
    await refresh();
  } catch (err) {
    renderStatus(`error: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Poll refresh
// ---------------------------------------------------------------------------

async function refresh() {
  try {
    view = await fetchView();
    render();
    renderStatus(`updated ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    renderStatus(`load failed: ${err.message}`);
  }
}

// Boot
refresh();
setInterval(refresh, POLL_MS);