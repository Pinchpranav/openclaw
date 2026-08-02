// Inbox JSON store — minimal load/save module.
//
// Store shape follows build-draft.md §3 (mirrors T3Code's projection_threads):
//   {
//     "version": 1,
//     "projects": [ { id, title, createdAt, updatedAt } ],
//     "items": [ { id, projectId, title, createdAt, updatedAt,
//                  archivedAt, settledAt, snoozedUntil, snoozedAt } ]
//   }
//
// Derived display buckets (no 4th-state enum — T3Code two-axis model):
//   Active 🔴 = not settled, not snoozed (or snoozedUntil passed)
//   Waiting 🟡 = snoozedUntil in the future
//   Parked ⚪ = settled but not archived (will return)
//   Done   ✅ = settled + archived (history)
//
// See wayfinder/sidebar-inbox/build-draft.md §3 for the data-model rationale.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export interface Project {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
}

export interface InboxItem {
	id: string;
	projectId: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** ISO timestamp (or null) when the item was settled (parked/done). */
	archivedAt: string | null;
	/** ISO timestamp (or null) when the item was settled — parked/done share this axis. */
	settledAt: string | null;
	/** ISO timestamp (or null) in the future while the item is snoozed (waiting). */
	snoozedUntil: string | null;
	/** ISO timestamp (or null) when it was last snoozed. */
	snoozedAt: string | null;
}

export interface InboxStore {
	version: number;
	projects: Project[];
	items: InboxItem[];
}

/** Default empty store (build-draft §3). */
export function defaultStore(): InboxStore {
	return { version: 1, projects: [], items: [] };
}

/**
 * Load the store from `path`. If the file is missing or unreadable, return a
 * default empty store (first write will create the file). Does not throw on a
 * missing store — the inbox should bootstrap to empty, not crash.
 */
export function load(path: string): InboxStore {
	try {
		if (!existsSync(path)) {
			return defaultStore();
		}
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<InboxStore>;
		// Defensive: tolerate a partial/corrupt file by falling back per-section.
		return {
			version: typeof parsed.version === "number" ? parsed.version : 1,
			projects: Array.isArray(parsed.projects) ? (parsed.projects as Project[]) : [],
			items: Array.isArray(parsed.items) ? (parsed.items as InboxItem[]) : [],
		};
	} catch (err) {
		// Corrupt JSON etc. — start empty rather than crash the plugin.
		console.error(`[inbox] failed to load store at ${path}:`, err);
		return defaultStore();
	}
}

/**
 * Persist `store` to `path` atomically: write to a temp sibling file then
 * rename over the target, so a crash mid-write never leaves a truncated store.
 */
export function save(path: string, store: InboxStore): void {
	const dir = dirname(path);
	if (dir && dir !== ".") {
		mkdirSync(dir, { recursive: true });
	}
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
	renameSync(tmp, path);
}
