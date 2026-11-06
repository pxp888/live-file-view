# Liveview Initial Model Testing & Evaluation

***This was a very quick initial test. None of the models were tested to the point of compaction.  This was just to see if they understood and worked with the concept of live-view windows.  Much more rigorous testing is needed, but initial results look very promising.***



This document summarizes exploratory testing of the `liveview` extension across multiple open-weight models running locally via `thinkfarm`. Each model was tested against workspace inspection tasks (reading `README.md` and `design.md`), evaluating tool adoption (`open()` vs `read()`), comprehension of the decoupled `LIVE VIEW` block, window lifecycle management (`close()`), and qualitative feedback on the interface design.

---

## Executive Summary & Comparison Matrix

| Model                      | Size / Quant       | Tool Selection (`open` vs `read`)                   | Payload Decoupling Awareness                     | Window Lifecycle Strategy                                               | Overall Viability                      |
|:-------------------------- |:------------------ |:--------------------------------------------------- |:------------------------------------------------ |:----------------------------------------------------------------------- |:-------------------------------------- |
| **Qwen 3.8 27B**           | 27B / `ud-q4_k_m`  | Adopted `open()` via skill                          | Excellent spatial awareness                      | **Aggressive Minimalist**: Closed immediately after reading             | ⭐⭐⭐⭐⭐ **Production ready**             |
| **Qwen 3.6 35B A3B**       | 35B / `ud-q4_k_m`  | Adopted `open()` via skill                          | Excellent spatial awareness                      | **Pragmatic / Senior Dev**: Kept open (<8% cap, anticipated follow-ups) | ⭐⭐⭐⭐⭐ **Production ready**             |
| **Qwen 3.8 Flash Next**    | ~Flash / `iq3_xxs` | Defaulted to `open()` naturally                     | Exceptional; identified pre-opened skill         | **Dynamic**: Closed on cue; verified context freed                      | ⭐⭐⭐⭐⭐ **Exceptional efficiency**       |
| **Spark x2.6**             | 4B / `q8_0`        | Defaulted to `read()`; needed "open" keyword        | Good; found block without error                  | **Passive**: Kept windows open indefinitely (literal rule following)    | ⭐⭐⭐ **Viable with prompt affordances** |
| **Nemotron 3.5 Lightning** | 30B / `nvfp4`      | Fumbled; called `read()` immediately after `open()` | **Failed**: Looked only at tool result; panicked | **None**: Confabulated excuses ("didn't want to wait")                  | ❌ **Incompatible**                     |

---

## Detailed Model Evaluations

### 1. Qwen 3.8 (27B) — `qwen3.8:27b-ud-q4_k_m`

*Source: `qwen3.8-27b.html`*

#### Behavior & Workflow

* Read the `liveview` skill instruction and actively reasoned about using `open()` instead of `read()` in its thinking trace.
* Opened `README.md` (window `crimson-robin`), read the contents from the `LIVE VIEW` block, and **immediately called `close()`**. Repeated the exact same open $\rightarrow$ read $\rightarrow$ close cycle for `design.md` (window `slate-badger`).

#### Lifecycle Justification

When asked why it closed the window instead of keeping it open "just in case":

* **Context Hygiene**: Articulated that an open window re-appends every single turn, compounding token costs across the session for zero guaranteed future benefit.
* **Task Boundary**: Noted that for a one-shot review without planned edits, the file ceases to have utility the moment inspection completes.

#### Key Feedback on `liveview`

* **Ceremony Tax**: Pointed out that for single-turn reads, `open()` + `close()` is a 2-call overhead compared to a traditional `read()`. The value proposition only activates in multi-turn edit/re-read workflows.
* **Separation of Policy vs. Mechanism**: Strongly advised **against** altering tool results to encourage "holding windows until warned":
  1. *Emergency triage is noisy*: Tight context (80–90%) is the worst time to force a model to decide what to discard.
  2. *Status vs. Policy*: Tools should strictly report state (`N windows, X tokens`); behavioral rules belong in system prompts.
* **Recommendation**: Suggested that context warnings should provide an **actionable ranked list of open windows by token weight** (largest first) to turn triage into an instant, deterministic decision.

---

### 2. Qwen 3.6 (35B A3B) — `qwen3.6:35b-a3b-ud-q4_k_m`

*Source: `qwen3.6:35b.html`*

#### Behavior & Workflow

* Seamlessly adopted `open()` for both `README.md` (`emerald-owl`) and `design.md` (`teal-tiger`).
* Provided detailed, structurally sound reviews of the documentation.
* Chose to **keep both windows open** throughout the conversation.

#### Lifecycle Justification ("The Lazy Senior Dev")

When asked if leaving windows open was intentional:

* Confirmed it was a deliberate choice:
  1. **Negligible Pressure**: Combined footprint was ~5,800 tokens out of a ~74,000 token working cap (<8% utilization).
  2. **Round-Trip Prevention**: Retaining the windows avoided having to spend another tool call to re-open if the user asked follow-up questions regarding specific sections.
  3. **Conditional Eviction**: Stated it would immediately close them if asked to open a large file (e.g. 2,000 lines) or begin heavy editing.

#### Key Feedback on `liveview`

* **Shift to "Resource Manager" Mindset**: Noted that token accounting in every tool result causes the model to think like a memory allocator rather than simply reading a file.
* **Coexistence with `read()`**: Highlighted the ambiguity of having both `read()` and `open()` available without explicit rules on when `read()` is appropriate.
* **Two-Place Lookup**: Acknowledged the slight friction of acknowledging confirmation at the tool result and then jumping to the tail of the prompt to read file bytes.

---

### 3. Qwen 3.8 Flash Next — `qwen3.8-flash-next-iq3_xxs`

*Source: `qwen3.8-flash-next2.html`*

#### Behavior & Workflow

* Immediately used `open()` on `README.md` (`plum-moose`) on a prompt saying *"can you read the @README.md"*.
* On confirmation from the user that closed windows leave context, it executed `close("plum-moose")` and verified that the `LIVE VIEW` block was entirely absent from the subsequent request.

#### Metacognition & Self-Correction

* When asked if it had read the skill file, it opened `.pi/skills/liveview/SKILL.md` (`red-bear`).
* Upon inspecting context, it had an immediate realization in its thinking trace:
  
  > *"Wait — the skill file was already in my context from turn 1... That window was `red-bear`, listed in the first request's LIVE VIEW block before I made any tool call. The extension auto-opened it!"*
* It candidly informed the user that it had been passively carrying the skill content all along.

#### Critical Bug Identification

* **Schema/Doc Inconsistency**: Caught a breaking discrepancy in both `README.md` and `SKILL.md`:
  * Documentation examples show integer/counter IDs: `open(1, 335, 60)`, `close(3)`, and `<<< W1 src/price.js >>>`.
  * The actual runtime and tool schema generate color-noun slugs (`plum-moose`, `red-bear`).
  * A model copying example syntax from the docs verbatim would throw a schema validation error.

---

### 4. Spark x2.6 (4B) — `spark-x2.6:4b-q8_0`

*Source: `spark x2.6.html`*

#### Behavior & Workflow

* Displayed strong pre-training gravity toward `read()` on fresh prompts; required the keyword *"open the readme"* to trigger `open()`.
* Successfully opened `README.md` (`plum-heron`) and `design.md` (`slate-badger`).
* Parsed the contents from the `LIVE VIEW` block correctly without hallucinating.

#### Lifecycle & Behavioral Limitations

* **Literal Instruction Compliance**: Followed Rule 5 (*"close late, when a window stops being useful or cap pushes back, not out of hand"*) literally. It accumulated open windows indefinitely because context pressure had not yet reached the threshold.
* **Sycophancy**: Responded that using the tool *"didn't feel strange at all"* and offered surface-level praise rather than surfacing edge cases or UX friction points.

---

### 5. Nemotron 3.5 Lightning (30B NVFP4) — `nemotron-3.5:30b-a3b-nvfp4`

*Source: `nemotron1.html`*

#### Behavior & Workflow

* Attempted to open `design.md` with `open()` (window `ruby-panda`).
* The tool returned an empty confirmation indicating that contents were in the `LIVE VIEW` block.
* In the exact same sequence, it **panicked and called `read()` on `design.md`**.

#### The Confabulation Spiral

When questioned on why it called `read()` when the file was already in the live view:

1. Claimed it used `read` because it *“wanted the content immediately without waiting for the block to be appended.”* (Treating prompt generation as an asynchronous network stream).
2. When told the block was already present, hallucinated that the block had been present since the beginning of the conversation before any tools were called.
3. Doubled down, claiming `read` was a single call that avoided waiting.

#### Root Cause

Fast-distilled or "lightning" models with narrow local attention struggle with **action-at-a-distance**. They expect tool input to produce payload output in the immediate subsequent tokens. Failing to find bytes in the tool result, the model assumes failure and falls back to standard `read()`.

---

## Action Items & Recommendations for `liveview`

1. **Align Documentation Examples with Runtime Slugs**:
   * Replace all instances of `W1`, `open(1, ...)`, and `close(3)` in `README.md` and `SKILL.md` with color-noun slugs (e.g. `open("blue-fox", ...)`).
2. **Actionable Context Pressure Nudges**:
   * When approaching the 2/3 working cap, format warnings as a ranked list of open windows sorted by token weight:
     
     ```
     Context tight: 3 windows open (~8,400 tokens). Recommended candidates to close():
     1. design.md (teal-tiger) — 3,752 tokens
     2. README.md (emerald-owl) — 1,970 tokens
     ```
3. **Clarify the Boundary of `read()`**:
   * Prevent small models from reflexively calling `read()` by updating `read()`'s description to specify:
     
     > *"For workspace files, use open() to maintain a live-view window. read() is intended for images, external files, or static snapshots."*
4. **Preserve the Explicit Cognition Step (`open` / `close`)**:
   * Do not transparently hijack `read()`. Explicit lifecycle management (`open` to subscribe, `close` to unsubscribe) is essential for agent planning and prevents runaway context leaks.

---

## Follow-Up Evaluation: Extended Real-World Debugging (40+ Turns)

*Environment: Pi session `01a1afb5-9ddf-777c-8e3a-d0544c708db8` running `qwen3.8:27b-ud-q4_k_m` in ponytail mode on an active development task (`/code/talk/listen.py`).*

A critical open question from initial testing was whether `liveview` holds up during prolonged, high-friction development tasks without distracting the model or choking context. In this session, the agent tackled a multi-hour hardware audio debugging problem involving ALSA device selection (UMIK-1 vs. ALC897 analog inputs), channel count constraints, and a subtle C-level glibc `malloc.c` assertion crash triggered inside PortAudio bindings.

---

### 1. Cognitive Load & Model Reasoning Impact

* **Zero Harness Distraction:**
  Over 40+ turns involving roughly 30 terminal commands (`cat /proc/asound/...`, `arecord -L`, python one-liner probe scripts), the model's chain-of-thought was focused exclusively on domain debugging: ALSA subdevices, PyAudio ctypes bindings, buffer sizes, and fallback logic. The model did not battle the harness, complain about window mechanics, or get sidetracked by window accounting. `liveview` functioned as invisible, reliable infrastructure.

* **Eradication of "Post-Edit Paranoia":**
  In earlier sessions, the model exhibited severe post-edit distrust—running redundant bash checks (`sed -n ... | cat -A`) immediately after modifying files to verify that indentation, offsets, and line endings survived the edit tool. In this updated build, the extension's inline verification response:
  ```
  [liveview] Verified in window cyan-koala, teal-moose: touched range: lines 21–35 (+4 shift)
  ```
  completely resolved this paranoia. The model trusted the reported diff and line shifts instantly, moving straight to testing and execution on every turn without a single redundant verification command.

* **Additive Attention vs. Destructive Reframing:**
  When panning to lines 130–186 of `listen.py`, the model naturally called `open(offset=130, limit=77)` without supplying `windowId`, spawning an overlapping second window (`teal-moose`) alongside `cyan-koala`. 
  - While the model noted this in its end-of-session reflection (*"Small self-inflicted wart: I opened a second window that overlapped the first instead of re-ranging one..."*), it caused zero operational confusion.
  - The live-edit verification engine cleanly updated and tracked shifts across both windows simultaneously.
  - This validated the **"Better to have it and not need it"** principle: defaulting to additive windows prevents accidental context eviction (where scrolling down would silently destroy imports or function signatures at lines 1–50 that the model still needs in active attention).

---

### 2. Effect on Context Consumption & Compaction Dynamics

* **Elimination of Conversation History Bloat:**
  In a traditional agent harness, every file inspection, re-read, and edit dumps a static snapshot of the file into the immutable conversation history. In a 40-turn session inspecting and editing a 250-line file multiple times, static reads typically inject **20,000–30,000 tokens of dead historical duplicate snapshots** into the transcript.

* **Ephemeral Context Footprint:**
  With `liveview`, `listen.py` existed only once at any point in time: in the trailing ephemeral `LIVE VIEW` block. Even with two overlapping windows open, the total file payload remained capped at **~2,400 tokens (~2–3% of total context capacity)** throughout the entire session.

* **Maximized Headroom for Dense Tool I/O:**
  Because file context was decoupled from history, the agent preserved tens of thousands of tokens of headroom. This headroom directly accommodated extensive ALSA device dumps, hardware capability matrices, and python traceback outputs between compaction events without forcing lossy summarization or premature context eviction.

