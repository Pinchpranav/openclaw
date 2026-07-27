// Shared plugin configuration for the pi-tools plugin.
//
// Resolves the cwd once at plugin load (per the T5 contract) and exposes
// the truncation limits used by both pi_read and pi_bash.

import { existsSync } from "node:fs";

export type PiToolsConfig = {
  cwd: string;
  maxOutputLines: number;
  maxOutputBytes: number;
  enableImageReads: boolean;
};

export const DEFAULT_CWD = "/data/workspace";
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export function resolveConfig(
  raw: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  workspaceDir?: string,
): PiToolsConfig {
  const envCwd = env.PI_CWD;
  const rawCwd = typeof raw?.cwd === "string" && raw.cwd.length > 0 ? raw.cwd : undefined;
  const candidate = rawCwd ?? envCwd ?? workspaceDir ?? DEFAULT_CWD;
  // Per T5: do not auto-mkdir; if the cwd does not exist, throw pi's exact
  // error on first tool invocation. For now we just verify and let the cwd
  // property reflect what we will use — actual error happens in the tool.
  const cwd = candidate;
  return {
    cwd,
    maxOutputLines: typeof raw?.maxOutputLines === "number" && raw.maxOutputLines > 0
      ? raw.maxOutputLines
      : DEFAULT_MAX_LINES,
    maxOutputBytes: typeof raw?.maxOutputBytes === "number" && raw.maxOutputBytes > 0
      ? raw.maxOutputBytes
      : DEFAULT_MAX_BYTES,
    enableImageReads: raw?.enableImageReads !== false,
  };
}

export function ensureCwdExists(cwd: string): void {
  if (!existsSync(cwd)) {
    // Match pi's exact wording from T5:
    //   "Working directory does not exist: <path>\nCannot execute bash commands."
    throw new Error(
      `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
    );
  }
}
