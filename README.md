# Agent Trace Analytics Engine

A mini PostHog/Mixpanel-style analytics product for AI agent traces.

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
