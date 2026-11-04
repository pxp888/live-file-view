import { stat, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	estimateTokens,
	formatSize,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Live view file tool: open() / close() keep windows into files, and the current
 * contents of those windows are re-read from disk and appended to every request as
 * a trailing system message, so the model never rebuilds a file from old reads + diffs.
 */

interface LiveWindow {
	id: number;
	path: string; // absolute
	label: string; // shown to the model
	offset: number; // 1-based start line
	limit: number; // requested lines
	statKey: string; // "mtimeMs:size" at the last refresh, for drift detection
}

const windows: LiveWindow[] = [];
let nextWindowId = 1;
let blockTokens = 0; // live-view size measured by the last build
let compacting = false;
let compactionMarker = false; // say "an earlier read may be summarised away" once after each compaction

const RESERVE_TOKENS = DEFAULT_COMPACTION_SETTINGS.reserveTokens;

function tok(text: string): number {
	return estimateTokens({ role: "system", content: text, timestamp: Date.now() });
}

function budget(ctx: ExtensionContext) {
	const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 128000;
	const working = Math.max(1000, contextWindow - RESERVE_TOKENS);
	return { contextWindow, working, maxLive: Math.floor((working * 2) / 3) };
}

function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") ? rel : path;
}

async function readWindow(w: LiveWindow) {
	const buf = await readFile(w.path);
	const text = buf.toString("utf-8");
	if (text.includes("\u0000")) throw new Error(`${w.label} is not a plain text file`);
	const allLines = text.split("\n");
	const total = allLines.length;
	const startIdx = Math.max(0, w.offset - 1);
	const slice = allLines.slice(startIdx, Math.min(startIdx + w.limit, total));
	const trunc = truncateHead(slice.join("\n"));
	const st = await stat(w.path);
	return {
		total,
		startLine: startIdx + 1,
		// A byte cut drops whole lines from the end of the slice; report only the lines actually shown.
		endLine: startIdx + (trunc.truncated ? trunc.outputLines : slice.length),
		text: trunc.content,
		sizeCut: trunc.truncated,
		firstLineTooBig: trunc.firstLineExceedsLimit,
		empty: slice.length === 0,
		statKey: `${st.mtimeMs}:${st.size}`,
	};
}

/** Build the live-view block. commit=false measures the size of the current windows without touching drift state. */
async function buildBlock(ctx: ExtensionContext, commit = true) {
	const b = budget(ctx);
	const index: string[] = [];
	const chunks: string[] = [];
	let linesShown = 0;
	let usedTokens = 0;
	let skipped = 0;

	for (const w of windows) {
		let info;
		try {
			info = await readWindow(w);
		} catch (error) {
			info = { total: 0, startLine: w.offset, endLine: w.offset - 1, text: "", sizeCut: false, firstLineTooBig: false, empty: true, statKey: "", error: (error as Error).message };
		}
		const changed = commit && !info.error && info.statKey !== w.statKey;
		if (commit) w.statKey = info.statKey;

		let { startLine, endLine, text } = info;
		const flags: string[] = [];
		if (info.error) flags.push(`unreadable: ${info.error}`);
		if (changed) flags.push("file changed since last refresh");
		if (info.empty) flags.push("offset beyond end of file");
		if (info.firstLineTooBig) flags.push(`line ${startLine} is ${formatSize(DEFAULT_MAX_BYTES)}, over the read limit`);
		else if (info.sizeCut) flags.push(`cut at the ${formatSize(DEFAULT_MAX_BYTES)} read limit`);

		// Absolute cap: shrinking windows is the only lever left once the block itself is too big.
		let chunk = `${head(w, startLine, endLine, info.total, flags)}\n${text}\n<<</W${w.id}>>>`;
		let tokens = tok(chunk);
		if (usedTokens + tokens > b.maxLive) {
			const allowed = Math.max(0, (b.maxLive - usedTokens) * 4 - chunk.length + text.length);
			const kept: string[] = [];
			let chars = 0;
			for (const line of text.split("\n")) {
				if (chars + line.length + 1 > allowed) break;
				kept.push(line);
				chars += line.length + 1;
			}
			if (kept.length === 0 && !info.empty) {
				skipped++;
				continue;
			}
			text = kept.join("\n");
			endLine = startLine + kept.length - 1;
			flags.push("truncated to fit the live-view budget");
			chunk = `${head(w, startLine, endLine, info.total, flags)}\n${text}\n<<</W${w.id}>>>`;
			tokens = tok(chunk);
		}

		index.push(`  W${w.id}  ${w.label}   ${range(startLine, endLine, info.total)}`);
		chunks.push(chunk);
		linesShown += endLine - startLine + 1;
		usedTokens += tokens;
	}

	if (chunks.length === 0 && skipped === 0) return undefined;

	const lines = [
		"<<<<LIVE VIEW>>>>",
		"Contents below were re-read from disk before this request. Each window is the file",
		"as it is NOW: use it in place of any earlier read of that file in this conversation,",
		"and in place of rebuilding it from edit diffs.",
		"",
		`${chunks.length} window${chunks.length === 1 ? "" : "s"} · ${linesShown} lines shown · this block is ${Math.round((usedTokens / b.working) * 100)}% of the space left in this context`,
	];
	if (skipped > 0) lines.push(`${skipped} window(s) not shown: live-view budget exhausted. Close or shrink windows.`);
	if (compactionMarker) {
		lines.push("", "Note: an earlier read of these files may have been summarised away by compaction. The windows below are the live state.");
	}
	lines.push("", ...chunks.flatMap((c) => [c, ""]), "<<<<END LIVE VIEW>>>>");

	const text = lines.join("\n");
	if (commit) {
		blockTokens = tok(text);
		if (compactionMarker) compactionMarker = false;
	}
	return { text, tokens: tok(text), message: { role: "system" as const, content: text, timestamp: Date.now() } };
}

function range(startLine: number, endLine: number, total: number) {
	return endLine < startLine ? `no lines of ${total}` : `lines ${startLine}-${endLine} of ${total}`;
}

function head(w: LiveWindow, startLine: number, endLine: number, total: number, flags: string[]) {
	return `<<< W${w.id}  ${w.label}  ${range(startLine, endLine, total)}${flags.length ? ` (${flags.join(", ")})` : ""} >>>`;
}

function sizeReport(b: ReturnType<typeof budget>) {
	return `live view ~${blockTokens} tokens, cap ${b.maxLive} (2/3 of the ${b.working} token working space)`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		windows.length = 0;
		nextWindowId = 1;
		blockTokens = 0;
		compacting = false;
		compactionMarker = false;
	});

	pi.on("session_shutdown", () => {
		windows.length = 0;
	});

	pi.on("session_compact", () => {
		compactionMarker = true;
	});

	pi.on("context", async (event, ctx) => {
		if (windows.length === 0) return undefined;

		const block = await buildBlock(ctx);
		if (!block) return undefined;

		const b = budget(ctx);
		const contextTokens = ctx.getContextUsage()?.tokens ?? 0;
		if (!compacting && !ctx.isIdle() && (contextTokens > b.maxLive || contextTokens + blockTokens + RESERVE_TOKENS > b.contextWindow)) {
			compacting = true;
			ctx.compact({
				onComplete: () => {
					compacting = false;
				},
				onError: () => {
					compacting = false;
				},
			});
		}

		return { messages: [...event.messages, block.message] };
	});

	pi.registerTool({
		name: "open",
		label: "open",
		description:
			`Open a live window on a text file. Preferred over read(): the window is NOT written into the conversation, instead the current file contents are re-read from disk and appended to a LIVE VIEW block at the end of every request, so you always see the file as it is now, with no rebuilding from earlier reads or edit diffs. open(path, offset, limit) opens a new window; open(windowId, offset, limit) re-ranges an existing window, keeping its id. Returns a confirmation only (window id and range), never file contents. Same limits as read(): ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB, whichever comes first. Windows are released with close(), freeing the space a read() would burn permanently.`,
		promptSnippet: "Open a live-view window on a file (refreshed on every request)",
		promptGuidelines: [
			"Prefer open over read for any file you will edit or re-check: open() keeps a live copy of the file in the LIVE VIEW block instead of burning context, and close() releases it.",
			"Close or shrink open() windows when you no longer need them; the live view is capped and oversized windows force compaction.",
		],
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "File to open (relative or absolute). Omit when re-ranging an existing window." })),
			windowId: Type.Optional(Type.Number({ description: "Existing window id to re-range. Use with offset/limit only, no path." })),
			offset: Type.Optional(Type.Number({ description: "Line number to start the window at (1-indexed)" })),
			limit: Type.Optional(Type.Number({ description: `Maximum number of lines in the window (max ${DEFAULT_MAX_LINES})` })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
			const b = budget(ctx);

			if (params.windowId === undefined && !params.path) {
				return fail("open needs either path (new window) or windowId (re-range).");
			}

			let w: LiveWindow | undefined;
			let index = -1;
			// A re-range replaces its window in the block, so park it out of `windows` while
			// measuring: the gate then sees the block as it would be afterwards, with the new
			// range counted once. Any failure below restores the window and its old range.
			let restore = () => {};
			const bail = (text: string) => {
				restore();
				return fail(text);
			};
			if (params.windowId !== undefined) {
				index = windows.findIndex((x) => x.id === params.windowId);
				if (index < 0) return fail(`no window ${params.windowId}. Open windows: ${windows.map((x) => `W${x.id} ${x.label}`).join(", ") || "none"}`);
				w = windows[index];
				const prev = { ...w };
				windows.splice(index, 1);
				restore = () => {
					Object.assign(w, prev);
					windows.splice(index, 0, w);
				};
				if (params.path) w.label = displayPath((w.path = resolve(ctx.cwd, params.path)), ctx.cwd);
				w.offset = Math.max(1, params.offset ?? w.offset);
				w.limit = Math.min(DEFAULT_MAX_LINES, Math.max(1, params.limit ?? w.limit));
			} else {
				const path = resolve(ctx.cwd, params.path!);
				w = {
					id: nextWindowId++,
					path,
					label: displayPath(path, ctx.cwd),
					offset: Math.max(1, params.offset ?? 1),
					limit: Math.min(DEFAULT_MAX_LINES, Math.max(1, params.limit ?? DEFAULT_MAX_LINES)),
					statKey: "",
				};
			}

			let info;
			try {
				info = await readWindow(w);
			} catch (error) {
				return bail(`open failed: ${(error as Error).message}`);
			}
			if (info.empty) return bail(`open failed: offset ${w.offset} is beyond end of ${w.label} (${info.total} lines total).`);

			// Gate: the window must fit the live-view cap and leave a working context.
			const existing = (await buildBlock(ctx, false))?.tokens ?? 0;
			const windowTokens = tok(`${head(w, info.startLine, info.endLine, info.total, [])}\n${info.text}`);
			if (existing + windowTokens > b.maxLive) {
				return bail(
					`open failed: this window (~${windowTokens} tokens) would put the live view at ~${existing + windowTokens}, over the ${b.maxLive} token cap ((context window ${b.contextWindow} - ${RESERVE_TOKENS} reserve) * 2/3). Close windows with close(), or shrink them with open(windowId, offset, limit). Leaving the live view this big forces compaction of the conversation sooner.`,
				);
			}
			const contextTokens = ctx.getContextUsage()?.tokens ?? 0;
			if (contextTokens + existing + windowTokens + RESERVE_TOKENS > b.contextWindow) {
				return bail(
					`open failed: context (~${contextTokens}) + live view (~${existing + windowTokens}) + ${RESERVE_TOKENS} reserve exceeds the ${b.contextWindow} token context window. Close windows with close(), shrink them with open(windowId, offset, limit), or let the conversation compact first.`,
				);
			}

			if (index >= 0) windows.splice(index, 0, w);
			else windows.push(w);
			w.statKey = info.statKey;
			const block = await buildBlock(ctx);
			blockTokens = block?.tokens ?? 0;

			return {
				content: [
					{
						type: "text" as const,
						text: [
							`open successful - live-view window ${w.id}`,
							`${w.label}  ${range(info.startLine, info.endLine, info.total)}`,
							`window ~${windowTokens} tokens · ${sizeReport(b)}`,
							"The file contents are in the LIVE VIEW block of the next request; you do not need to read this file again.",
						].join("\n"),
					},
				],
				details: { windowId: w.id, path: w.path, startLine: info.startLine, endLine: info.endLine, totalLines: info.total },
			};
		},
	});

	pi.registerTool({
		name: "close",
		label: "close",
		description:
			"Close a live view window created by open(): it is removed from the LIVE VIEW block and its space in the context is freed. close(windowId) closes one window by id; close(path) works only when that file has exactly one window.",
		promptSnippet: "Close a live-view window and free its context",
		parameters: Type.Object({
			windowId: Type.Optional(Type.Number({ description: "Window id to close" })),
			path: Type.Optional(Type.String({ description: "File whose single open window to close (relative or absolute)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const b = budget(ctx);
			const before = blockTokens;
			const target = params.windowId ?? (params.path ? windows.find((x) => x.path === resolve(ctx.cwd, params.path!))?.id : undefined);

			if (params.windowId === undefined && params.path) {
				const matches = windows.filter((x) => x.path === resolve(ctx.cwd, params.path!));
				if (matches.length === 0) return { content: [{ type: "text" as const, text: `close failed: no open window for ${params.path}.` }], details: {}, isError: true };
				if (matches.length > 1) {
					return {
						content: [{ type: "text" as const, text: `close failed: ${matches.length} windows open on ${params.path}. Close by id: ${matches.map((x) => `W${x.id}`).join(", ")}.` }],
						details: {},
						isError: true,
					};
				}
			}
			if (target === undefined) {
				return {
					content: [{ type: "text" as const, text: `close needs windowId or path. Open windows: ${windows.map((x) => `W${x.id} ${x.label}`).join(", ") || "none"}.` }],
					details: {},
					isError: true,
				};
			}

			const index = windows.findIndex((x) => x.id === target);
			if (index < 0) return { content: [{ type: "text" as const, text: `close failed: no window ${target}. Open: ${windows.map((x) => `W${x.id} ${x.label}`).join(", ") || "none"}.` }], details: {}, isError: true };
			const [closed] = windows.splice(index, 1);

			const block = await buildBlock(ctx);
			blockTokens = block?.tokens ?? 0;
			const freed = Math.max(0, before - blockTokens);

			return {
				content: [
					{
						type: "text" as const,
						text: [
							`close W${closed.id} ${closed.label} successful.`,
							`freed ~${freed} tokens · ${sizeReport(b)}`,
							windows.length === 0 ? "No live view windows remain; the LIVE VIEW block is gone from requests." : `still open: ${windows.map((x) => `W${x.id} ${x.label}`).join(", ")}`,
						].join("\n"),
					},
				],
				details: { windowId: closed.id, path: closed.path },
			};
		},
	});
}
