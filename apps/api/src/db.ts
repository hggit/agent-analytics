import { createClient, ClickHouseClient } from '@clickhouse/client';

export interface DbEngineInterface {
  all(sql: string, params?: Record<string, any>): Promise<any[]>;
  exec(sql: string): Promise<void>;
  insertEvents(events: any[]): Promise<void>;
  close(): Promise<void>;
}

class ClickHouseEngine implements DbEngineInterface {
  private client: ClickHouseClient;

  constructor() {
    this.client = createClient({
      host: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
      username: process.env.CLICKHOUSE_USER || 'default',
      password: process.env.CLICKHOUSE_PASSWORD !== undefined ? process.env.CLICKHOUSE_PASSWORD : 'clickhouse_password',
      database: process.env.CLICKHOUSE_DB || 'default',
    });
  }

  public async all(sql: string, params: Record<string, any> = {}): Promise<any[]> {
    try {
      const resultSet = await this.client.query({
        query: sql,
        query_params: params,
        format: 'JSONEachRow',
      });
      return await resultSet.json<any>();
    } catch (err) {
      console.error('[ClickHouse Engine] Query error:', err, 'SQL:', sql);
      throw err;
    }
  }

  public async exec(sql: string): Promise<void> {
    try {
      await this.client.exec({ query: sql });
    } catch (err) {
      console.error('[ClickHouse Engine] Exec error:', err, 'SQL:', sql);
      throw err;
    }
  }

  public async insertEvents(events: any[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.client.insert({
        table: 'events',
        values: events.map(e => ({
          eventId: e.eventId,
          traceId: e.traceId,
          runId: e.runId,
          timestamp: e.timestamp,
          agentName: e.agentName,
          userId: e.userId,
          eventType: e.eventType,
          stepIndex: e.stepIndex,
          status: e.status || null,
          latencyMs: e.latencyMs !== undefined && e.latencyMs !== null ? Number(e.latencyMs) : null,
          model: e.model || null,
          toolName: e.toolName || null,
          inputTokens: e.inputTokens !== undefined && e.inputTokens !== null ? Number(e.inputTokens) : null,
          outputTokens: e.outputTokens !== undefined && e.outputTokens !== null ? Number(e.outputTokens) : null,
          costUsd: e.costUsd !== undefined && e.costUsd !== null ? Number(e.costUsd) : null,
          errorType: e.errorType || null,
          metadata: JSON.stringify(e.metadata || {}),
        })),
        format: 'JSONEachRow',
      });
    } catch (err) {
      console.error('[ClickHouse Engine] Bulk insert error:', err);
      throw err;
    }
  }

  public async close(): Promise<void> {
    await this.client.close();
  }
}

class MockClickHouseEngine implements DbEngineInterface {
  private events: any[] = [];

  public async all(sql: string, params: Record<string, any> = {}): Promise<any[]> {
    let filteredEvents = [...this.events];

    // Simple mock filter logic based on SQL queries or params
    if (params.agentNameFilter) {
      filteredEvents = filteredEvents.filter(e => {
        const traceIds = new Set(this.events.filter(evt => evt.agentName === params.agentNameFilter).map(evt => evt.traceId));
        return traceIds.has(e.traceId);
      });
    }
    if (params.statusFilter) {
      filteredEvents = filteredEvents.filter(e => {
        const traceIds = new Set(this.events.filter(evt => evt.eventType === 'trace_completed' && evt.status === params.statusFilter).map(evt => evt.traceId));
        return traceIds.has(e.traceId);
      });
    }
    if (params.modelFilter) {
      filteredEvents = filteredEvents.filter(e => {
        const traceIds = new Set(this.events.filter(evt => evt.eventType === 'llm_call' && evt.model === params.modelFilter).map(evt => evt.traceId));
        return traceIds.has(e.traceId);
      });
    }
    if (params.toolNameFilter) {
      filteredEvents = filteredEvents.filter(e => {
        const traceIds = new Set(this.events.filter(evt => evt.eventType === 'tool_call' && evt.toolName === params.toolNameFilter).map(evt => evt.traceId));
        return traceIds.has(e.traceId);
      });
    }
    if (sql.includes("NOT IN (SELECT DISTINCT traceId FROM events WHERE eventType = 'trace_completed')") || params.statusFilter === 'running') {
      const completedTraceIds = new Set(this.events.filter(evt => evt.eventType === 'trace_completed').map(evt => evt.traceId));
      filteredEvents = filteredEvents.filter(e => !completedTraceIds.has(e.traceId));
    }

    const cleanSql = sql.toUpperCase();

    // 1. KPI query
    if (cleanSql.includes('COUNT(DISTINCT TRACEID)') && cleanSql.includes('AVG(')) {
      const traceIds = Array.from(new Set(filteredEvents.map(e => e.traceId)));
      const completedEvents = filteredEvents.filter(e => e.eventType === 'trace_completed');
      
      const totalTraces = traceIds.length;
      
      const completedLatencies = completedEvents.map(e => e.latencyMs).filter(l => l !== null && l !== undefined);
      const avgTraceLatencyMs = completedLatencies.length > 0 
        ? completedLatencies.reduce((a, b) => a + b, 0) / completedLatencies.length 
        : 0;

      const failedCompletedCount = completedEvents.filter(e => e.status === 'failed').length;
      const errorRate = totalTraces > 0 ? (failedCompletedCount * 100.0) / totalTraces : 0;

      const totalCostUsd = filteredEvents.reduce((sum, e) => sum + (Number(e.costUsd) || 0), 0);

      return [{
        totalTraces,
        avgTraceLatencyMs,
        errorRate,
        totalCostUsd
      }];
    }

    // 2. Trace List aggregation
    if (cleanSql.includes('GROUP BY TRACEID')) {
      const traceGroups = new Map<string, any[]>();
      for (const e of filteredEvents) {
        if (!traceGroups.has(e.traceId)) {
          traceGroups.set(e.traceId, []);
        }
        traceGroups.get(e.traceId)!.push(e);
      }

      const rows: any[] = [];
      for (const [traceId, group] of traceGroups.entries()) {
        const sorted = [...group].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const startEvent = sorted.find(e => e.eventType === 'trace_started');
        const completedEvent = sorted.find(e => e.eventType === 'trace_completed');
        
        const firstEvent = sorted[0];
        const lastEvent = sorted[sorted.length - 1];

        const agentName = startEvent ? startEvent.agentName : firstEvent.agentName;
        const userId = startEvent ? startEvent.userId : firstEvent.userId;
        const runId = firstEvent.runId;
        const startedAt = firstEvent.timestamp;
        const endedAt = completedEvent ? completedEvent.timestamp : null;
        const status = completedEvent ? completedEvent.status : 'running';
        
        let totalLatencyMs = 0;
        if (completedEvent && completedEvent.latencyMs !== null) {
          totalLatencyMs = completedEvent.latencyMs;
        } else {
          totalLatencyMs = Math.max(0, new Date(lastEvent.timestamp).getTime() - new Date(firstEvent.timestamp).getTime());
        }

        const totalCostUsd = group.reduce((sum, e) => sum + (Number(e.costUsd) || 0), 0);
        const llmCalls = group.filter(e => e.eventType === 'llm_call').length;
        const toolCalls = group.filter(e => e.eventType === 'tool_call').length;
        const errorCount = group.filter(e => e.eventType === 'error').length;

        rows.push({
          traceId,
          runId,
          agentName,
          userId,
          startedAt,
          endedAt,
          status,
          totalLatencyMs,
          totalCostUsd,
          llmCalls,
          toolCalls,
          errorCount
        });
      }

      rows.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
      return rows.slice(0, 100);
    }

    return filteredEvents;
  }

  public async exec(sql: string): Promise<void> {
    // NOOP
  }

  public async insertEvents(events: any[]): Promise<void> {
    this.events.push(...events);
  }

  public async close(): Promise<void> {
    // NOOP
  }
}

export let dbEngine: DbEngineInterface;

export async function initDatabase(dbPath: string = ''): Promise<DbEngineInterface> {
  if (process.env.NODE_ENV === 'test' || dbPath === ':memory:' || process.argv.some(arg => arg.includes('run-tests'))) {
    dbEngine = new MockClickHouseEngine();
    console.log('[ClickHouse Mock] Mock database engine initialized successfully.');
  } else {
    dbEngine = new ClickHouseEngine();
    const maxRetries = 10;
    const retryIntervalMs = 3000;
    let retries = 0;
    while (true) {
      try {
        await dbEngine.exec(`
          CREATE TABLE IF NOT EXISTS events (
            eventId       String,
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
        `);
        console.log('[ClickHouse] ClickHouse database connection initialized successfully.');
        break;
      } catch (err) {
        retries++;
        if (retries >= maxRetries) {
          console.error(`[ClickHouse] Failed to connect after ${maxRetries} attempts. Error:`, err);
          throw err;
        }
        console.warn(`[ClickHouse] Connection failed (attempt ${retries}/${maxRetries}). Retrying in ${retryIntervalMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
      }
    }
  }
  return dbEngine;
}
