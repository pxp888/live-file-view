---
name: liveview
description: Use the liveview extension's open()/close() tools for every file you inspect or edit, in place of read(). Gives a constant current view of files on disk, and lets the model release file contents from context with close(). Use when searching across many files, editing, re-checking files, or freeing context.
---

# Live view: open() and close()

Use these whenever `open` / `close` appear in your tool list. They replace `read()` for text files.

## The core idea

`read()` burns a snapshot of a file into the conversation permanently. `open()` creates a **window** on the file: the contents are re-read from disk before every request and appended to a `LIVE VIEW` block at the end of the prompt. You always see the file as it is **now**.

**You never reconstruct a file from an earlier read plus edit diffs.** After an edit, do not re-read and do not compute the new state in your head — the next live-view block already contains it.

## Tool signatures

```
open(path)                        whole file, new window W<n>
open(path, offset, limit)        line range, new window W<n>
open(windowId, offset, limit)    re-range an existing window, keeps its id
close(windowId)                  close one window
close(path)                      closes it, only if that file has exactly one window
```

* `open()` returns a confirmation and the range shown — **never the contents**. The contents are already in your context when you read that confirmation: the LIVE VIEW block sits directly after the tool result.
* Same limits as `read()`: 2000 lines or 50KB, whichever comes first. Use `offset`/`limit` for big files.
* Window ids are never reused. Two windows on one file are fine (`W1` lines 10-50, `W2` lines 500-560).
* Window contents are raw text with no line-number prefixes — copy them verbatim into `edit` search strings.

## Rules while a window is open

1. **Do not `read()` a file you have opened.** The block is the current state and it always wins over an earlier `read()` in this conversation.
2. **Do not re-open just to see the effect of your own edit.** The refresh shows it.
3. Read the window header: `lines 10-39 of 2400` tells you the file's real length, so you know where to open next.
4. A header flag is an instruction, not decoration:
   * `file changed since last refresh` — the offsets may no longer cover what you need; re-range the window.
   * `offset beyond end of file` / `no lines of N` — the window is empty, move or close it.
   * `cut at the 50KB read limit` or `truncated to fit the live-view budget` — the range shown is smaller than requested; open a second window or shrink others.
5. **Never `open()` a file without also planning to close it.** Open windows are re-sent on every request.

## Behavior 1: search and dismiss

Searching normally costs context for every file you look at. With open/close a file you reject costs only the tool calls.

```
open("src/loaders/csv.js")      -> W3 confirmation only
   (W3 contents are in the LIVE VIEW block, right after that tool result)
   ...judge it: not the right place...
close(3)                        -> freed ~4100 tokens
```

The `open` / notes / `close` sequence stays in the session, so you still know you looked at `csv.js` and what you concluded — you just no longer carry its bytes. This lets you survey **more files than fit in the context window**.

Pattern for a wide search: open one or two files at a time, look, note the finding, `close()`, move on. Do not accumulate windows across a search.

## Behavior 2: inspect, narrow, focus

Large files do not need to stay fully open while you edit a single function. Open wide to locate the code, then narrow the window to the working region:

```
open("src/services/billing.ts")       -> W1 (1200 lines, ~4200 tokens)
   (LIVE VIEW shows the file; target function is at lines 340-385)
open(1, 335, 60)                      -> re-ranges W1 to lines 335-394 (~300 tokens)
   (freed ~3900 tokens for subsequent editing turns)
   ...make your edits with a clean, focused live view...
close(1)                              -> released on completion
```

Never pay for 1000+ lines of unchanged context across multiple turns when your work is only on 50 lines.

## Behavior 3: close on completion

When a file's work is finished, release it:

* boilerplate, scaffolding, config, or a file you only edited once — `close()` it
* a file you still may reference but only in part — shrink instead: `open(4, 100, 40)`
* keep open only what you are actively editing or re-checking

This is what lets you do much more work between compaction events: the context holds your decisions and tool calls, not stale file bodies.

## Context budget

The live view shares the context window with the conversation and is capped at 2/3 of the working space:

* `open()` fails when the next window would exceed the cap or the whole context. The error tells you the sizes; act on it by `close()`ing or shrinking windows.
* Every `open()` / `close()` result reports token cost and the live view's share of the working context — treat that number as the price of the window.
* A large live view forces compaction of the conversation sooner. When context is tight, close windows before they are needed, not after.
* `close()`ing is always available to you; it is the lever, so keep windows small enough that the lever works.

## Use open(), not read()

`read()` costs context until a compaction event. open() should be preferred when possible.  

`read()` remains for two cases only:

* `open` is not in your tool list — liveview is not loaded.
* The file is not plain text (`open()` rejects it; `read()` renders images).
