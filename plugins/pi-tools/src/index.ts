// pi-tools plugin entry.
//
// Currently exposes only `pi_read`. Future phases add `pi_bash`, `pi_edit`,
// `pi_write` — all via `api.registerTool(factoryFn)` from this single entry.
//
// Design choices baked in (locked from minimax-m2.7 port plan + real pi source):
//   - cwd resolved at PLUGIN LOAD time. Throws if cwd missing (matches pi).
//   - Vision gate resolved at register time via `api.config` lookup of the
//     active model's `inputModalities`. Default ON when unresolvable.
//   - Plugin config schema declared for `cwd`, `maxOutputLines`,
//     `maxOutputBytes`, `enableImageReads` per T5 contract.

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
// @ts-ignore — re-export chain is broken for external consumers
import { definePluginEntry } from "@openclaw/plugin-sdk/plugin-entry";
// @ts-ignore — re-export chain is broken for external consumers
import type { AnyAgentTool } from "@openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./pi-config.ts";
import { createPiReadTool } from "./pi-read.ts";

/**
 * Walk OpenClaw's runtime config to find the active model's `inputModalities`.
 * Returns `true` if the resolved model accepts image inputs (or if we cannot
 * tell — default-on is the safer UX for `pi_read`).
 */
function resolveModelSupportsVision(apiConfig: unknown, modelId: string | undefined): boolean {
	if (!modelId) return true;

	try {
		// Loose walk — config shape varies across versions. We only need
		// to know "does this model list image in its input modalities?".
		const candidates: any[] = [];

		// models.providers[providerId].models[modelId] shape
		const providers = (apiConfig as any)?.models?.providers;
		if (providers && typeof providers === "object") {
			for (const providerEntry of Object.values(providers) as any[]) {
				const models = providerEntry?.models;
				if (models && typeof models === "object") {
					if (modelId in models) {
						candidates.push(models[modelId]);
					}
				}
			}
		}

		// models[modelId] shape (legacy + agent override)
		const topModels = (apiConfig as any)?.models;
		if (topModels && typeof topModels === "object" && modelId in topModels) {
			candidates.push(topModels[modelId]);
		}

		for (const entry of candidates) {
			const modalities =
				entry?.inputModalities ?? entry?.modalities?.input ?? entry?.capabilities?.input;
			if (Array.isArray(modalities)) {
				if (modalities.some((m: unknown) => typeof m === "string" && m.toLowerCase().includes("image"))) {
					return true;
				}
				if (modalities.some((m: unknown) => typeof m === "string" && m.toLowerCase().includes("text"))) {
					// Has explicit text modality — if no image modality listed, no vision.
					return false;
				}
			}
		}
	} catch {
		// Fall through to default-on.
	}

	// Default-on when we cannot tell — better UX than silently dropping images.
	return true;
}

export default definePluginEntry({
	id: "pi-tools",
	name: "pi-tools",
	description:
		"Ports of pi-coding-agent's read/bash/edit/write tools. Currently exposes `pi_read` only.",
	configSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			cwd: {
				type: "string",
				description:
					"Working directory for tool execution. Defaults to PI_CWD env, then workspaceDir, then /data/workspace.",
			},
			maxOutputLines: {
				type: "number",
				description: "Max text lines before truncation (default 2000).",
			},
			maxOutputBytes: {
				type: "number",
				description: "Max text bytes before truncation (default 51200 = 50KB).",
			},
			enableImageReads: {
				type: "boolean",
				description:
					"When false, `pi_read` always returns text-only (no image content blocks). Default true.",
			},
		},
	},
	register(api: any) {
		// Resolve cwd once at load time. Throw if missing — matches pi exactly.
		const pluginCfg = (api.pluginConfig ?? {}) as Parameters<typeof resolveConfig>[0];
		const env = api.runtime?.env ?? process.env;
		const resolvedCwd = resolveConfig(pluginCfg, env, api.runtime?.workspaceDir);
		const cwd = resolvePath(resolvedCwd.cwd);
		if (!existsSync(cwd)) {
			// Exact wording matches pi's `getShellConfig` error path so users
			// get a familiar message whether they hit bash or read first.
			throw new Error(
				`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
			);
		}

		// Resolve vision gate at register time. The active model id is
		// available via `api.config.agents.defaults.model.primary` (and per-agent
		// overrides). We snapshot it once here; if the user switches models
		// later, the gate stays as-resolved until plugin reload.
		const agentsDefaults = (api.config as any)?.agents?.defaults;
		const activeModelId: string | undefined =
			typeof agentsDefaults?.model?.primary === "string"
				? agentsDefaults.model.primary
				: undefined;
		const cfgSupportsVision = resolveModelSupportsVision(api.config, activeModelId);
		const enableImageReads = pluginCfg?.enableImageReads !== false;
		const modelSupportsVision = cfgSupportsVision && enableImageReads;

		api.logger.info(
			`[pi-tools] cwd=${cwd} activeModel=${activeModelId ?? "<unknown>"} vision=${modelSupportsVision}`,
		);

		const tool: AnyAgentTool = createPiReadTool(cwd, {
			modelSupportsVision,
		}) as unknown as AnyAgentTool;

		api.registerTool(tool);
	},
});