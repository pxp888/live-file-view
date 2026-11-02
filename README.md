# live view file tool

## The goal of this project is to give a model access to a live view of the current state of a file.

In the normal flow of editing, a model reads a file which places it into the context.  Multiple edits may then be performed.  To construct the current view of the file the model must reconstruct the state from original + diffs.  

I'd like to introduce an 'open' tool, which has a similar signature to the 'read' tool except it simply returns 'open successful'.  The view of the file itself is added to a 'live view' block appended to the end of the session context.  This block is refreshed before any request is sent out, so the model always sees the current state of the file.  

Multiple views of the same file are allowed.  If they overlap, they should be merged into one view.  

Edits are appended to the session context normally.  

The 'open' tool is otherwise identical to 'read', except that the view of the file or files is in the 'live view' block, which is dynamically refreshed before a request goes out.  

There should also be a corresponding 'close' tool.  This returns a simple 'close <filename> successful.' (or something equivalent) and that 'window' to a file should be removed from the live-view block.  

The model is free to choose either 'read' or 'open', but the tool description should clearly state that 'open' is the preferred method.  

## the live view block

The block is built fresh and appended to every request that has at least one file open. It is never written into the session. The earlier copies of an open file are not stripped yet: read results stay in the request exactly as they were, and the block says in words that it wins over them.

Each 'window' needs an ID number.  There should be a counter that only increments, so window ID numbers are never issued twice.  In addition to the id counter, the extension needs to track for each window: 

* Window Id number

* file path or name

* start offset

* end offset 

* total length



Two windows can exist in the same file.  If they overlap, they should be merged into one window.  

So each window needs:

* a line explaining that THIS IS THE CURRENT STATE OF THE FILE.  

* window ID number

* Filename 

* start position

* end position 

* total lines 







### Content formatting and line numbering

Code lines inside each hunk are rendered as raw text without per-line number prefixes (e.g., without `10 | ` or `10: `). This keeps whitespace and characters identical to disk so exact-match search and replace (`Target` / `Replacement`) can be copied directly without line-number prefix leakage or indentation mismatch errors. Line range context is provided solely by the hunk headers.

### open tool generation flow

When the live view block is generated, the extension should make an estimate of the final context size.  

The first question is whether that estimated size should trigger a compaction.  

If yes, there are two options.  

* If the live-view block is greater than 3/4 of the final context, the model should be told to either close open files or reduce open windows.  

* If the live-view block is smaller than 3/4 of the final context, trigger a manual compaction.  

If the estimated context size is acceptable, simply append the live-view block and send the request.  

## implementing notes

Do not introduce constraints that the current read tool doesn't have.  

Keep the code as simple as possible, do not add guardrails that are not currently present in the read tool.  For example, a model can 'read' until its context is exhausted.  It should be able to 'open' files until its context is exhausted.  

The 'open' tool should have the same size limits as 'read'.  Same number of lines or bytes returned in one call.  The model is free to make multiple calls, just as it can with 'read'.  

At this point, do not introduce mechanics to try and 'force' a model to use the tool.  

## next steps, implement later if needed (not now)

### strip output of previous 'read' calls when a file is 'opened'

This prevents duplicating file content.  

### custom compaction routine

Standard Compaction takes places without the compacting agent being aware of the live-view behavior.  It may be necessary to write a custom compaction routine that is aware that the live-view block will be restored.  

## other notes

The context cache thrashing issue is understood and acceptable.  This extension is primarily aimed at local agents who could benefit from it the most, not frontier models.  
