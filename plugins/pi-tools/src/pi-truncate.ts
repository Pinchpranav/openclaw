// Output truncation helper — port of pi's `truncateHead` semantics used by
// both pi_read (text) and pi_bash (combined stdout/stderr).
//
// Reference: pi's `packages/coding-agent/src/core/utils/truncate.js`
//   DEFAULT_MAX_LINES = 2000
//   DEFAULT_MAX_BYTES  = 50 * 1024
//   truncates to the LAST N lines/bytes when the cap is exceeded.

import { randomBytes } from "node:crypto";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TruncateResult = {
  text: string;
  truncated: boolean;
  outputLines: number;
  totalLines: number;
  firstLineExceedsLimit: boolean;
  overflowPath?: string;
};

export type TruncateOptions = {
  maxLines: number;
  maxBytes: number;
  /** When set, the full output is written here on truncation. */
  overflowPath?: string;
};

/**
 * Truncate a string's tail to the configured line/byte cap. If truncation
 * occurs, the full output is written to a temp file and the return includes
 * a footer pointing at it.
 */
export function truncateHead(text: string, opts: TruncateOptions): TruncateResult {
  const totalLines = text.length === 0 ? 0 : text.split("\n").length;
  const maxBytes = Math.max(1, opts.maxBytes);
  const maxLines = Math.max(1, opts.maxLines);

  // Fast path: nothing to truncate.
  if (text.length <= maxBytes && totalLines <= maxLines) {
    return {
      text,
      truncated: false,
      outputLines: totalLines,
      totalLines,
      firstLineExceedsLimit: false,
    };
  }

  // Find the last `maxLines` lines.
  const lines = text.split("\n");
  const tailLines = lines.slice(-maxLines);
  let tail = tailLines.join("\n");

  // If still over the byte cap, byte-cap the tail (last `maxBytes` bytes).
  let byteTruncated = false;
  if (tail.length > maxBytes) {
    tail = tail.slice(tail.length - maxBytes);
    byteTruncated = true;
  }

  const firstLineExceedsLimit = lines.length > 0 && lines[0].length > maxBytes;

  // Write the full output to a temp file for full-context retrieval.
  const overflowPath = opts.overflowPath ?? join(tmpdir(), `pi-bash-${randomBytes(6).toString("hex")}.txt`);

  // We do best-effort async write but return synchronously — callers can
  // await finalizeTruncate() if they need to confirm the overflow exists.
  void writeFile(overflowPath, text, { mode: 0o600 }).catch(() => {
    /* swallow — overflow is best-effort */
  });

  const startLine = totalLines - tailLines.length + 1;
  const endLine = totalLines;
  const footer = `Showing lines ${startLine}-${endLine} of ${totalLines}. Full output: ${overflowPath}.`;
  const suppression = byteTruncated
    ? `[Output truncated to last ${maxBytes} bytes due to byte cap.]`
    : "";
  const finalText = `${suppression}${suppression ? "\n" : ""}${tail}\n${footer}`;

  return {
    text: finalText,
    truncated: true,
    outputLines: tailLines.length,
    totalLines,
    firstLineExceedsLimit,
    overflowPath,
  };
}

/**
 * Convenience wrapper that picks a temp dir + path, runs truncateHead,
 * and returns the result. The temp file is cleaned up via the returned
 * close() function.
 */
export async function truncateWithTempFile(
  text: string,
  maxLines: number,
  maxBytes: number,
): Promise<TruncateResult> {
  const dir = await mkdtemp(join(tmpdir(), "pi-tools-"));
  const overflowPath = join(dir, "output.txt");
  const result = truncateHead(text, {
    maxLines,
    maxBytes,
    overflowPath,
  });
  if (!result.truncated) {
    // Remove the empty dir we created.
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* ignore */
    });
    return result;
  }
  return result;
}
