// `pi_read` tool — port of pi-coding-agent's `read` tool for OpenClaw.
//
// Adapted from: /data/workspace/pi-source/packages/coding-agent/src/core/tools/read.ts
// Differences from upstream:
//   - Drops TUI rendering (renderCall/renderResult) — OpenClaw's tool runtime
//     handles its own presentation from `content` + `details`.
//   - Drops `getPiDocsClassification` (pi-internal compact classification).
//   - Drops `getCompactReadClassification` (uses pi's TUI keybinding hints).
//   - Drops `Model<Api>` import — vision-model gate is resolved at register time
//     by the plugin entry (see src/index.ts), not per-call.
//   - Returns raw `{type:"image", data, mimeType}` content blocks (no `imageResult`
//     helper) since OpenClaw's plugin-sdk doesn't expose that helper yet — see
//     src/index.ts for how `details.media.mediaUrl` is wired.
//
// Contract (from T1 + T5):
//   - cwd: resolved at plugin load, throw if missing.
//   - Schema: { path, offset?, limit? } (TypeBox, same as pi).
//   - Text: truncateHead + footer `[Showing lines A-B of N. Use offset=X to continue.]`
//   - Image: processImage → base64 + mime, return image content block when
//     model supports vision, else text-only with non-vision note.

import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { type Static, Type } from "typebox";
import { processImage } from "./pi-internals/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "./pi-internals/mime.ts";
import { resolveReadPathAsync } from "./pi-internals/path-utils.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "./pi-internals/truncate.ts";

// Minimal local definitions of AgentToolResult + content blocks.
// The OpenClaw plugin-sdk doesn't expose these via subpath exports today,
// and the agent-core subpath doesn't re-export TextContent/ImageContent
// either. These shapes are stable across versions — see
// /opt/openclaw/app/packages/agent-core/dist/types-3InKihRa.d.ts:380-396
// for the upstream definition we mirror.
interface TextContent {
	type: "text";
	text: string;
}
interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}
interface AgentToolResult<T> {
	content: (TextContent | ImageContent)[];
	details: T;
}

export const piReadSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type PiReadInput = Static<typeof piReadSchema>;

export interface PiReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true. */
	autoResizeImages?: boolean;
	/**
	 * Whether the active model can accept image inputs. Resolved at register
	 * time and frozen into the tool. If false, image files return text-only
	 * with a non-vision note appended.
	 */
	modelSupportsVision: boolean;
}

export interface PiReadToolDetails {
	path: string;
	truncation?: unknown;
}

const NON_VISION_NOTE =
	"[Current model does not support images. " +
	"The image will be omitted from this request.]";

function textBlock(text: string): TextContent {
	return { type: "text", text };
}

function imageBlock(data: string, mimeType: string): ImageContent {
	return { type: "image", data, mimeType };
}

export function createPiReadTool(
	cwd: string,
	options: PiReadToolOptions,
): {
	name: string;
	label: string;
	description: string;
	parameters: typeof piReadSchema;
	execute: (
		toolCallId: string,
		params: PiReadInput,
		signal?: AbortSignal,
	) => Promise<AgentToolResult<PiReadToolDetails>>;
} {
	const autoResizeImages = options.autoResizeImages ?? true;
	const visionSupported = options.modelSupportsVision;

	return {
		name: "pi_read",
		label: "pi_read",
		description:
			`Read the contents of a file. Supports text files and images ` +
			`(jpg, png, gif, webp, bmp). Images are sent as attachments. ` +
			`For text files, output is truncated to ${DEFAULT_MAX_LINES} lines ` +
			`or ${Math.round(DEFAULT_MAX_BYTES / 1024)}KB (whichever is hit first). ` +
			`Use offset/limit for large files. When you need the full file, ` +
			`continue with offset until complete.`,
		parameters: piReadSchema,
		async execute(toolCallId, params, signal) {
			const { path, offset, limit } = params;
			void toolCallId;

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const absolutePath = await resolveReadPathAsync(path, cwd);
			if (signal?.aborted) throw new Error("Operation aborted");

			await fsAccess(absolutePath, fsConstants.R_OK);
			if (signal?.aborted) throw new Error("Operation aborted");

			const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

			// IMAGE branch
			if (mimeType) {
				const buffer = await fsReadFile(absolutePath);
				const processed = await processImage(buffer, mimeType, { autoResizeImages });

				if (!processed.ok) {
					const note = !visionSupported ? `\n${NON_VISION_NOTE}` : "";
					return {
						content: [
							textBlock(
								`Read image file [${mimeType}]\n${processed.message}${note}`,
							),
						],
						details: { path: absolutePath },
					};
				}

				const hints: string[] = [];
				if (processed.hints.length > 0) hints.push(...processed.hints);
				if (!visionSupported) hints.push(NON_VISION_NOTE);

				const headerText =
					`Read image file [${processed.mimeType}]` +
					(hints.length > 0 ? `\n${hints.join("\n")}` : "");

				if (!visionSupported) {
					return {
						content: [textBlock(headerText)],
						details: { path: absolutePath },
					};
				}

				return {
					content: [
						textBlock(headerText),
						imageBlock(processed.data, processed.mimeType),
					],
					details: {
						path: absolutePath,
						media: { mediaUrl: absolutePath },
					},
				};
			}

			// TEXT branch
			const buffer = await fsReadFile(absolutePath);
			const textContent = buffer.toString("utf-8");
			const allLines = textContent.split("\n");
			const totalFileLines = allLines.length;
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			const startLineDisplay = startLine + 1;

			if (startLine >= allLines.length) {
				throw new Error(
					`Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
				);
			}

			let selectedContent: string;
			let userLimitedLines: number | undefined;
			if (limit !== undefined) {
				const endLine = Math.min(startLine + limit, allLines.length);
				selectedContent = allLines.slice(startLine, endLine).join("\n");
				userLimitedLines = endLine - startLine;
			} else {
				selectedContent = allLines.slice(startLine).join("\n");
			}

			const truncation = truncateHead(selectedContent);
			let outputText: string;
			let truncationDetails: unknown = undefined;

			if (truncation.firstLineExceedsLimit) {
				const firstLineSize = formatSize(
					Buffer.byteLength(allLines[startLine], "utf-8"),
				);
				outputText =
					`[Line ${startLineDisplay} is ${firstLineSize}, exceeds ` +
					`${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: ` +
					`sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				truncationDetails = { ...truncation };
			} else if (truncation.truncated) {
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				outputText = truncation.content;
				if (truncation.truncatedBy === "lines") {
					outputText +=
						`\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} ` +
						`of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
				} else {
					outputText +=
						`\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} ` +
						`of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). ` +
						`Use offset=${nextOffset} to continue.]`;
				}
				truncationDetails = { ...truncation };
			} else if (
				userLimitedLines !== undefined &&
				startLine + userLimitedLines < allLines.length
			) {
				const remaining = allLines.length - (startLine + userLimitedLines);
				const nextOffset = startLine + userLimitedLines + 1;
				outputText =
					`${truncation.content}\n\n[${remaining} more lines in file. ` +
					`Use offset=${nextOffset} to continue.]`;
			} else {
				outputText = truncation.content;
			}

			return {
				content: [textBlock(outputText)],
				details: { path: absolutePath, truncation: truncationDetails },
			};
		},
	};
}