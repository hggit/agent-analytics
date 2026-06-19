# Work Trial Task: Agent Trace Analytics Engine

Build a mini PostHog/Mixpanel-style analytics product for AI agent traces.

The goal is to evaluate how you think across SDK design, ingestion, storage
engine choice, query performance, frontend UX, infrastructure tradeoffs, and
product scope. This should be scoped as a credible 6-hour prototype. We care
more about a thoughtful, working vertical slice than a broad unfinished system.

## Setup and Run Instructions

This project is organized as an npm workspaces monorepo containing the following components:
* **`packages/sdk`:** The logging SDK.
* **`apps/api`:** The Express API server backed by a ClickHouse database and Kafka (Redpanda) ingestion queue.
* **`apps/web`:** The Vite React web client.
* **`simulator`:** A simulator runner script to generate telemetry events.

---

### Option A: Quick Containerized Deployment (Recommended)
You can spin up the entire full-stack application (ClickHouse, Redpanda broker, Ingestion API, and Frontend dashboard) using a single command without needing Node.js or any local dependencies installed:

1. Start all containerized services:
   ```bash
   docker-compose up --build -d
   ```
2. Once running:
   - **Web Dashboard:** http://localhost:5173
   - **Ingestion API:** http://localhost:3000
3. Seed telemetry data into the running container stack:
   - **Demo mode (creates ~80 events):**
     ```bash
     npm run simulate:demo
     ```
   - **Benchmark mode (creates ~1,000,000 events):**
     ```bash
     npm run simulate:benchmark
     ```

---

### Option B: Local Development Run (Requires Docker for DB & Queue)

#### 1. Prerequisites
* **Node.js:** v18 or later.
* **Docker:** Installed and running (for local ClickHouse and Redpanda containers).
* **Optional:** A `GEMINI_API_KEY` environment variable configured if you want to use the hybrid LLM natural-language SQL generation feature. If not set, the dashboard will fall back to its offline deterministic parser for the 8 standard questions.

#### 2. Run Infrastructure Containers
Spin up the local ClickHouse database and Redpanda event broker:
```bash
docker-compose up -d clickhouse redpanda
```

#### 3. Installation
Install all dependencies in the workspaces monorepo:
```bash
npm install
```

#### 4. Run Automated Tests
Run the unit test suite to verify the SDK queue batching, SQL injection safety validation, trace explorer single-pass aggregation query, status/agent filtering, and KPI calculation:
```bash
npm run test
```

#### 5. Start Dev Servers
Start both the Express API server and the Vite React frontend dev server concurrently on your local machine:
```bash
npm run dev
```
* **Express API Server:** http://localhost:3000
* **Web Frontend:** http://localhost:5173

#### 6. Run Telemetry Simulator
While the dev servers are running, seed the ClickHouse database through the Redpanda ingestion broker:
- **Demo mode (creates ~80 events):**
  ```bash
  npm run simulate:demo
  ```
- **Benchmark mode (creates ~1,000,000 events):**
  ```bash
  npm run simulate:benchmark
  ```

Once seeded, visit http://localhost:5173 in your browser to interact with the dashboard, run natural language queries, and view step-by-step trace explorer timelines.

---

## Product Goal

AI agents can run for many steps. A single run may include a user prompt,
multiple LLM calls, tool calls, retries, errors, intermediate reasoning steps,
and a final response.

Your task is to build an end-to-end analytics system that can log those traces
and make them immediately explorable.

A user should be able to ask questions like:

- "Show average LLM latency by model over time."
- "Which tools fail the most?"
- "Token usage by agent type."
- "Cost per successful run by model."
- "Top 10 slowest traces."
- "Error rate by tool name."
- "Number of runs per hour."
- "Average steps per run by outcome."

The app should return a useful chart or table quickly for supported queries on
a large local dataset.

## What To Build

Build a local full-stack prototype with:

- A JS/TS SDK for logging agent traces.
- SDK batching and flush behavior.
- An ingestion API.
- Durable local storage.
- A query API for analytics.
- A natural-language query input.
- Chart/table rendering.
- A trace/run explorer.
- A toy agent simulator that uses your SDK to generate realistic traces.

The example fixture in [`fixtures/example-events.json`](fixtures/example-events.json)
is only guidance. You own the event model, logging API design, batching
behavior, storage model, and query strategy.

## Non-Goals

Do not spend time on:

- Production authentication.
- Billing.
- Cloud deployment.
- Complex permissions.
- Full multi-tenant account management.
- Pixel-perfect UI polish.

It is fine to hardcode local development credentials and project IDs if the
tradeoff is documented.

## Expected SDK Shape

The SDK should feel PostHog-like: initialize once, capture events through a
simple API, batch automatically, retry failed sends where reasonable, and expose
an explicit flush method.

Example:

```ts
const analytics = initAgentAnalytics({
  apiKey: "dev_project_key",
  host: "http://localhost:3000",
  flushAt: 50,
  flushIntervalMs: 5000,
});

const trace = analytics.startTrace({
  agentName: "research-agent",
  userId: "user_123",
  input: "Find pricing for sandbox providers",
});

trace.captureLLMCall({
  model: "gpt-5.2",
  latencyMs: 842,
  inputTokens: 1200,
  outputTokens: 310,
  costUsd: 0.0142,
});

trace.captureToolCall({
  toolName: "web_search",
  latencyMs: 1200,
  status: "success",
});

trace.captureError({
  errorType: "rate_limit",
  message: "Provider returned 429",
});

trace.end({
  status: "success",
  output: "Completed research summary",
});

await analytics.flush();
```

Your exact API can differ, but it must support:

- Trace lifecycle: start, events, end.
- Step-level events.
- LLM calls.
- Tool calls.
- Errors and retries.
- Metadata and tags.
- Batching by count and/or time.
- Retry behavior for failed ingestion.
- Explicit flush on shutdown.

## Backend Requirements

Implement:

- A capture endpoint, for example `POST /capture`.
- Validation for required event fields.
- A local project/API-key concept, even if hardcoded for local development.
- Durable persistence.
- Query endpoints used by the frontend.
- Safe natural-language query handling.

Natural-language support can use deterministic parsing, an LLM-backed planner,
or a hybrid. If you use an LLM, it must produce a constrained query/chart plan.
Do not execute arbitrary generated code or arbitrary generated SQL directly.

## Storage Engine Decision

A key part of this task is choosing the right analytical storage approach.

Include a short decision note comparing at least two options, preferably from:

- ClickHouse
- DuckDB
- Postgres
- SQLite
- Parquet files
- Any other justified OLAP/event-store option

Explain:

- Why you chose the engine.
- Expected query patterns.
- Write and ingestion tradeoffs.
- Indexing, partitioning, or materialization strategy.
- Local development complexity.
- Whether the choice would still work in production.
- What you would change at 10M, 100M, and 1B events.

We do not expect production infrastructure, but we do expect production
judgment.

## Frontend Requirements

Build a simple analytics UI with:

- Natural-language query input.
- Example questions.
- Chart/table output.
- Visible query latency.
- Trace/run explorer.
- Filters for time range, agent name, model, tool name, and status.

The UI does not need to be beautiful, but it should be usable enough to
understand the product and evaluate the core workflows.

## Simulator Requirements

Build a toy agent simulator that imports and uses your SDK.

It should generate traces with:

- Multiple agents.
- Multiple users.
- Multiple models.
- Multiple tools.
- Successes and failures.
- Retries and errors.
- Variable latency, token usage, and cost.
- Enough volume to benchmark query speed.

It should support:

- A small demo dataset for quick local testing.
- A larger local benchmark dataset around 1M events.

## Example Fixture

See [`fixtures/example-events.json`](fixtures/example-events.json) for a small
example trace. This is only a starting point. Change the model if your design
calls for a different schema.

Possible event types include:

- `trace_started`
- `step_completed`
- `llm_call`
- `tool_call`
- `error`
- `retry`
- `trace_completed`

## Suggested Repository Shape

Use whatever structure best fits your stack. One reasonable shape is:

```txt
.
├── apps/
│   ├── web/          # Frontend UI
│   └── api/          # Ingestion and query API
├── packages/
│   └── sdk/          # JS/TS logging SDK
├── simulator/        # Toy agent simulator
├── docs/
│   └── architecture.md
└── README.md
```

This structure is not required. Keep the repo simple if a simpler structure
helps you finish a better vertical slice.

## Evaluation Levels

### Level 1: Basic Vertical Slice

- SDK sends events.
- Backend stores events.
- UI shows traces.
- A few hardcoded analytics queries work.

### Level 2: Real Analytics Prototype

- Good trace/event model.
- Batching and retries work.
- Multiple chart types.
- Query latency is visible.
- Natural-language examples map to real queries.

### Level 3: Strong Systems Thinking

- Clear storage engine decision.
- Sensible indexing or materialization strategy.
- Handles a large generated dataset.
- Common queries return quickly.
- Unsupported queries fail cleanly.

### Level 4: Production Judgment

- Explains scaling path to larger event volumes.
- Discusses ClickHouse, DuckDB, Postgres, or similar tradeoffs well.
- Shows awareness of ingestion backpressure, schema evolution, multi-tenancy,
  retention, and cost.
- Keeps implementation simple while documenting what would change in production.

## Deliverables

Submit a GitHub repository containing:

- Working local app.
- JS/TS SDK inside the repo.
- Toy agent simulator using the SDK.
- Setup and run instructions in your submitted README.
- Short architecture note covering:
  - SDK design.
  - Batching and retry behavior.
  - Ingestion protocol.
  - Storage engine choice.
  - Schema/data model.
  - Query translation approach.
  - Frontend charting approach.
  - Performance results.
  - Production scaling notes.
- List of supported natural-language query patterns.
- Notes on what was intentionally skipped.

## Success Criteria

A strong submission should demonstrate end-to-end product thinking, not just
isolated coding ability.

We are looking for:

- Clean implementation.
- Practical storage choice.
- Fast enough analytical queries.
- Thoughtful batching and ingestion design.
- Usable frontend.
- Clear tradeoff reasoning.
- Ability to scope a large product into a credible 6-hour prototype.

The best submissions will make the system work, explain why it works, and
clearly describe what would change for production scale.
