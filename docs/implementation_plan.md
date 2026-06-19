# Implementation Plan - ClickHouse & Kafka Migration

We will evolve the analytics engine's backend architecture from a single-process DuckDB file store to a distributed production-grade setup:
1. **ClickHouse** as the primary high-performance OLAP database.
2. **Kafka (Redpanda)** as an ingestion buffer to absorb write spikes and ensure high throughput.
3. **Docker Compose** to run these services locally.

---

## User Review Required

> [!IMPORTANT]
> **Docker Requirement:**
> Running the backend will now require Docker and Docker Compose installed on your system to host ClickHouse and Kafka/Redpanda containers.
> 
> **ClickHouse SQL Dialect Differences:**
> ClickHouse uses a different SQL dialect than DuckDB. All queries (including presets and natural-language prompts) must be adapted:
> - Binning: `toStartOfHour(timestamp)` instead of `date_trunc('hour', timestamp)`.
> - String metadata extraction: ClickHouse JSON functions (`JSONExtractString(metadata, 'query')`) replace DuckDB arrow operators (`metadata->>'$.query'`).
> - Parametrization: ClickHouse client uses named parameters `{name: Type}` rather than positional `?` placeholders.

> [!WARNING]
> **Ingestion Flow Options (Kafka to ClickHouse Sink):**
> We have two choices for moving messages from the Kafka buffer to ClickHouse:
> 
> * **Option A: Node.js Batch Consumer (Recommended for local prototype)**
>   A background runner in `apps/api` polls the Kafka topic, buffers messages, and writes them to ClickHouse in batches of 1,000 or every 1.5 seconds.
>   * *Pros:* Very simple to write, mock, test in unit tests, and debug locally.
>   * *Cons:* Requires running a Node process that handles buffering logic.
> 
> * **Option B: ClickHouse Native Kafka Engine**
>   Define a table in ClickHouse using `ENGINE = Kafka`, then create a `MATERIALIZED VIEW` that reads from it and inserts into the target `events` table.
>   * *Pros:* Zero custom worker code; fully handled by ClickHouse.
>   * *Cons:* Complex local setup (requires ClickHouse to resolve the Kafka broker name inside the Docker network, and makes testing/mocking in unit tests much harder).
> 
> *Our recommendation is **Option A** for the local workspace to keep unit tests fully functional and database state easy to mock/isolate.*

---

## Open Questions

> [!NOTE]
> 1. **Message Broker Choice:** Do you prefer using **Redpanda** (fully Kafka-compatible, single binary, starts in <1 second, no Zookeeper) or standard **Apache Kafka + Zookeeper** for the local environment? (We recommend Redpanda for developer ease of use).
> 2. **Sink Pipeline:** Do you agree with using **Option A (Node.js Batch Consumer)** to simplify local setup and testing, or would you prefer **Option B (ClickHouse Kafka Engine)**?

---

## Proposed Changes

### Docker Infrastructure

#### [NEW] [docker-compose.yml](file:///Users/him/Desktop/mini-posthog-task-main/docker-compose.yml)
Set up ClickHouse and Redpanda containers:
- **ClickHouse:** Expose port `8123` (HTTP) for node client and `9000` (Native TCP).
- **Redpanda:** Expose port `9092` (Kafka API) for the node client.

---

### Backend API (`apps/api`)

#### [MODIFY] [package.json](file:///Users/him/Desktop/mini-posthog-task-main/apps/api/package.json)
- Add `@clickhouse/client` and `kafkajs` dependencies.
- Add `@types/kafkajs` (if using TypeScript typings) or dev dependencies.

#### [MODIFY] [db.ts](file:///Users/him/Desktop/mini-posthog-task-main/apps/api/src/db.ts)
- Replace `DuckDBEngine` with a `ClickHouseEngine` class wrapper.
- Update table schema to ClickHouse table engine format:
  ```sql
  CREATE TABLE IF NOT EXISTS events (
    eventId       UUID,
    traceId       String,
    runId         String,
    timestamp     DateTime64(3),
    agentName     String,
    userId        String,
    eventType     String,
    stepIndex     Int32,
    status        Nullable(String),
    latencyMs     Nullable(Int32),
    model         Nullable(String),
    toolName      Nullable(String),
    inputTokens   Nullable(Int32),
    outputTokens  Nullable(Int32),
    costUsd       Nullable(Float64),
    errorType     Nullable(String),
    metadata      String
  ) ENGINE = MergeTree()
  ORDER BY (agentName, timestamp, eventId);
  ```

#### [NEW] [kafka.ts](file:///Users/him/Desktop/mini-posthog-task-main/apps/api/src/kafka.ts)
- Initialize the Kafka client (`kafkajs`).
- Export a singleton `Producer` and `Consumer`.
- Implement `publishEvents(events)` to serialize and publish messages to the `agent-events` topic.
- Implement the background batching consumer (if Option A is selected).

#### [MODIFY] [capture.ts](file:///Users/him/Desktop/mini-posthog-task-main/apps/api/src/capture.ts)
- Update `captureHandler` to publish incoming event arrays directly to Kafka via the producer.
- Return success instantly with `inserted: events.length` (since write durability is now guaranteed by Kafka).
- Increment the global `dbRevision` when the consumer successfully completes a batch insert in ClickHouse to invalidate caching correctly.

#### [MODIFY] [query.ts](file:///Users/him/Desktop/mini-posthog-task-main/apps/api/src/query.ts)
- Replace database query calls with `ClickHouseEngine`.
- Update queries in `listTracesHandler` and `getKpisHandler` to ClickHouse SQL syntax:
  - Replace `MIN(timestamp)` and `MAX(timestamp)` with `dateDiff('ms', MIN(timestamp), MAX(timestamp))` for latency calculations.
  - Update `buildTraceIdFilters` to construct compliant ClickHouse queries.
- Update prompt guidelines in `translateWithGemini` to instruct the LLM to write ClickHouse-compatible SQL syntax.

#### [MODIFY] [index.ts](file:///Users/him/Desktop/mini-posthog-task-main/apps/api/src/index.ts)
- Connect to ClickHouse and initialize the Kafka producer/consumer on startup.
- Add a graceful shutdown handler to flush remaining events and close connections.

---

## Verification Plan

### Automated Tests
- Extend the unit tests in `tests/run-tests.ts`:
  - Mock ClickHouse client and Kafka producer/consumer for offline validation.
  - Test batch ingestion buffering in the Kafka pipeline.
  - Test ClickHouse SQL query generation and filtering logic.

### Manual Verification
1. Run `docker-compose up -d` to launch local ClickHouse and Redpanda containers.
2. Run `npm run simulate:demo` to send test traces through the pipeline.
3. Verify events are successfully captured by Kafka and batched into ClickHouse by checking console logs.
4. Verify the frontend React dashboard displays correct charts and trace timeline explorer.
5. Kill the ClickHouse container, send events, restart ClickHouse, and verify that Kafka successfully buffers and delivers the events after recovery.
