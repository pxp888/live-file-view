# liveview

A [pi](https://github.com/earendil-works/pi) coding-agent extension that gives the model a **live view** of the files it is working on.

Instead of `read()` burning a file snapshot permanently into the conversation, `open()` keeps a *window* on the file. The contents of every open window are re-read from disk before each request and appended to a `LIVE VIEW` block at the end of the prompt, so the model always sees the file as it is now — no rebuilding state from an old read plus edit diffs. `close()` releases the window and its context.

Design rationale is in [`design.md`](./design.md); the implementation is a single file, [`liveview.ts`](./liveview.ts).

## Run it

```bash
pi -e ./liveview.ts
```

Or, once it is ready to install, drop it in `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local). It is deliberately kept in the project root for now.

## Tools

### `open(path, offset, limit)`

Opens a new window, or re-ranges an existing one. Same parameter shape and same limits as `read()`: 1-based `offset`, `limit` in lines, 2000 lines or 50KB, whichever comes first.

```
open("src/price.js", 10, 40)   -> open successful - live-view window 1
open(1, 500, 50)               -> re-ranges W1 in place, keeping its id
```

* Returns a **confirmation only** — window id and the range now shown, never file contents. The contents arrive in the live-view block of the next request.
* A different range of the same file is a **new window with a new id**. Ids come from a counter that only increments, so they are never reused.
* Multiple windows per file are allowed. Re-ranging requires the window id.
* Plain text files only; a file containing a NUL byte is rejected.

### `close(window | path)`

`close(2)` closes window W2. `close("src/price.js")` works only when that file has exactly one window — otherwise it fails and lists the ids. Reports how many tokens it freed.

## The live-view block

Built fresh and appended as a trailing `system` message to every request that has at least one window open. It is never written into the session, so it does not appear in the transcript or the TUI.

```
<<<<LIVE VIEW>>>>
Contents below were re-read from disk before this request. Each window is the file
as it is NOW: use it in place of any earlier read of that file in this conversation,
and in place of rebuilding it from edit diffs.

3 windows · 2070 lines shown · this block is 62% of the space left in this context
  W1  src/price.js   lines 10-39 of 2400
  W2  src/price.js   lines 500-549 of 2400
  W3  src/parse.js   lines 1-1620 of 4300

<<< W1  src/price.js  lines 10-39 of 2400 >>>
import { RATE } from "./constants";
...
<<</W1>>>

<<<<END LIVE VIEW>>>>
```

Window contents are raw text with **no per-line number prefixes**, so exact-match search/replace can be copied straight out of the block without prefix or indentation mismatch. The hunk header carries the range.

## Context budget

pi cannot see the block, so its own compaction checks would not fire in time — the extension does the accounting (`estimateTokens` from pi, `ctx.getContextUsage()` for the conversation).

With `reserveTokens` from pi's compaction settings (16384 by default) and `working = contextWindow - reserveTokens`:

| Rule | Threshold |
|---|---|
| Max live view | `working * 2/3` — `open()` fails above it |
| Max normal context | `working * 2/3` — past it, compaction is triggered |
| Compaction also triggers | `contextTokens + blockTokens + reserveTokens > contextWindow` |
| Minimum live-view reserve | `working * 1/3` |

Rejected `open()` calls explain the sizes involved and suggest `close()` or shrinking a window (`open(window, offset, limit)`). A compaction guard prevents a second summariser call stacking on top of one already running. If the block alone exceeds the cap, windows are truncated and the header says so — shrinking is the only lever left, since compacting the conversation cannot help.

Every `open()` / `close()` result reports the window's token cost and the live view's share of the working context.

## Drift inside a window

A window is just a line range into the file's current state. Refresh re-reads those offsets; edits never shift windows and there is no edit-event machinery. If the file changed since the last refresh the header says so:

```
<<< W2  src/price.js  lines 500-549 of 2400 (file changed since last refresh) >>>
```

The model re-adjusts the range when the offsets no longer cover what it needs.

## Known limits

* Window state lives in memory only — `/resume`, `/tree` and forks drop open windows silently.
* The block is re-prefilled every request, so on large local contexts (this is aimed at qwen3.8:27b / qwen3.8-flash-next with 128k+) prefill time per turn is a real cost, not only token count.
* Standard compaction summarises away earlier reads while windows keep refreshing; the first block after a compaction boundary carries a one-line marker saying an earlier read may have been summarised away.
* Not implemented yet, by design: stripping earlier `read()` results for opened files, a custom compaction routine, a skills file, and any mechanism that forces the model to use `open()` over `read()`.
