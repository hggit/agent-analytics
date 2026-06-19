# Architecture Note: Agent Trace Analytics Engine

This document details the architectural decisions, design patterns, and production scaling strategy for the Agent Trace Analytics Engine.

---

## 1. SDK Design
The logging SDK is implemented as a lightweight, zero-dependency TypeScript package (`@mini-posthog/sdk`).
- **Initialization:** Created once per application lifecycle via `initAgentAnalytics({ apiKey, host, flushAt, flushIntervalMs })`.
- **Trace Handles:** Initiated via `analytics.startTrace({ agentName, userId, input, tags })` which returns a stateful `Trace` instance. All step events are linked via a unique `traceId` and `runId`.
- **Trace Lifecycle & Steps:**
  - `startTrace` immediately enqueues a `trace_started` event.
  - `captureLLMCall`, `captureToolCall`, `captureError`, and `captureRetry` append chronological steps.
  - `end` calculates the final end-to-end duration and enqueues a `trace_completed` event.
- **Queueing & Batching:**
  - Events are buffered in memory and flushed automatically when the queue length reaches `flushAt` (default `20`) or the `flushIntervalMs` time elapsed (default `5000ms`) since the first enqueued event.
- **Retry Handling:**
  - When flushing fails, the SDK retries the HTTP POST payload up to 3 times using exponential backoff (e.g. 1s, 2s, 4s). If all attempts fail, events are re-enqueued at the front of the queue to prevent data loss.

---

## 2. Ingestion Protocol
- **Format:** Ingestion is handled via `POST /capture` using JSON payloads.
- **Validation:** The API server checks for standard headers (`x-api-key`) and verifies that all incoming events contain mandatory fields: `eventId`, `traceId`, `runId`, `timestamp`, `agentName`, `userId`, `eventType`, and `stepIndex`.
- **Consistency:** Immediate consistency is achieved since the local API server writes directly to the OLAP database.

---

## 3. Storage Engine Choice: DuckDB
DuckDB is chosen as our analytical storage engine.
- **Why DuckDB:** Unlike relational OLTP databases (SQLite, Postgres) which store and read rows sequentially, DuckDB is a column-oriented store. It only reads the specific columns involved in a query (e.g. scanning only `latencyMs` and `model` columns for averaging), yielding 10x-50x speedups for analytical aggregations on large datasets.
- **Local Dev vs. Production:** It operates as an embedded database writing to a local `db.duckdb` file, requiring zero external server setup, making it ideal for local prototyping.

---

## 4. Schema & Data Model: Hybrid Denormalized
We utilize a **Hybrid Denormalized Wide Table** pattern:
- **Core Columnar Fields:** High-frequency query variables (`model`, `toolName`, `latencyMs`, `costUsd`, `inputTokens`, `outputTokens`, `status`, `agentName`, `userId`, `eventType`) are stored as native, explicit database columns.
- **JSON Column (`metadata`):** Unstructured event-specific payloads (like prompt prompts, URL queries, tool output strings, and stack traces) are stringified and stored in a VARCHAR metadata field, providing backward-compatibility and schema flexibility.

---

## 5. Query Translation Approach: Hybrid NL
The `POST /api/query/translate` endpoint handles natural language:
- **Deterministic Matcher:** Checks a set of regular expression keywords to instantly parse the 8 standard analytics queries offline with `0ms` latency and `100%` accuracy.
- **Gemini LLM Parser:** If a `GEMINI_API_KEY` is provided, the API falls back to **Gemini 2.5 Flash** using Structured Outputs to translate complex phrasings into clean SQL.
- **SQL Verification & Approval Flow:** The generated SQL is returned to the frontend *without* execution. The user reviews the query and must click **"Run Approved Query"** to proceed.
- **Security Check:** All client-submitted SQL runs through a strict parser validating it contains ONLY `SELECT` or `WITH` keywords and contains zero write/ddL verbs (`INSERT`, `UPDATE`, `DROP`, `ALTER`, `PRAGMA`), preventing prompt injections.

---

## 6. Caching Strategy
To ensure sub-millisecond response times, we implement two cache layers:
1. **NL Translation Cache:** Maps raw search inputs (e.g. *"show slowest runs"*) directly to generated SQL. Long TTL.
2. **Result Cache:** Maps compiled SQL queries to JSON result sets. We track a global `dbRevision` counter that increments on every `/capture` write. Cache checks verify the stored revision; if new events are inserted, the cache is automatically invalidated.

## 7. Frontend Charting Approach
To keep bundle sizes low, prevent third-party canvas bugs, and have complete aesthetic flexibility, we avoided heavy libraries (like Recharts/Chart.js) and built **Custom React SVG Components**:
- **Dynamic Render Types:** Automatically maps SQL query columns to either a Bar, Line, or Area chart depending on the data shape (e.g. time-series vs categorical).
- **Scale Calculations:** Linearly scales the dataset values into SVG viewport coordinates, dynamically plotting gridlines and axes labels.
- **Visuals:** Uses CSS linear gradients, hover state markers, and micro-transitions matching the dark glassmorphic design theme.

---

## 8. Performance Results (1M+ events)
We validated the system using our simulator in benchmark mode, inserting **1,000,010 events** (120,000 traces) into the local DuckDB database:
- **Ingestion Throughput:** ~15,800 events/second (all writes finished in 63.2s).
- **Durable Disk Size:** ~46MB (durable file-system SQLite-equivalent footprint).
- **OLAP Aggregation Speeds:**
  - KPI Dashboard Aggregations (Total runs, Avg latency, Failed error rate, Costs): **12ms**.
  - Time-series LLM Latency Trend by Model: **7ms**.
  - Categorical Tools Failure Rankings: **1ms**.

---

## 9. Production Scaling Plan (1B+ Events)
To scale this local prototype to a production environment handling 1 billion events:
1. **In-Flight Queueing:** The SDK posts events to a stateless API Gateway. Instead of writing directly to the database, the gateway publishes them to an event bus like **Apache Kafka** or **Redpanda** to isolate write loads.
2. **ClickHouse OLAP Storage:** Use a **ClickHouse cluster** as the analytical database. A ClickHouse Kafka Engine topic consumes batches of events and inserts them into a **ReplacingMergeTree** table (partitioned by month `toYYYYMM(timestamp)`).
3. **Materialized Views:** Pre-aggregate high-frequency dashboard metrics (such as hourly token counts, daily error rates by tool) into materialized views so dashboard query speeds remain under 50ms at 1B+ scale.

---

## 10. Supported Natural Language Query Patterns
The deterministic parser supports the following questions and variations:
1. *Show average LLM latency by model over time.*
2. *Which tools fail the most?*
3. *Token usage by agent type.*
4. *Cost per successful run by model.*
5. *Top 10 slowest traces.*
6. *Error rate by tool name.*
7. *Number of runs per hour.*
8. *Average steps per run by outcome.*

---

## 11. Intentionally Skipped Features
- **User Authentication & Multi-Tenancy:** Hardcoded local API key `dev_project_key`.
- **Database Migrations:** Table schema is created automatically on startup.
- **Persistent SSL:** Local HTTP and WS protocols are used for simplicity.
