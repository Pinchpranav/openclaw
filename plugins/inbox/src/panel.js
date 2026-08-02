// Inbox panel logic (vanilla JS — no framework, no build step).
// Loaded from /plugins/inbox/panel.html via <script src="/plugins/inbox/panel.js">.
//
// Data path: same-origin fetch to the gateway-served API:
//   GET  /plugins/inbox/api  → store JSON
//   POST /plugins/inbox/api  → { op:"setState", itemId, changes } mutation
//
// MVP (build-draft §10): polling for updates, no WebSocket push, no drag-drop,
// no bulk ops. Calm sorting: rows hold their position until a lifecycle
// transition (T3Code two-axis model).

const API = "/plugins/inbox/api";
const POLL_MS = 5000;

const PRESETS = [
	{ label: "Defer 1h", minutes: 60 },
	{ label: "Defer 6h", minutes: 360 },
	{ label: "Defer Tomorrow", minutes: 1440 },
	{ label: "Defer Next Week", minutes: 10080 },
];

// ---------------------------------------------------------------------------
// AUTH — reads the gateway bearer token from sessionStorage (documented path)
// ---------------------------------------------------------------------------
// The panel is served by the gateway at /plugins/inbox/panel inside a
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
// ---------------------------------------------------------------------------

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
			// Scope suffix looks like https://host[/path] — match the host part.
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

/** Fetch the full store from the API. */
async function fetchStore() {
	const res = await fetch(API, { headers: authHeaders() });
	if (!res.ok) throw new Error(`GET ${API} → ${res.status}`);
	return await res.json();
}

/** Mutate an item's lifecycle fields. changes is a partial field map. */
async function setState(itemId, changes) {
	const res = await fetch(API, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders() },
		body: JSON.stringify({ op: "setState", itemId, changes }),
	});
	if (!res.ok) throw new Error(`POST ${API} → ${res.status}`);
	return await res.json();
}

// --- Derived state buckets (build-draft §3) --------------------------------
// Active 🔴 = not settled, not snoozed (or snoozedUntil passed)
// Waiting 🟡 = snoozedUntil in the future
// Parked ⚪ = settled but not archived (will return)
// Done   ✅ = settled + archived (history)

function deriveBucket(item) {
	const now = Date.now();
	const snoozedInFuture = item.snoozedUntil && new Date(item.snoozedUntil).getTime() > now;
	if (snoozedInFuture) return "waiting";
	if (item.settledAt && item.archivedAt) return "done";
	if (item.settledAt) return "parked";
	return "active";
}

function bucketLabel(b) {
	return { active: "Active", waiting: "Waiting", parked: "Parked", done: "Done" }[b];
}

function waitHint(item) {
	if (!item.snoozedUntil) return "";
	const until = new Date(item.snoozedUntil);
	const mins = Math.max(0, Math.round((until.getTime() - Date.now()) / 60000));
	if (mins < 60) return `${mins}m`;
	if (mins < 1440) return `${Math.round(mins / 60)}h`;
	return `${Math.round(mins / 1440)}d`;
}

// --- Rendering -------------------------------------------------------------

/** Current store snapshot (cache for calm-sorted re-renders). */
let store = { version: 1, projects: [], items: [] };

function renderStatus(msg) {
	document.getElementById("status").textContent = msg;
}

function render() {
	const root = document.getElementById("projects");
	root.textContent = "";

	if (!store.projects.length && !store.items.length) {
		root.innerHTML = '<div class="empty">Inbox is empty.</div>';
		return;
	}

	for (const project of store.projects) {
		const items = store.items.filter((it) => it.projectId === project.id);
		const bucketOrder = ["active", "waiting", "parked", "done"];
		const grouped = {};
		for (const b of bucketOrder) grouped[b] = [];
		for (const it of items) grouped[deriveBucket(it)].push(it);

		const section = document.createElement("section");
		section.className = "project";
		const head = document.createElement("div");
		head.className = "project-head";
		head.innerHTML = `<span class="caret">▾</span><span class="title"></span><span class="count"></span>`;
		head.querySelector(".title").textContent = project.title;
		head.querySelector(".count").textContent = `${items.length} items`;
		head.addEventListener("click", () => section.classList.toggle("collapsed"));

		const body = document.createElement("div");
		body.className = "project-body";

		for (const b of bucketOrder) {
			const list = grouped[b];
			if (!list.length) continue;
			const st = document.createElement("div");
			st.className = "shelf-title";
			st.textContent = bucketLabel(b);
			body.appendChild(st);
			for (const it of list) body.appendChild(itemRow(it, b));
		}

		section.appendChild(head);
		section.appendChild(body);
		root.appendChild(section);
	}
}

function itemRow(item, bucket) {
	const row = document.createElement("div");
	row.className = `item ${bucket}`;
	row.dataset.id = item.id;

	const dot = document.createElement("span");
	dot.className = "dot";

	const label = document.createElement("span");
	label.className = "label";
	label.textContent = item.title;

	row.appendChild(dot);
	row.appendChild(label);

	if (bucket === "waiting") {
		const hint = document.createElement("span");
		hint.className = "wait-hint";
		hint.textContent = waitHint(item);
		row.appendChild(hint);
	}

	row.appendChild(actionMenu(item));
	return row;
}

/** Per-row actions dropdown (build-draft §6). */
function actionMenu(item) {
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

	function addAction(labelText, changes) {
		const b = document.createElement("button");
		b.textContent = labelText;
		b.addEventListener("click", async () => {
			wrap.classList.remove("open");
			renderStatus(`updating “${item.title}”…`);
			try {
				await setState(item.id, changes);
				await refresh();
			} catch (err) {
				renderStatus(`error: ${err.message}`);
			}
		});
		dd.appendChild(b);
	}

	addAction("Mark Done", { settledAt: iso(), archivedAt: iso(), snoozedUntil: null, snoozedAt: null });
	for (const p of PRESETS) {
		addAction(p.label, { snoozedUntil: iso(Date.now() + p.minutes * 60000), snoozedAt: iso(), settledAt: null, archivedAt: null });
	}
	addAction("Set Active", { settledAt: null, archivedAt: null, snoozedUntil: null, snoozedAt: null });

	wrap.appendChild(btn);
	wrap.appendChild(dd);
	return wrap;
}

function iso(ts) {
	return new Date(ts ?? Date.now()).toISOString();
}

/** Poll refresh — MVP uses polling (no WebSocket push, build-draft §10). */
async function refresh() {
	try {
		store = await fetchStore();
		render();
		renderStatus(`updated ${new Date().toLocaleTimeString()}`);
	} catch (err) {
		renderStatus(`load failed: ${err.message}`);
	}
}

// Boot
refresh();
setInterval(refresh, POLL_MS);
