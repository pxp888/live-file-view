# live view file tool 

## The goal of this project is to give a model access to a live view of the current state of a file.  

In the normal flow of editing, a model reads a file which places it into the context.  Multiple edits may then be performed.  To construct the current view of the file the model must reconstruct the state from original + diffs.  

I'd like to introduce an 'open' tool, which has a similar signature to the 'read' tool except it simply returns 'open successful'.  The view of the file itself is added to a 'live view' block appended to the end of the session context.  This block is refreshed before any request is sent out, so the model always sees the current state of the file.  

Multiple views of the same file are allowed.  If they overlap, they should be merged into one view.  

Edits work normally, and are appended to the session context normally.  

The 'open' tool is otherwise identical to 'read', except that the view of the file or files is in the 'live view' block, which is dynamically refreshed before a request goes out.  

There should also be a corresponding 'close' tool.  This returns a simple 'close <filename> successful.' (or something equivalent) and that 'window' to a file should be removed from the live-view block.  

The model is free to choose either 'read' or 'open', but the tool description should clearly state that 'open' is the preferred method.  



## the live view block 

The block is built fresh and appended to every request that has at least one file open. It is never written into the session. The earlier copies of an open file are not stripped yet: read results stay in the request exactly as they were, and the block says in words that it wins over them.

```
[LIVE VIEW 路 src/price.js 路 all 214 lines 路 6.1 KiB]
Current contents on disk, re-read before this request.  This block is the file as it is now: use it in place of any earlier read of src/price.js above, and in place of rebuilding it from the edit diffs.
opened in this session 路 3 edits since 路 unchanged since your last view

export const RATE = 20;
...

[END LIVE VIEW 路 src/price.js]
```

When multiple non-adjacent windows are open on a file, each section is displayed with its own hunk header:

```
[LIVE VIEW 路 src/price.js 路 lines 10-39, 500-549 of 2400 路 3.2 KiB]
Current contents on disk, re-read before this request.  This block is the file as it is now: use it in place of any earlier read of src/price.js above, and in place of rebuilding it from the edit diffs.
opened in this session 路 3 edits since 路 unchanged since your last view

[--- lines 10-39 of 2400 ---]
import { RATE } from "./constants";
...

[--- lines 500-549 of 2400 ---]
export function calculateTotal(items) {
...

[END LIVE VIEW 路 src/price.js]
```


### open tool generation flow 

When the live view block is generated, the extension should make an estimate of the final context size.  

The first question is whether that estimated size should trigger a compaction.  

If yes, there are two options.  If the live-view block is greater than 3/4 of the final context, refuse to add the latest content, and let the model know it has to close or reduce the size of open windows.  If the live-view block is smaller than 3/4 of the final context, trigger a manual compaction.  

If the estimated context size is acceptable, simply append the live-view block and send the request.  


## implementing notes 

Do not introduce constraints that the current read tool doesn't have.  

Keep the code as simple as possible, do not add guardrails that are not currently present in the read tool.  For example, a model can 'read' until its context is exhausted.  It should be able to 'open' files until its context is exhausted.  

The 'open' tool should have the same size limits as 'read'.  Same number of lines or bytes returned in one call.  The model is free to make multiple calls, just as it can with 'read'.  

At this point, do not introduce mechanics to try and 'force' a model to use the tool.  



## next steps, implement later if needed (not now) 

### strip output of 'read' when a file is 'opened' 
This prevents duplicating file content.  

### custom compaction routine 
Standard Compaction takes places without the compacting agent being aware of the live-view behavior.  It may be necessary to write a custom compaction routine that is aware that the live-view will be restored.  



## other notes 

The context cache thrashing issue is understood and acceptable.  This extension is primarily aimed at local agents who could benefit from it the most, not frontier models.  
