# live view file tool

### This extension gives a model a 'live view' of the current state of a file.

In the normal flow of editing, a model reads a file which places it into the context.  Multiple edits may then be performed.  To construct the current view of the file the model must reconstruct the state from original + diffs.

I'd like to introduce an open() tool, which has a similar signature to the read() tool except it simply returns 'open successful - live-view window <id>' (e.g. 'open successful - live-view window blue-fox').  The view of the file itself is added to a 'live view' block appended to the end of the session context.  

In that sense it is very similar to the read() tool, except file contents are placed in the live-view block, not the context itself.  

This block is refreshed before any request is sent out, so the model always sees the current state of the file.

This should reduce errors by making the current state clearer.  The model never has to reconstruct the current state from original + diffs.  

Multiple views of the same file are allowed.  Each window has a unique, non-ordered color-noun handle (e.g. blue-fox) assigned from a pool so as not to convey sequence or count.  

open() can also be called on existing windows with different parameters, to shrink, expand, or change offset.  

open() should maintain pi's default limits on opening, 2000 lines or 50kb, whichever is first.  

The open() tool is otherwise identical to read(), except that the view of the file or files is in the 'live view' block, which is dynamically refreshed before a request goes out.

The model is free to choose either read() or open(), but the tool description should clearly state that open() is the preferred method.

Edits are appended to the session context normally.

There should also be a corresponding close() tool.  This returns a simple 'close <filename> successful.' (or something equivalent) and that 'window' to a file should be removed from the live-view block.  close() should also work with window IDs, so that if multiple windows of the same file are open the model can specify.  

There is a secondary goal to see if a model can effectively close() files.  A read() file burns context permanently, while an open() file can be closed, and the its context is freed for other work.  

## the live view block

The block is built fresh and appended to every request that has at least one file open. It is never written into the session. The earlier copies of an open file are not stripped yet: read results stay in the request exactly as they were, and the block says in words that it wins over them.

Each 'window' needs an identifier.  Identifiers are non-ordered color-noun handles (e.g. 'blue-fox') picked without collision among active windows so that no ordinality or sequence is implied.  The extension needs to track for each window:

* Window ID

* file path or name

* start offset

* end offset

* total length

Two windows can exist in the same file.  Windows can be referred to by window ID, or filename if only 1 window is open for a file.  

Each window in the live-view block needs:

* a line explaining that THIS IS THE CURRENT STATE OF THE FILE.

* window ID

* Filename

* start position

* end position

* total lines

A sample view is below:

```
  <<<<LIVE VIEW>>>>
  Contents below were re-read from disk before this request. Each window is the file
  as it is NOW: use it in place of any earlier read of that file in this conversation,
  and in place of rebuilding it from edit diffs.

  3 windows · 2070 lines shown · this block is 62% of the space left in this context
    blue-fox    src/price.js   lines 10-39 of 2400
    red-weasel  src/price.js   lines 500-549 of 2400
    amber-otter src/parse.js   lines 1-1620 of 4300

  <<< blue-fox  src/price.js  lines 10-39 of 2400 >>>
  import { RATE } from "./constants";
  ipsum lorem code here
  <<</blue-fox>>>

  <<< red-weasel  src/price.js  lines 500-549 of 2400 >>>
  export function calculateTotal(items) {
  ipsum lorem code here
  <<</red-weasel>>>

  <<< amber-otter  src/parse.js  lines 1-1620 shown of 4300 >>>
  ipsum lorem code here
  <<</amber-otter>>>

  <<<<END LIVE VIEW>>>>
```

#### How to handle content drift within a window is decided — see "drift inside a window" in the implementing notes.

*A window is only a line range into the file's current state: refresh re-reads those offsets, edit events do not shift windows, and the header says when the file changed since the last refresh. A small `tool_result` handler adds a verification note after edits/writes that touch an open file (see "drift inside a window").*

### Content formatting and line numbering

Code lines inside each hunk are rendered as raw text without per-line number prefixes (e.g., without `10 | ` or `10: `). This keeps whitespace and characters identical to disk so exact-match search and replace (`Target` / `Replacement`) can be copied directly without line-number prefix leakage or indentation mismatch errors. Line range context is provided solely by the hunk headers.

### context management

pi itself doesn't 'see' the live-view, so its own compaction checks won't fire in time.  Because of this the extension will need to do some management itself.

The two components of the request are the normal context, and the live-view block.  

The normal context can be compacted, but the live-view cannot.  However, the live-view block can be reduced at any time by the model closing files or reducing the size of open windows.  (open() can be called again with smaller window parameters)

There does need to be limits to avoid extremes where the live-view is too large and there is no working context.  That would leave the model in a state where there is not enough to compact, and not enough context for the model to manage the live-view itself.  

At the other end of the spectrum we don't want to get into a position where the live-view is too small to properly contain information relevant to the problem.  If that happens the model has no option but to operate blindly until its context is exhausted and a compaction happens.  

I would propose a maximum live-view size of (contextLimit - reserveTokens) * 2/3 .  At that point any open() call should fail with a message to either close or reduce window sizes.  This also guarantees a minimum workable context available to the model.  

I would also set a minimum live-view reserve size of (contextLimit - reserveTokens) * 1/3 .  This also defines the maximum normal context size at (contextLimit - reserveTokens) * 2/3 .

Implemented as a fixed reserve instead of a 1/3 share: `LIVE_RESERVE_TOKENS = 20000`. The cap stays `(contextLimit - reserveTokens) * 2/3`; what the reserve adds is that the conversation must leave 20k of the working space free for the block, enforced by compaction when `working ≥ 2 * LIVE_RESERVE_TOKENS`. Below that, insisting on 20k would compact every turn, so those contexts fall back to the overflow rule. 20k is roughly one whole-file window: `DEFAULT_MAX_LINES` (2000 lines) at the ~9 tokens/line the block costs.

open calls should fail with a warning to close windows or reduce their size if: 

* the new window would extend the live-view beyond (contexLimit - reserveTokens)*2/3

* the new window plus existing context exceeds contextLimit - reserveTokens. 

The warning itself should state that context is limited, and suggest possible actions.  It should also mention that not reducing the window will result in earlier compaction.  

Compaction is triggered by the extension from `agent_settled` when:

* context tokens + live-view size + reserveTokens > contextLimit.
* live-view reserve crowded: `working - contextTokens < LIVE_RESERVE_TOKENS` while the block itself is below `LIVE_RESERVE_TOKENS` (only checked when `working ≥ 2 * LIVE_RESERVE_TOKENS`). History gives way, not the windows.

(The earlier proposal to also compact once normal context alone exceeds (contextLimit − reserveTokens) × 2/3 was not implemented — the check is the live-view reserve above, and Pi's own checks cover pure-history growth in practice.)

## implementing notes

### how the block reaches the model

Use `pi.on("context")`, not `context_with_system`. The `context` handler fires before every LLM call and receives the conversation without the system message; when the handler returns a changed list, Pi re-projects its prompt and tool declarations onto the head. So the extension only ever appends — it never owns the prompt, never risks dropping the tool declarations, never has to reimplement Pi's prompt state. `context_with_system` hands over the whole transcript including the head, which is a footgun we do not need.

The block is appended as a single trailing `user` message, after the newest toolResult, so it is the last thing the model reads.

* `user` and not `system`: llama.cpp does not accept mid-conversation system messages in typical chat templates, so Pi's `collapseSystemMessages` collapses any trailing `system` message into the leading system prompt at index 0. Because the live-view updates dynamically on turns, modifying token 0 invalidates the KV cache / prompt cache prefix for the entire session and forces a full re-evaluation of all previous turns. Emitting the block as a trailing `user` message preserves prefix stability in the KV cache so only the trailing turn is processed.
* Distinct fences (`<<<<LIVE VIEW>>>>` ... `<<<<END LIVE VIEW>>>>`) and explicit instructions frame the block as standing reference material rather than a conversational turn from the user.
* The block is never persisted into the session, so it is invisible in the transcript and the TUI. Accepted.

### open() and close() signatures

* `open(path, offset, limit)` — same parameter shape as `read()`: 1-based `offset`, `limit` in lines, same 2000 line / 50kb limits, whichever comes first.
* Aiming parameters: `around="symbol"` centers the window on the first (case-insensitive) occurrence of that text; `aroundLine=N` does the same for a line number. Both default to a 60-line window when no `limit` is given.
* `open()` returns an acknowledgement receipt, never file contents: confirmation plus window ID and range now shown, an outline of major symbols in the file (headings, functions, classes), the token budget state, a duplicate-window note if another window covers the same file, and a pressure warning once the live view passes 75% of its cap.
* Opening a different range of the same file creates a new window with a new unique ID.
* Altering an existing window requires its ID: `open(windowId, offset, limit)`. The ID is kept; the window is re-ranged, not replaced. Passing both `windowId` and `path` moves the window to a different file (ID kept).
* Reject non-text files via a null-byte check on the content (this also rejects images). Only plain text files get windows.
* `close(id)` closes one window. `close(path)` closes all open windows for that path and reports how many tokens were freed; it fails only when no window matches, listing the open windows.

### token accounting and compaction

`estimateTokens` is re-exported from `@earendil-works/pi-coding-agent`, so no custom estimator is needed.

* `blockTokens = estimateTokens(blockText)`, computed in the `context` handler that builds the block, and cached for the turn so `open()` can report it without re-estimating.
* `contextTokens` comes from `ctx.getContextUsage()` (Pi's own estimate covers trailing messages).
* `open()` gate: fail when `existing block + new window > (contextLimit - reserveTokens) * 2/3`.
* Compaction is triggered by the extension from `agent_settled` when `contextTokens + blockTokens + reserveTokens > contextLimit`, or when the conversation leaves less than `LIVE_RESERVE_TOKENS` of the working space for the block, via `ctx.compact()`. Pi cannot see the block, so Pi's own checks will not fire in time.
* Not from the `context` handler: `ctx.compact()` is Pi's manual entry point, and it aborts the agent operation it is called during without retrying the turn (`AgentSession.compact()` starts with `await this.abort()`). `agent_settled` fires after the run is marked inactive, so `ctx.isIdle()` is true and nothing in flight is lost.
* Guard against a second compaction while one is running (`compacting` flag plus `ctx.isIdle()`). `ctx.compact()` does not await, so it will not deadlock, but a summariser call kicked off mid-flight must not stack. In single-shot print mode Pi disposes the runtime as soon as the prompt returns, so a settle-time compaction can be cut off there; in interactive/RPC use it completes.
* Absolute cap in the block builder as well as the `open()` gate: if the block alone is huge, compacting the normal context cannot help, and shrinking windows is the only lever left. Truncate the window and say so in its header; if even one line does not fit, the window is skipped entirely and the block header says how many windows were hidden.

### drift inside a window

A window is a line range into the file's current state, nothing more. Each refresh re-reads those offsets from disk; edits do not move windows.

If the file changed since the last refresh (mtime/size stat key differs), say so in the window header:

```
red-weasel  src/price.js  lines 500-549 of 2400 (file changed since last refresh)
```

The model re-adjusts the window itself when the offsets no longer cover what it needs.

#### edit/write verification notes

A `tool_result` handler watches successful `edit` and `write` calls whose target path has an open window. On a hit it reads the post-change file from disk and appends a numbered snippet to that tool result: for edits, lines around the first changed line with the net line shift; for writes, the first 20 lines of the new file. The next refresh also flags affected windows in their header (`changed: lines X–Y (+N shift)`). Deliberately small: one note per mutation, no ongoing edit tracking.

### state lifetime

Window state lives in memory only. `/resume`, `/tree` and fork drop the open windows silently. Accepted for this version; persisting window metadata as custom session entries is a later step if it turns out to matter.

### compaction marker

Standard compaction summarises away the earlier reads while the live-view block keeps silently refreshing, so the model can forget the block exists. After a compaction boundary, the next block carries one line saying an earlier read of these files may have been summarised away and the windows below are the live state. That removes the need for a custom compaction routine.

### reporting size

Put the cost in the block header and in every `open()` / `close()` result (window token count and its share of the working context). A visible price tag moves models towards closing windows more reliably than an instruction framing close() as a goal to accomplish.

### general rules

Do not introduce constraints that the current read tool doesn't have, unless it is absolutely necessary.

Keep the code as simple as possible, do not add guardrails that are not currently present in the read tool.  For example, a model can read() until its context is exhausted.  It should be able to open() files until its context is exhausted.

The open() tool should have the same size limits as read().  Same number of lines or bytes returned in one call.  The model is free to make multiple calls, just as it can with read().

The open() prompt guidelines steer hard towards open() over read() ("Do NOT call read() on text files in the workspace"), not merely "preferred" as originally written — that is the one deliberate exception to this rule.

do not place the extension file in the active extension folder yet.  create it in the project root.  

## next steps, implement later if needed (not now)

### strip output of previous read() calls when a file is 'opened'

This prevents duplicating file content.

### custom compaction routine

Standard Compaction takes places without the compacting agent being aware of the live-view behavior.  The compaction marker in the implementing notes covers the part that mattered (the model forgetting the block exists), so a custom routine is not needed unless compaction itself starts cutting into work we still need.

### the skills file

A skills file explaining how open() can be much better than read() would be useful.  When a file is read() it is burned into context forever.  An open() file can be 'closed', which releases context.  This means a model could search a volume greater than the context window would normally allow.  

The other behavior that is possible is to close() a completed file. (or just shrink its window.)  If a model has finished boilerplate for example, and is unlikely to touch that file again, it can be closed.  

This means in theory a model could accomplish much more before compaction than it normally would.  

## other notes

The context cache thrashing issue is understood and acceptable.  The block is re-prefilled on every turn, so for the 128k local runs the cost worth measuring is prefill time per turn, not only token count.  This extension is aimed at local agents who could benefit from it the most, not externally provided models. 

This extension is NOT aimed at lower end models specifically.  The target models in development are qwen3.8:27b and qwen3.8-flash-next (which is 125b moe).  On my machine I can run either one with at least 128k of context window.  
