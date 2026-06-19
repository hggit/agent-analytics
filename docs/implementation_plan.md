# Implementation Plan - Rich Dashboard Visualizations & Temporal-Style Workflow DAG

We will upgrade the agent analytics dashboard UI to introduce rich visual experiences, interactive SVG chart elements, a Temporal-style sequential DAG flow visualization, and a structured payload inspector for traces.

---

## User Review Required

> [!IMPORTANT]
> **Performance under High Trace Volume:**
> The trace DAG will be generated dynamically on the client side from the trace events fetched for the selected trace. For traces containing hundreds of steps, rendering a large SVG graph could impact performance. We will limit the DAG display or enable horizontal scrolling to keep it fluid.
>
> **No External Heavy Graph Libraries:**
> To keep the dashboard lightweight, stable, and fast-loading, we will implement the DAG flow and chart tooltips using raw SVG and React state, rather than introducing heavy third-party canvas or layout packages (like React Flow or D3).

---

## Open Questions

> [!NOTE]
> **DAG Layout Preference:**
> We propose a horizontal left-to-right (`Start -> Step 0 -> Step 1 -> ... -> End`) scrollable node graph for the workflow view, which fits well at the top of the Trace Details panel. Would you prefer a vertical top-to-bottom tree layout instead?
> 
> **Interactive Nodes:**
> We plan to bind interactive clicks to each step node in the DAG. Clicking a node will scroll the timeline panel directly to that step's details card and expand its JSON payload. Let us know if you have other specific workflow actions in mind (e.g. jumping between retries).

---

## Proposed Changes

### Frontend Dashboard (`apps/web`)

#### [MODIFY] [App.tsx](file:///Users/him/Desktop/mini-posthog-task-main/apps/web/src/App.tsx)
* **Interactive Charts (`SVGLineChart` & `SVGBarChart`):**
  - Add active state tracking for mouse position and hover elements.
  - Implement dynamic SVG tooltips displaying the exact value (e.g. `12,050 runs` or `$4.12 cost`) and timestamp on hover.
  - Style charts with smooth curves (bezier curves for lines), subtle gridlines, and radial/linear gradients.
* **Temporal-Style Workflow DAG (`SVGWorkflowDAG`):**
  - Create a new component `SVGWorkflowDAG` that maps the array of trace events sequentially.
  - Render Start, LLM Call, Tool Call, Error/Retry, and End nodes with custom color-coded styles:
    - **Start/End:** Rounded circular nodes.
    - **LLM Calls:** Purple badge nodes with model name and token metrics.
    - **Tool Calls:** Emerald green nodes with tool name.
    - **Errors:** Red-bordered nodes with error type.
    - **Retries:** Yellow warning nodes.
  - Draw sequence connector arrows with flow animation to represent the execution path.
  - Add an onClick handler to highlight and scroll to steps.
* **Structured Payload Inspector:**
  - Update the step details card to include a tabbed selector:
    - **Summary Tab:** Displays latency, status, and tokens in a clean layout.
    - **Payload Tab:** Pretty-prints the stringified `metadata` JSON (inputs, outputs, thoughts, etc.) with syntax-colored formatting.

#### [MODIFY] [index.css](file:///Users/him/Desktop/mini-posthog-task-main/apps/web/src/index.css)
* Add styling tokens for glassmorphism panels, workflow node graphs, step tabs, flow line animations, and custom scrollbars.
* Enhance hover transition micro-animations.

---

## Verification Plan

### Automated Tests
- Run `npm run test` on the host to verify that mock tests remain fully functional.

### Manual Verification
1. Start the services on the host (`npm run dev`).
2. Open http://localhost:5173/ in the browser.
3. Hover over the KPI charts and verify that interactive tooltips display exact numbers.
4. Click on a trace in the Trace Explorer and verify that the Workflow DAG renders at the top of the Trace Details panel.
5. Click on an LLM Call node in the DAG and check if the timeline automatically scrolls and highlights the step card.
6. Toggle between the **Summary** and **Payload** tabs for a step to inspect pretty-printed JSON parameters.
