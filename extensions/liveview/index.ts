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
	id: string; // non-ordered color-noun handle (e.g. "blue-fox")
	path: string; // absolute
	label: string; // shown to the model
	offset: number; // 1-based start line
	limit: number; // requested lines
	statKey: string; // "mtimeMs:size" at the last refresh, for drift detection
	cachedTokens?: number; // estimated tokens of the window
	lastMutation?: { startLine: number; endLine: number; shift: number }; // post-edit drift tracking
}

const COLORS = [
	"amber", "azure", "blue", "bronze", "copper", "coral", "crimson", "cyan",
	"emerald", "gold", "gray", "green", "indigo", "jade", "mint", "olive",
	"onyx", "orange", "pearl", "plum", "purple", "red", "rose", "ruby",
	"rust", "sage", "silver", "slate", "teal", "violet",
];

const NOUNS = [
	"badger", "bear", "beaver", "bison", "crane", "deer", "eagle", "falcon",
	"finch", "fox", "gecko", "hare", "hawk", "heron", "koala", "lark",
	"lynx", "mole", "moose", "newt", "otter", "owl", "panda", "puma",
	"quail", "raven", "robin", "seal", "sloth", "swan", "tiger", "viper",
	"weasel", "wolf", "wren",
];

const windows: LiveWindow[] = [];

function generateWindowId(): string {
	const active = new Set(windows.map((w) => w.id));
	for (let i = 0; i < 100; i++) {
		const color = COLORS[Math.floor(Math.random() * COLORS.length)];
		const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
		const id = `${color}-${noun}`;
		if (!active.has(id)) return id;
	}
	return `win-${Math.random().toString(36).slice(2, 6)}`;
}
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

/**
 * Extract a concise outline of major symbols / structural landmarks in the file lines.
 * Collapses the need for a separate grep -n / repo_map call before aiming a window.
 */
function extractOutline(allLines: string[]): string {
	const symbols: string[] = [];
	for (let i = 0; i < allLines.length && symbols.length < 10; i++) {
		const line = allLines[i];
		const trimmed = line.trim();
		const lineNo = i + 1;

		// pi tool registration
		const toolMatch = line.match(/(?:pi\.)?registerTool\(\s*\{\s*name:\s*["']([^"']+)["']/);
		if (toolMatch) {
			symbols.push(`${lineNo} ${toolMatch[1]} tool`);
			continue;
		}

		// Markdown headings
		const mdMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
		if (mdMatch) {
			symbols.push(`${lineNo} ${mdMatch[2].slice(0, 25)}`);
			continue;
		}

		// JS/TS exports and functions
		if (/^export\s+default\s+function/.test(trimmed)) {
			symbols.push(`${lineNo} export default function`);
			continue;
		}
		if (/^export\s+default\s+class/.test(trimmed)) {
			symbols.push(`${lineNo} export default class`);
			continue;
		}
		const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s*([a-zA-Z0-9_$]+)?/);
		if (fnMatch) {
			symbols.push(`${lineNo} function ${fnMatch[1] || "anonymous"}`);
			continue;
		}
		const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_$]+)/);
		if (classMatch) {
			symbols.push(`${lineNo} class ${classMatch[1]}`);
			continue;
		}
		const ifaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/);
		if (ifaceMatch) {
			symbols.push(`${lineNo} interface ${ifaceMatch[1]}`);
			continue;
		}
		const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([a-zA-Z0-9_$]+)\s*=/);
		if (typeMatch) {
			symbols.push(`${lineNo} type ${typeMatch[1]}`);
			continue;
		}

		// Python def / class
		const pyMatch = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)|class\s+([a-zA-Z0-9_]+)/);
		if (pyMatch) {
			symbols.push(`${lineNo} ${pyMatch[1] ? `def ${pyMatch[1]}` : `class ${pyMatch[2]}`}`);
			continue;
		}

		// Rust / Go
		const rustMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/);
		if (rustMatch) {
			symbols.push(`${lineNo} fn ${rustMatch[1]}`);
			continue;
		}
		const goMatch = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_]+)/);
		if (goMatch) {
			symbols.push(`${lineNo} func ${goMatch[1]}`);
			continue;
		}
	}

	return symbols.length > 0 ? `symbols: ${symbols.join(", ")}` : "";
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
		if (w.lastMutation) {
			const sign = w.lastMutation.shift > 0 ? `+${w.lastMutation.shift}` : `${w.lastMutation.shift}`;
			flags.push(`changed: lines ${w.lastMutation.startLine}–${w.lastMutation.endLine} (${sign} shift)`);
			if (commit) w.lastMutation = undefined;
		} else if (changed) {
			flags.push("file changed since last refresh");
		}
		if (info.empty) flags.push("offset beyond end of file");
		if (info.firstLineTooBig) flags.push(`line ${startLine} is ${formatSize(DEFAULT_MAX_BYTES)}, over the read limit`);
		else if (info.sizeCut) flags.push(`cut at the ${formatSize(DEFAULT_MAX_BYTES)} read limit`);

		// Absolute cap: shrinking windows is the only lever left once the block itself is too big.
		let chunk = `${head(w, startLine, endLine, info.total, flags)}\n${text}\n<<</${w.id}>>>`;
		let tokens = tok(chunk);
		w.cachedTokens = tokens;
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
			chunk = `${head(w, startLine, endLine, info.total, flags)}\n${text}\n<<</${w.id}>>>`;
			tokens = tok(chunk);
			w.cachedTokens = tokens;
		}

		index.push(`  ${w.id}  ${w.label}   ${range(startLine, endLine, info.total)}`);
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
		...index,
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
	return `<<< ${w.id}  ${w.label}  ${range(startLine, endLine, total)}${flags.length ? ` (${flags.join(", ")})` : ""} >>>`;
}

function sizeReport(b: ReturnType<typeof budget>) {
	return `live view ~${blockTokens} tokens, cap ${b.maxLive} (2/3 of the ${b.working} token working space)`;
}

async function getRankedWindows(ctx: ExtensionContext) {
	const list: Array<{ id: string; label: string; tokens: number; lines: string }> = [];
	for (const w of windows) {
		try {
			const info = await readWindow(w);
			const chunk = `${head(w, info.startLine, info.endLine, info.total, [])}\n${info.text}\n<<</${w.id}>>>`;
			list.push({
				id: w.id,
				label: w.label,
				tokens: tok(chunk),
				lines: range(info.startLine, info.endLine, info.total),
			});
		} catch {
			list.push({ id: w.id, label: w.label, tokens: 0, lines: "unreadable" });
		}
	}
	return list.sort((a, b) => b.tokens - a.tokens);
}

function formatRankedList(ranked: Array<{ id: string; label: string; tokens: number; lines: string }>): string {
	if (ranked.length === 0) return "";
	return (
		"\nRecommended candidates to close (ranked largest first):\n" +
		ranked.map((r, i) => `  ${i + 1}. close("${r.id}") — ${r.label} (~${r.tokens} tokens, ${r.lines})`).join("\n")
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		windows.length = 0;
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

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return undefined;
		if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

		const inputPath = (event.input as { path?: string })?.path;
		if (!inputPath) return undefined;

		const targetPath = resolve(ctx.cwd, inputPath);
		const affected = windows.filter((w) => w.path === targetPath);
		if (affected.length === 0) return undefined;

		let fileContent = "";
		try {
			fileContent = await readFile(targetPath, "utf-8");
		} catch {
			return undefined;
		}

		const lines = fileContent.split("\n");
		const totalLines = lines.length;

		let verificationNote = "";

		if (event.toolName === "edit") {
			const edits = (event.input as { edits?: Array<{ oldText: string; newText: string }> })?.edits || [];
			let netShift = 0;
			for (const ed of edits) {
				const oldL = (ed.oldText || "").split("\n").length;
				const newL = (ed.newText || "").split("\n").length;
				netShift += newL - oldL;
			}

			const details = event.details as { firstChangedLine?: number } | undefined;
			let firstLine = details?.firstChangedLine;
			if (firstLine === undefined || firstLine < 1) {
				const firstNew = edits[0]?.newText;
				if (firstNew) {
					const firstSnippet = firstNew.split("\n")[0];
					const idx = lines.findIndex((l) => l.includes(firstSnippet));
					firstLine = idx >= 0 ? idx + 1 : 1;
				} else {
					firstLine = 1;
				}
			}

			const touchedLinesCount = edits.reduce((acc, ed) => acc + (ed.newText || "").split("\n").length, 0);
			const sliceStart = Math.max(1, firstLine - 2);
			const sliceEnd = Math.min(totalLines, firstLine + touchedLinesCount + 1);

			const sliceText = lines
				.slice(sliceStart - 1, sliceEnd)
				.map((line, idx) => `  ${String(sliceStart + idx).padStart(4, " ")} | ${line}`)
				.join("\n");

			const shiftStr = netShift > 0 ? `+${netShift} shift` : netShift < 0 ? `${netShift} shift` : "0 shift";

			for (const w of affected) {
				w.lastMutation = { startLine: sliceStart, endLine: sliceEnd, shift: netShift };
			}

			const label = affected[0]?.label || displayPath(targetPath, ctx.cwd);
			const winIds = affected.map((w) => w.id).join(", ");
			verificationNote = [
				`[liveview] Verified in window ${winIds} (${label}):`,
				`touched range: lines ${sliceStart}–${sliceEnd} of ${totalLines} (${shiftStr}):`,
				sliceText,
			].join("\n");
		} else if (event.toolName === "write") {
			const w = affected[0];
			const sliceCount = Math.min(totalLines, 20);
			const sliceText = lines
				.slice(0, sliceCount)
				.map((line, idx) => `  ${String(idx + 1).padStart(4, " ")} | ${line}`)
				.join("\n");

			for (const win of affected) {
				win.lastMutation = { startLine: 1, endLine: totalLines, shift: totalLines };
			}

			const winIds = affected.map((win) => win.id).join(", ");
			verificationNote = [
				`[liveview] File overwritten. Window(s) ${winIds} (${w.label}, ${totalLines} lines):`,
				`lines 1–${sliceCount} of ${totalLines}:`,
				sliceText,
			].join("\n");
		}

		if (!verificationNote) return undefined;

		const currentContent = event.content || [];
		const updatedContent = currentContent.map((item) => {
			if (item.type === "text") {
				return { ...item, text: `${item.text}\n\n${verificationNote}` };
			}
			return item;
		});

		return { content: updatedContent };
	});

	pi.on("context", async (event, ctx) => {
		if (windows.length === 0) return undefined;

		const block = await buildBlock(ctx);
		if (!block) return undefined;

		return { messages: [...event.messages, block.message] };
	});

	// Compaction is requested only once the run has settled: ctx.compact() is Pi's manual
	// entry point, which aborts the agent operation it is called during and never resumes it.
	// agent_settled fires after the run is marked inactive, so nothing in flight is lost.
	// The live view block is not a session entry, so Pi's own threshold check cannot see it:
	// this is the block-aware nudge that compacts history instead of shrinking the block.
	pi.on("agent_settled", (_event, ctx) => {
		if (windows.length === 0 || compacting || !ctx.isIdle()) return;

		const b = budget(ctx);
		const contextTokens = ctx.getContextUsage()?.tokens ?? 0;
		if (contextTokens + blockTokens + RESERVE_TOKENS <= b.contextWindow) return;

		compacting = true;
		ctx.compact({
			onComplete: () => {
				compacting = false;
			},
			onError: () => {
				compacting = false;
			},
		});
	});

	pi.registerTool({
		name: "open",
		label: "open",
		description:
			`Inspect, view, examine, review, or edit a text file via a live window. Preferred over read() for all workspace text files: the window is NOT written into the conversation history, instead the current file contents are re-read from disk and appended to a LIVE VIEW block at the end of every request, so you always see the file as it is now with no rebuilding from diffs.

Recommended workflow:
- For files under ~500 lines, open(path) with no limit is cheaper than aiming — a whole-file window costs ~9 tokens/line and can be re-ranged later.
- For larger files, locate the region with grep -n (or repo_map) then open that range, or use open(path, around="symbol") / open(path, aroundLine=N) to aim directly.
- open(windowId, offset, limit) re-ranges an existing window, keeping its id.

Returns an acknowledgement receipt only (window id, range, outline symbols, and token budget), never file contents (contents appear in the <<<<LIVE VIEW>>>> block). Same limits as read(): ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB, whichever comes first. Windows are released with close(), freeing the space a read() would burn permanently.`,
		promptSnippet: "Open a live-view window on a file (refreshed on every request)",
		promptGuidelines: [
			"Always prefer open() over read() for any text file you want to inspect, view, review, check, or edit. Do NOT call read() on text files in the workspace.",
			"Workflow: for files under ~500 lines, open(path) without limit to view the whole file (~9 tokens/line). For larger files, locate with grep -n first, or use open(path, around='symbol') or open(path, aroundLine=N).",
			"open() returns an acknowledgement receipt with file outline and symbols; the actual file contents are appended in the <<<<LIVE VIEW>>>> block at the end of the prompt in the same turn. Do NOT call read() after open().",
			"Edits and writes to windowed files are self-verifying and report fresh line numbers and line shift notes automatically.",
			"Keep windows open while actively working with or referencing files. When a file is no longer needed, close(windowId) or close(path) to free context space.",
		],
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "File to open (relative or absolute). Omit when re-ranging an existing window." })),
			windowId: Type.Optional(Type.String({ description: "Existing window id (e.g. 'blue-fox') to re-range. Use with offset/limit/around, no path." })),
			offset: Type.Optional(Type.Number({ description: "Line number to start the window at (1-indexed)" })),
			limit: Type.Optional(Type.Number({ description: `Maximum number of lines in the window (default: full file up to ${DEFAULT_MAX_LINES}, or 60 lines when aiming with around)` })),
			around: Type.Optional(Type.String({ description: "Aim window centered around the first occurrence of this symbol or text" })),
			aroundLine: Type.Optional(Type.Number({ description: "Aim window centered around this 1-based line number" })),
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

			let targetPath = "";
			if (params.windowId !== undefined) {
				index = windows.findIndex((x) => x.id === params.windowId);
				if (index < 0) return fail(`no window ${params.windowId}. Open windows: ${windows.map((x) => `${x.id} ${x.label}`).join(", ") || "none"}`);
				w = windows[index];
				const prev = { ...w };
				windows.splice(index, 1);
				restore = () => {
					Object.assign(w!, prev);
					windows.splice(index, 0, w!);
				};
				targetPath = params.path ? resolve(ctx.cwd, params.path) : w.path;
				w.path = targetPath;
				w.label = displayPath(targetPath, ctx.cwd);
			} else {
				targetPath = resolve(ctx.cwd, params.path!);
				w = {
					id: generateWindowId(),
					path: targetPath,
					label: displayPath(targetPath, ctx.cwd),
					offset: 1,
					limit: DEFAULT_MAX_LINES,
					statKey: "",
				};
			}

			let allLines: string[] = [];
			try {
				const buf = await readFile(w.path);
				const text = buf.toString("utf-8");
				if (text.includes("\u0000")) return bail(`${w.label} is not a plain text file`);
				allLines = text.split("\n");
			} catch (error) {
				return bail(`open failed: ${(error as Error).message}`);
			}
			const totalLines = allLines.length;

			// Handle aiming inputs (around / aroundLine)
			if (params.around !== undefined) {
				const query = params.around;
				let idx = allLines.findIndex((l) => l.includes(query));
				if (idx < 0) {
					idx = allLines.findIndex((l) => l.toLowerCase().includes(query.toLowerCase()));
				}
				if (idx < 0) {
					return bail(`open failed: '${params.around}' not found in ${w.label} (${totalLines} lines).`);
				}
				const targetLine = idx + 1;
				const winLimit = params.limit ?? 60;
				w.limit = Math.min(DEFAULT_MAX_LINES, Math.max(1, winLimit));
				w.offset = Math.max(1, targetLine - Math.floor(w.limit / 2));
			} else if (params.aroundLine !== undefined) {
				const targetLine = Math.max(1, Math.min(totalLines, params.aroundLine));
				const winLimit = params.limit ?? 60;
				w.limit = Math.min(DEFAULT_MAX_LINES, Math.max(1, winLimit));
				w.offset = Math.max(1, targetLine - Math.floor(w.limit / 2));
			} else {
				if (params.offset !== undefined) {
					w.offset = Math.max(1, params.offset);
				} else if (index < 0) {
					w.offset = 1;
				}
				if (params.limit !== undefined) {
					w.limit = Math.min(DEFAULT_MAX_LINES, Math.max(1, params.limit));
				} else if (index < 0) {
					w.limit = DEFAULT_MAX_LINES;
				}
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
				const ranked = await getRankedWindows(ctx);
				return bail(
					`open failed: this window (~${windowTokens} tokens) would put the live view at ~${existing + windowTokens}, over the ${b.maxLive} token cap ((context window ${b.contextWindow} - ${RESERVE_TOKENS} reserve) * 2/3).${formatRankedList(ranked)}\nClose windows with close(windowId), or shrink them with open(windowId, offset, limit). Leaving the live view this big forces compaction of the conversation sooner.`,
				);
			}
			const contextTokens = ctx.getContextUsage()?.tokens ?? 0;
			if (contextTokens + existing + windowTokens + RESERVE_TOKENS > b.contextWindow) {
				const ranked = await getRankedWindows(ctx);
				return bail(
					`open failed: context (~${contextTokens}) + live view (~${existing + windowTokens}) + ${RESERVE_TOKENS} reserve exceeds the ${b.contextWindow} token context window.${formatRankedList(ranked)}\nClose windows with close(windowId), shrink them with open(windowId, offset, limit), or let the conversation compact first.`,
				);
			}

			let duplicateNote = "";
			if (index < 0) {
				const duplicates = windows.filter((other) => other.path === w!.path);
				if (duplicates.length > 0) {
					const dupDescs = duplicates.map((other) => {
						const otherEnd = other.offset + other.limit - 1;
						const overlaps = Math.max(info.startLine, other.offset) <= Math.min(info.endLine, otherEnd);
						const tokEstimate = other.cachedTokens ? `~${other.cachedTokens} tokens` : "active";
						return `${other.id} already open on this file (${other.offset}–${otherEnd}, ${tokEstimate}, ${overlaps ? "overlaps" : "no overlap"})`;
					});
					duplicateNote = `\nnew window ${w.id} ${info.startLine}–${info.endLine} · ${dupDescs.join("; ")} — pass windowId to re-range, or close it if unused.`;
				}
			}

			if (index >= 0) windows.splice(index, 0, w);
			else windows.push(w);
			w.statKey = info.statKey;
			w.cachedTokens = windowTokens;
			const block = await buildBlock(ctx);
			blockTokens = block?.tokens ?? 0;

			const percentOfCap = Math.round((blockTokens / b.maxLive) * 100);
			const pressureWarning = percentOfCap >= 75
				? `\nNotice: Live view is utilizing ${percentOfCap}% of cap (~${blockTokens}/${b.maxLive} tokens). Consider closing windows you have finished inspecting.`
				: "";

			const outline = extractOutline(allLines);
			const outlinePart = outline ? ` · ${outline}` : "";

			return {
				content: [
					{
						type: "text" as const,
						text: [
							`open successful - live-view window ${w.id}`,
							`${w.label}  ${range(info.startLine, info.endLine, info.total)}${outlinePart}`,
							`window ~${windowTokens} tokens · ${sizeReport(b)}${pressureWarning}${duplicateNote}`,
							"The file contents are already in your context: the LIVE VIEW block follows this tool result. You do not need to read this file again.",
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
			"Close live view window(s) created by open(): removed from the LIVE VIEW block and context space is freed. close(windowId) closes one window by id (e.g. 'blue-fox'); close(path) closes all open windows for that file.",
		promptSnippet: "Close a live-view window and free its context",
		promptGuidelines: [
			"Call close(windowId) or close(path) when you are finished inspecting or editing a file to release it from context and avoid context pressure.",
		],
		parameters: Type.Object({
			windowId: Type.Optional(Type.String({ description: "Window id (e.g. 'blue-fox') to close" })),
			path: Type.Optional(Type.String({ description: "File whose open window(s) to close (relative or absolute). Closes all windows on this file." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const b = budget(ctx);
			const before = blockTokens;

			if (params.windowId === undefined && !params.path) {
				return {
					content: [{ type: "text" as const, text: `close needs windowId or path. Open windows: ${windows.map((x) => `${x.id} ${x.label}`).join(", ") || "none"}.` }],
					details: {},
					isError: true,
				};
			}

			const closedWindows: LiveWindow[] = [];

			if (params.windowId !== undefined) {
				const index = windows.findIndex((x) => x.id === params.windowId);
				if (index < 0) {
					return {
						content: [{ type: "text" as const, text: `close failed: no window ${params.windowId}. Open: ${windows.map((x) => `${x.id} ${x.label}`).join(", ") || "none"}.` }],
						details: {},
						isError: true,
					};
				}
				closedWindows.push(...windows.splice(index, 1));
			} else if (params.path) {
				const targetPath = resolve(ctx.cwd, params.path);
				for (let i = windows.length - 1; i >= 0; i--) {
					if (windows[i].path === targetPath) {
						closedWindows.push(windows.splice(i, 1)[0]);
					}
				}
				if (closedWindows.length === 0) {
					return {
						content: [{ type: "text" as const, text: `close failed: no open window for ${params.path}. Open windows: ${windows.map((x) => `${x.id} ${x.label}`).join(", ") || "none"}.` }],
						details: {},
						isError: true,
					};
				}
				closedWindows.reverse();
			}

			const block = await buildBlock(ctx);
			blockTokens = block?.tokens ?? 0;
			const freed = Math.max(0, before - blockTokens);

			const closedDesc = closedWindows.map((c) => `${c.id} ${c.label}`).join(", ");
			return {
				content: [
					{
						type: "text" as const,
						text: [
							`close ${closedDesc} successful.`,
							`freed ~${freed} tokens · ${sizeReport(b)}`,
							windows.length === 0 ? "No live view windows remain; the LIVE VIEW block is gone from requests." : `still open: ${windows.map((x) => `${x.id} ${x.label}`).join(", ")}`,
						].join("\n"),
					},
				],
				details: { closed: closedWindows.map((c) => ({ windowId: c.id, path: c.path })) },
			};
		},
	});
}
