# Implementation Plan - Enhanced Trace Details Width & Advanced Analytics Metrics

We will enhance the trace details panel by widening it to maximize workflow DAG visibility and adding rich, structured analytics metrics to both the DAG nodes and the step timeline cards.

---

## User Review Required

> [!IMPORTANT]
> **Panel Width Adjustments:**
> We are changing the `.timeline-panel` width from `800px` to `min(1100px, 90vw)`. This allows the panel to occupy more screen space on wider desktop displays, revealing more workflow DAG nodes without needing to scroll. On smaller viewports, it falls back to 90% of the screen width.
>
> **Metrics Enrichment Layout:**
> We will introduce structured grids and blockquotes to preview prompts and outputs directly inside the "Summary" tab of step cards. This eliminates the need to constantly toggle the "Payload (JSON)" tab for common tasks.

---

## Proposed Changes

### Frontend Dashboard (`apps/web`)

#### [MODIFY] [index.css](file:///Users/him/Desktop/mini-posthog-task-main/apps/web/src/index.css)
* **Panel Width:** Increase width of `.timeline-panel` to `min(1100px, 90vw)`.
* **Summary Layouts:** Add styling rules for `.trace-summary-card` (the overall trace summary grid) and individual step card layouts (structured grids, tag badges, prompt blockquotes).

#### [MODIFY] [App.tsx](file:///Users/him/Desktop/mini-posthog-task-main/apps/web/src/App.tsx)
* **Overall Trace Summary Card:**
  - Calculate global stats for the selected trace: total duration, total cost, total tokens used (input vs output), steps breakdown (LLMs, Tools, Errors, Retries), and average LLM performance (latency and throughput speed).
  - Render these as a premium KPI grid at the top of the trace details view.
* **Enriched Event Meta:**
  - Add accumulated tokens tracking (`accumulatedTokens`, `accumulatedInputTokens`, `accumulatedOutputTokens`) alongside the existing accumulated cost and elapsed time.
* **Workflow DAG Nodes:**
  - Expand text meta inside the DAG nodes:
    - **LLM Calls:** Add total tokens, throughput speed, and step cost: `+1.2s | 750t | 625t/s | $0.0053`.
    - **Tool Calls:** Include latency, status, and cost if applicable.
    - **Errors:** Parse metadata to extract error message snippet.
    - **Retries:** Extract and display attempt count: `Attempt #2`.
    - **Completed:** Show total elapsed time, total accumulated tokens, and final cost.
* **Trace Step Card:**
  - Redesign the **Summary Tab** to use a structured, highly readable layout instead of a plain text block.
  - Show a dedicated **Token & Latency Metric Grid** (latency, input tokens, output tokens, total tokens, speed, step cost, accumulated tokens, accumulated cost).
  - Extract and display a **Prompt / Output Blockquote Preview** (e.g. for `trace_started` input prompt, `llm_call` route/input/response, `tool_call` arguments/results, `error` message, `trace_completed` final response).

---

## Verification Plan

### Automated Tests
- Run `npm run test` on the host.

### Manual Verification
1. Open the dev server (`npm run dev`).
2. Select a trace with several steps.
3. Verify that the Trace Details panel slides out wider, presenting more of the DAG.
4. Check that the new **Overall Trace Summary Card** is visible above the DAG.
5. Hover and click nodes on the DAG; confirm the node label displays latency, cost, and tokens.
6. Verify that step cards show structured token grids, latency, cost, and a clean preview of prompts and outputs.
