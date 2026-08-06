import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Shape of the plugin-owned JSON state store.
 * Holds both project state and session state in a single file.
 */
export interface ProjectsAndSessionsStore {
  version: 1;
  /** Keyed by agentId (project = agent). Value is the project state (flat string). */
  projects: Record<string, ProjectState>;
  /** Keyed by sessionKey ("agent:<projectId>:<thread>"). */
  sessions: Record<string, { state: SessionState; noInbox?: boolean }>;
}

export type ProjectState = "active" | "deferred" | "done";
export type SessionState = "active" | "deferred" | "done";

/** Default empty store. */
export function defaultStore(): ProjectsAndSessionsStore {
  return { version: 1, projects: {}, sessions: {} };
}

/**
 * Load the store from `path`. If the file is missing or corrupt, return a
 * default empty store (never throws).
 */
export function load(path: string): ProjectsAndSessionsStore {
  try {
    if (!existsSync(path)) {
      return defaultStore();
    }
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectsAndSessionsStore>;
    // Defensive: tolerate a partial/corrupt file by falling back per-section.
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      projects: parsed.projects && typeof parsed.projects === "object" ? (parsed.projects as Record<string, ProjectState>) : {},
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? (parsed.sessions as Record<string, { state: SessionState; noInbox?: boolean }>) : {},
    };
  } catch (err) {
    console.error(`[projects] failed to load store at ${path}:`, err);
    return defaultStore();
  }
}

/**
 * Persist `store` to `path` atomically: write to a temp sibling file then
 * rename over the target, so a crash mid-write never leaves a truncated store.
 */
export function save(path: string, store: ProjectsAndSessionsStore): void {
  const dir = dirname(path);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, path);
}

/** Get project state, default "active". */
export function getProjectState(store: ProjectsAndSessionsStore, agentId: string): ProjectState {
  return store.projects[agentId] ?? "active";
}

/** Set project state, creating entry if missing. */
export function setProjectState(store: ProjectsAndSessionsStore, agentId: string, state: ProjectState): void {
  store.projects[agentId] = state;
}

/** Get session state, default "active". */
export function getSessionState(store: ProjectsAndSessionsStore, key: string): SessionState {
  return store.sessions[key]?.state ?? "active";
}

/** Set session state, creating entry if missing. */
export function setSessionState(store: ProjectsAndSessionsStore, key: string, state: SessionState): void {
  store.sessions[key] ??= { state: "active" };
  store.sessions[key].state = state;
}

/** Set noInbox flag, creating entry if missing. Absent = false (in inbox). Only ever store true explicitly. */
export function setNoInbox(store: ProjectsAndSessionsStore, key: string, value: boolean): void {
  store.sessions[key] ??= { state: "active" };
  if (value) {
    store.sessions[key].noInbox = true;
  } else {
    // Explicitly unset by deleting the property (absent = false)
    delete store.sessions[key].noInbox;
  }
}

/**
 * In-process async lock for store mutations.
 * Ensures load → mutate → save runs as a single critical section
 * so slash commands and HTTP route never clobber each other.
 */
let storeLock: Promise<void> = Promise.resolve();

/**
 * Execute a mutation on the store atomically.
 * @param path Path to the store file
 * @param fn Receives the loaded store, mutates it in place
 * @returns The mutated store (after save)
 */
export async function mutate<T>(
  path: string,
  fn: (store: ProjectsAndSessionsStore) => T | Promise<T>
): Promise<{ store: ProjectsAndSessionsStore; result: T }> {
  // Queue this mutation behind any in-flight one
  const mutation = storeLock.then(async () => {
    const store = load(path);
    const result = await fn(store);
    save(path, store);
    return { store, result };
  });

  storeLock = mutation.then(() => {}); // keep the chain going
  return mutation;
}

/**
 * Resolve the store path from plugin config, with default fallback.
 * Mirrors the inbox plugin's resolveStorePath pattern.
 */
export function resolveStorePath(api: { pluginConfig?: { storePath?: string } }): string {
  return api.pluginConfig?.storePath ?? "/data/.openclaw/projects.json";
}