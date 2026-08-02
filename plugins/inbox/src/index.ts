// Inbox plugin entry.
//
// Registers the Control UI "Inbox" tab (Path A panel), serves the panel + API
// over HTTP, and registers /done /waiting /defer /active slash commands that
// mutate the SAME JSON store the panel reads/writes.
//
// Verified SDK signatures — see wayfinder/sidebar-inbox/pinned-sdk.md:
//   - tab:       api.session.controls.registerControlUiDescriptor({...})  (grouped ns; flat is deprecated)
//   - http:      api.registerHttpRoute({ path, auth, handler })            (NOT registerPluginHttpRoute)
//   - auth:      "gateway" (valid values only "gateway" | "plugin" — NOT "session")
//   - commands:  api.registerCommand({ name, description, acceptsArgs, handler })  (NOT registerHook("command"))
//   - import:    definePluginEntry from "@openclaw/plugin-sdk/plugin-entry" (broken re-export chain → @ts-ignore)

// @ts-ignore — re-export chain is broken for external consumers (see pinned-sdk.md §1)
import { definePluginEntry } from "@openclaw/plugin-sdk/plugin-entry";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load, save, defaultStore, type InboxStore, type InboxItem } from "./store.ts";

const DEFAULT_STORE_PATH = "/data/.openclaw/inbox.json";
const DEFAULT_SNOOZE_PRESETS_MIN = [60, 360, 1440, 10080]; // 1h / 6h / 1d / 7d

function nowIso(): string {
	return new Date().toISOString();
}

/** Add minutes to now → ISO string (for defer presets). */
function addMinutesIso(minutes: number): string {
	return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** Read the store path from plugin config, defaulting to the manifest default. */
function resolveStorePath(api: any): string {
	const cfg = (api.pluginConfig ?? {}) as { storePath?: string };
	return typeof cfg.storePath === "string" && cfg.storePath ? cfg.storePath : DEFAULT_STORE_PATH;
}

function resolveSnoozePresets(api: any): number[] {
	const cfg = (api.pluginConfig ?? {}) as { snoozePresets?: number[] };
	if (Array.isArray(cfg.snoozePresets) && cfg.snoozePresets.length > 0) {
		return cfg.snoozePresets.map((n) => Number(n)).filter((n) => Number.isFinite(n));
	}
	return DEFAULT_SNOOZE_PRESETS_MIN;
}

/** Load the store for the given api (path resolved from plugin config). */
function readStore(api: any): InboxStore {
	return load(resolveStorePath(api));
}

/** Find an item by title substring or session id (used by slash commands). */
function findItem(store: InboxStore, needle: string): InboxItem | undefined {
	const q = needle.trim().toLowerCase();
	if (!q) return undefined;
	return store.items.find((it) => it.id.toLowerCase() === q || it.title.toLowerCase().includes(q));
}

/**
 * Shared state-mutation helper for slash commands (build-draft §5).
 * `changes` are lifecycle-field deltas applied to a matched item:
 *   { settledAt, archivedAt, snoozedUntil, snoozedAt }
 * Returns a human-readable result string for the command result.
 */
function setState(api: any, needle: string, changes: Partial<Pick<InboxItem, "settledAt" | "archivedAt" | "snoozedUntil" | "snoozedAt">>): string {
	const store = readStore(api);
	const item = findItem(store, needle);
	if (!item) {
		return `No inbox item matched "${needle}".`;
	}
	Object.assign(item, changes, { updatedAt: nowIso() });
	save(resolveStorePath(api), store);
	return `Inbox item "${item.title}" updated.`;
}

// --- HTTP handlers ---------------------------------------------------------

/** Serve the panel HTML (and its external panel.js) at /plugins/inbox/panel. */
function servePanel(_req: unknown, res: any): void {
	const htmlPath = resolve(new URL(import.meta.url).pathname, "..", "panel.html");
	const html = readFileSync(htmlPath, "utf8");
	res.setHeader?.("Content-Type", "text/html; charset=utf-8");
	res.end?.(html);
}

/** Serve panel.js at /plugins/inbox/panel.js (kept separate from the HTML). */
function servePanelJs(_req: unknown, res: any): void {
	const jsPath = resolve(new URL(import.meta.url).pathname, "..", "panel.js");
	const js = readFileSync(jsPath, "utf8");
	res.setHeader?.("Content-Type", "text/javascript; charset=utf-8");
	res.end?.(js);
}

/**
 * API handler at /plugins/inbox/api.
 * GET  → return the store JSON.
 * POST → apply a state mutation { op:"setState", itemId, changes }.
 */
function handleApi(req: any, res: any): void {
	const storePath = resolveStorePath(apiRef);
	const method = (req?.method ?? "GET").toUpperCase();

	if (method === "GET") {
		res.setHeader?.("Content-Type", "application/json; charset=utf-8");
		res.end?.(JSON.stringify(readStore(apiRef)));
		return;
	}

	if (method === "POST") {
		let body = "";
		req.on?.("data", (chunk: Buffer) => (body += chunk.toString()));
		req.on?.("end", () => {
			try {
				const payload = JSON.parse(body || "{}") as {
					op?: string;
					itemId?: string;
					changes?: Partial<Pick<InboxItem, "settledAt" | "archivedAt" | "snoozedUntil" | "snoozedAt">>;
				};
				if (payload.op !== "setState" || !payload.itemId || !payload.changes) {
					res.statusCode = 400;
					res.setHeader?.("Content-Type", "application/json; charset=utf-8");
					res.end?.(JSON.stringify({ error: "Expected { op:'setState', itemId, changes }" }));
					return;
				}
				const store = load(storePath);
				const item = store.items.find((it) => it.id === payload.itemId);
				if (!item) {
					res.statusCode = 404;
					res.setHeader?.("Content-Type", "application/json; charset=utf-8");
					res.end?.(JSON.stringify({ error: "Item not found" }));
					return;
				}
				Object.assign(item, payload.changes, { updatedAt: nowIso() });
				save(storePath, store);
				res.setHeader?.("Content-Type", "application/json; charset=utf-8");
				res.end?.(JSON.stringify({ ok: true, item }));
			} catch (err) {
				res.statusCode = 500;
				res.setHeader?.("Content-Type", "application/json; charset=utf-8");
				res.end?.(JSON.stringify({ error: String(err) }));
			}
		});
		return;
	}

	res.statusCode = 405;
	res.end?.("Method not allowed");
}

// The API handler needs the resolved store path, so we stash a reference set at
// register time (kept module-level so handleApi has access without re-reading config).
let apiRef: any = null;

export default definePluginEntry({
	id: "inbox",
	name: "Inbox",
	description: "Projects → 4-state conversation inbox for OpenClaw.",
	configSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			storePath: {
				type: "string",
				description: `Path to the inbox JSON store. Default ${DEFAULT_STORE_PATH}.`,
			},
			snoozePresets: {
				type: "array",
				items: { type: "number" },
				description: `Defer presets in minutes. Default ${DEFAULT_SNOOZE_PRESETS_MIN.join(", ")}.`,
			},
		},
	},
	register(api: any) {
		apiRef = api;
		const presets = resolveSnoozePresets(api);
		api.logger?.info(`[inbox] store=${resolveStorePath(api)} snoozePresets=[${presets.join(",")}]min`);

		// 1. Control UI tab (grouped namespace — flat is deprecated). pinned-sdk.md §2.
		api.session?.controls?.registerControlUiDescriptor?.({
			surface: "tab",
			id: "inbox",
			label: "Inbox",
			description: "Projects → 4-state conversation inbox.",
			icon: "inbox",
			group: "control",
			order: 10,
			path: "/plugins/inbox/panel", // gateway HTTP route rendered in a sandboxed frame
		});

		// 2a. Panel HTML route. auth:"gateway" (NOT "session"). pinned-sdk.md §3.
		api.registerHttpRoute?.({
			path: "/plugins/inbox/panel",
			auth: "gateway",
			handler: servePanel,
		});
		// Serve panel.js as a sibling same-origin route so the frame can load it.
		api.registerHttpRoute?.({
			path: "/plugins/inbox/panel.js",
			auth: "gateway",
			handler: servePanelJs,
		});
		// 2b. API route (GET store / POST mutate). auth:"gateway". pinned-sdk.md §3.
		api.registerHttpRoute?.({
			path: "/plugins/inbox/api",
			auth: "gateway",
			handler: handleApi,
		});

		// 3. Slash commands — each delegates to the shared setState helper. pinned-sdk.md §4.
		api.registerCommand?.({
			name: "done",
			description: "Mark item done (settled + archived).",
			acceptsArgs: true,
			handler: (ctx: any) => setState(api, String(ctx?.args ?? ""), {
				settledAt: nowIso(),
				archivedAt: nowIso(),
				snoozedUntil: null,
			}),
		});
		api.registerCommand?.({
			name: "waiting",
			description: "Snooze item (set snoozedUntil) using the first defer preset.",
			acceptsArgs: true,
			handler: (ctx: any) => setState(api, String(ctx?.args ?? ""), {
				snoozedUntil: addMinutesIso(presets[0] ?? 60),
				snoozedAt: nowIso(),
				settledAt: null,
				archivedAt: null,
			}),
		});
		api.registerCommand?.({
			name: "defer",
			description: "Alias for /waiting — snooze item using the first defer preset.",
			acceptsArgs: true,
			handler: (ctx: any) => setState(api, String(ctx?.args ?? ""), {
				snoozedUntil: addMinutesIso(presets[0] ?? 60),
				snoozedAt: nowIso(),
				settledAt: null,
				archivedAt: null,
			}),
		});
		api.registerCommand?.({
			name: "active",
			description: "Move item back to Active (clear settle/snooze/archive).",
			acceptsArgs: true,
			handler: (ctx: any) => setState(api, String(ctx?.args ?? ""), {
				settledAt: null,
				archivedAt: null,
				snoozedUntil: null,
				snoozedAt: null,
			}),
		});
	},
});

// Keep an unused reference to defaultStore to avoid dead-import lint noise;
// it documents the default shape for consumers of store.ts.
void defaultStore;
