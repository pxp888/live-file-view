# live view file tool

### This extension gives a model a 'live view' of the current state of a file.

In the normal flow of editing, a model reads a file which places it into the context.  Multiple edits may then be performed.  To construct the current view of the file the model must reconstruct the state from original + diffs.

I'd like to introduce an open() tool, which has a similar signature to the read() tool except it simply returns 'open successful - live-view window N '.  The view of the file itself is added to a 'live view' block appended to the end of the session context.  

In that sense it is very similar to the read() tool, except file contents are placed in the live-view block, not the context itself.  

This block is refreshed before any request is sent out, so the model always sees the current state of the file.

This should reduce errors by making the current state clearer.  The model never has to reconstruct the current state from original + diffs.  

Multiple views of the same file are allowed.  Each window has a unique ID number that is never assigned twice.  

open() can also be called on existing windows with different parameters, to shrink, expand, or change offset.  

open() should maintain pi's default limits on opening, 2000 lines or 50kb, whichever is first.  

The open() tool is otherwise identical to read(), except that the view of the file or files is in the 'live view' block, which is dynamically refreshed before a request goes out.

The model is free to choose either read() or open(), but the tool description should clearly state that open() is the preferred method.

Edits are appended to the session context normally.

There should also be a corresponding close() tool.  This returns a simple 'close <filename> successful.' (or something equivalent) and that 'window' to a file should be removed from the live-view block.  close() should also work with window ID numbers, so that if multiple windows of the same file are open the model can specify.  

There is a secondary goal to see if a model can effectively close() files.  A read() file burns context permanently, while an open() file can be closed, and the its context is freed for other work.  

## the live view block

The block is built fresh and appended to every request that has at least one file open. It is never written into the session. The earlier copies of an open file are not stripped yet: read results stay in the request exactly as they were, and the block says in words that it wins over them.

Each 'window' needs an ID number.  There should be a counter that only increments, so window ID numbers are never issued twice.  In addition to the id counter, the extension needs to track for each window:

* Window Id number

* file path or name

* start offset

* end offset

* total length

Two windows can exist in the same file.  Windows can be referred to by window ID, or filename if only 1 window is open for a file.  

Each window in the live-view block needs:

* a line explaining that THIS IS THE CURRENT STATE OF THE FILE.

* window ID number

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
    W1  src/price.js   lines 10-39 of 2400
    W2  src/price.js   lines 500-549 of 2400
    W3  src/parse.js   lines 1-1620 of 4300

  <<< W1  src/price.js  lines 10-39 of 2400 >>>
  import { RATE } from "./constants";
  ipsum lorem code here
  <<</W1>>>

  <<< W2  src/price.js  lines 500-549 of 2400 >>>
  export function calculateTotal(items) {
  ipsum lorem code here
  <<</W2>>>

  <<< W3  src/parse.js  lines 1-1620 shown of 4300 >>>
  ipsum lorem code here
  <<</W3>>>

  <<<<END LIVE VIEW>>>>
```

#### How to handle content drift within a window is decided — see "drift inside a window" in the implementing notes.

*A window is only a line range into the file's current state: refresh re-reads those offsets, edit events do not shift windows, and the header says when the file changed since the last refresh. No edit-event machinery.*

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

open calls should fail with a warning to close windows or reduce their size if: 

* the new window would extend the live-view beyond (contexLimit - reserveTokens)*2/3  

* the new window plus existing context exceeds contextLimit - reserveTokens. 

The warning itself should state that context is limited, and suggest possible actions.  It should also mention that not reducing the window will result in earlier compaction.  

Compaction of the normal context should be triggered when: 

* the normal context exceeds (contextLimit - reserveTokens) * 2/3 

* context + live-view size + reserveTokens > contextLimit 

## implementing notes

### how the block reaches the model

Use `pi.on("context")`, not `context_with_system`. The `context` handler fires before every LLM call and receives the conversation without the system message; when the handler returns a changed list, Pi re-projects its prompt and tool declarations onto the head. So the extension only ever appends — it never owns the prompt, never risks dropping the tool declarations, never has to reimplement Pi's prompt state. `context_with_system` hands over the whole transcript including the head, which is a footgun we do not need.

The block is appended as a single trailing `system` message, after the newest toolResult, so it is the last thing the model reads.

* `system` and not `user`: a `user` block is a conversational turn — the model can answer it, quote it, or treat it as the user speaking. The live view is standing reference material, not a turn. It also avoids two consecutive user messages following a toolResult.
* pi-ai already handles mid-conversation system messages (`anthropic-messages.js` collects them, `openai-completions.js` passes them through as `role: "system"`). The llama.cpp/Ollama qwen path uses the OpenAI-compatible route, which accepts them.
* Fallback switch: if a strict chat template rejects a non-leading system message, drop to `user` role and let the `<<<<LIVE VIEW>>>>` fences do the labelling instead of the role. One boolean, not a config system.
* The block is never persisted into the session, so it is invisible in the transcript and the TUI. Accepted.

### open() and close() signatures

* `open(path, offset, limit)` — same parameter shape as `read()`: 1-based `offset`, `limit` in lines, same 2000 line / 50kb limits, whichever comes first.
* `open()` returns a confirmation only, never file contents: that the file was opened, the window ID, and the range now shown.
* Opening a different range of the same file creates a new window with a new unique ID.
* Altering an existing window requires its ID: `open(windowId, offset, limit)`. The ID is kept; the window is re-ranged, not replaced.
* Reject images. Only plain text files get windows.
* `close(id)` closes one window. `close(filename)` works only when that file has exactly one window; otherwise it fails and lists the window IDs.

### token accounting and compaction

`estimateTokens` is re-exported from `@earendil-works/pi-coding-agent`, so no custom estimator is needed.

* `blockTokens = estimateTokens(blockText)`, computed in the `context` handler that builds the block, and cached for the turn so `open()` can report it without re-estimating.
* `contextTokens` comes from `ctx.getContextUsage()` (Pi's own estimate covers trailing messages).
* `open()` gate: fail when `existing block + new window > (contextLimit - reserveTokens) * 2/3`.
* Compaction is triggered by the extension from `agent_settled` when `contextTokens + blockTokens + reserveTokens > contextLimit`, via `ctx.compact()`. Pi cannot see the block, so Pi's own checks will not fire in time.
* Not from the `context` handler: `ctx.compact()` is Pi's manual entry point, and it aborts the agent operation it is called during without retrying the turn (`AgentSession.compact()` starts with `await this.abort()`). `agent_settled` fires after the run is marked inactive, so `ctx.isIdle()` is true and nothing in flight is lost.
* Guard against a second compaction while one is running (`compacting` flag plus `ctx.isIdle()`). `ctx.compact()` does not await, so it will not deadlock, but a summariser call kicked off mid-flight must not stack. In single-shot print mode Pi disposes the runtime as soon as the prompt returns, so a settle-time compaction can be cut off there; in interactive/RPC use it completes.
* Absolute cap in the block builder as well as the `open()` gate: if the block alone is huge, compacting the normal context cannot help, and shrinking windows is the only lever left. Truncate the window and say so in its header.

### drift inside a window

A window is a line range into the file's current state, nothing more. Each refresh re-reads those offsets from disk; nothing is shifted or tracked when the file changes, and edits do not move windows.

If the file changed since the last refresh, say so in the window header:

```
W2  src/price.js  lines 500-549 of 2400 (file changed since last refresh)
```

No edit-event machinery. The model re-adjusts the window itself when the offsets no longer cover what it needs.

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

At this point, do not introduce mechanics to try and 'force' a model to use the tool.

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
