export interface SDKConfig {
  apiKey: string;
  host: string;
  flushAt?: number;
  flushIntervalMs?: number;
}

export interface TraceConfig {
  agentName: string;
  userId: string;
  input: string;
  tags?: string[];
}

export interface LLMCallData {
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  metadata?: Record<string, any>;
}

export interface ToolCallData {
  toolName: string;
  latencyMs: number;
  status: 'success' | 'failed' | string;
  metadata?: Record<string, any>;
}

export interface ErrorData {
  errorType: string;
  message: string;
  toolName?: string;
  metadata?: Record<string, any>;
}

export interface RetryData {
  toolName: string;
  attempt: number;
  metadata?: Record<string, any>;
}

export interface TraceEndData {
  status: 'success' | 'failed' | string;
  output: string;
  metadata?: Record<string, any>;
}

export interface AnalyticsEvent {
  eventId: string;
  traceId: string;
  runId: string;
  timestamp: string;
  agentName: string;
  userId: string;
  eventType: 'trace_started' | 'llm_call' | 'tool_call' | 'error' | 'retry' | 'trace_completed';
  stepIndex: number;
  status?: string;
  latencyMs?: number | null;
  model?: string | null;
  toolName?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  errorType?: string | null;
  metadata: Record<string, any>;
}

function generateId(prefix: string): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let rand = '';
  for (let i = 0; i < 12; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${prefix}_${rand}`;
}

export class AgentAnalytics {
  private apiKey: string;
  private host: string;
  private flushAt: number;
  private flushIntervalMs: number;
  private queue: AnalyticsEvent[] = [];
  private timer: any = null;
  private flushPromise: Promise<void> | null = null;

  constructor(config: SDKConfig) {
    this.apiKey = config.apiKey;
    this.host = config.host.replace(/\/$/, ''); // Remove trailing slash
    this.flushAt = config.flushAt ?? 20;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;
  }

  public startTrace(config: TraceConfig): Trace {
    const traceId = generateId('trace');
    const runId = generateId('run');
    return new Trace(this, traceId, runId, config);
  }

  public enqueue(event: AnalyticsEvent): void {
    this.queue.push(event);
    if (this.queue.length >= this.flushAt) {
      this.flush().catch((err) => console.error('[AgentAnalytics] Auto-flush error:', err));
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush().catch((err) => console.error('[AgentAnalytics] Interval-flush error:', err));
      }, this.flushIntervalMs);
    }
  }

  public async flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    if (this.queue.length === 0) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const batch = [...this.queue];
    this.queue = [];

    this.flushPromise = (async () => {
      let attempt = 1;
      const maxAttempts = 3;
      let delay = 1000;
      let success = false;

      while (attempt <= maxAttempts) {
        try {
          const response = await fetch(`${this.host}/capture`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': this.apiKey,
            },
            body: JSON.stringify({ events: batch }),
          });

          if (response.ok) {
            success = true;
            break;
          } else {
            throw new Error(`Server returned status ${response.status}`);
          }
        } catch (error) {
          console.warn(`[AgentAnalytics] Flush attempt ${attempt} failed:`, error);
          attempt++;
          if (attempt <= maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay *= 2; // Exponential backoff
          }
        }
      }

      if (!success) {
        console.error(`[AgentAnalytics] All ${maxAttempts} flush attempts failed. Re-enqueueing ${batch.length} events.`);
        this.queue = [...batch, ...this.queue];
      }
      this.flushPromise = null;
    })();

    return this.flushPromise;
  }
}

export class Trace {
  private analytics: AgentAnalytics;
  private traceId: string;
  private runId: string;
  private agentName: string;
  private userId: string;
  private tags: string[];
  private stepIndex = 0;
  private startTime: number;

  constructor(analytics: AgentAnalytics, traceId: string, runId: string, config: TraceConfig) {
    this.analytics = analytics;
    this.traceId = traceId;
    this.runId = runId;
    this.agentName = config.agentName;
    this.userId = config.userId;
    this.tags = config.tags ?? [];
    this.startTime = Date.now();

    // Support simulation timestamp backdating
    const eventTimestamp = (config as any)._timestamp || new Date().toISOString();

    // Enqueue trace_started event
    this.analytics.enqueue({
      eventId: generateId('evt'),
      traceId: this.traceId,
      runId: this.runId,
      timestamp: eventTimestamp,
      agentName: this.agentName,
      userId: this.userId,
      eventType: 'trace_started',
      stepIndex: this.stepIndex++,
      status: 'running',
      latencyMs: null,
      model: null,
      toolName: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      errorType: null,
      metadata: {
        input: config.input,
        tags: this.tags,
      },
    });
  }

  public captureLLMCall(data: LLMCallData): void {
    const { _timestamp, ...cleanMetadata } = (data.metadata || {}) as any;
    const eventTimestamp = _timestamp || new Date().toISOString();

    this.analytics.enqueue({
      eventId: generateId('evt'),
      traceId: this.traceId,
      runId: this.runId,
      timestamp: eventTimestamp,
      agentName: this.agentName,
      userId: this.userId,
      eventType: 'llm_call',
      stepIndex: this.stepIndex++,
      status: 'success',
      latencyMs: data.latencyMs,
      model: data.model,
      toolName: null,
      inputTokens: data.inputTokens ?? null,
      outputTokens: data.outputTokens ?? null,
      costUsd: data.costUsd ?? null,
      errorType: null,
      metadata: {
        ...cleanMetadata,
        tags: this.tags,
      },
    });
  }

  public captureToolCall(data: ToolCallData): void {
    const { _timestamp, ...cleanMetadata } = (data.metadata || {}) as any;
    const eventTimestamp = _timestamp || new Date().toISOString();

    this.analytics.enqueue({
      eventId: generateId('evt'),
      traceId: this.traceId,
      runId: this.runId,
      timestamp: eventTimestamp,
      agentName: this.agentName,
      userId: this.userId,
      eventType: 'tool_call',
      stepIndex: this.stepIndex++,
      status: data.status,
      latencyMs: data.latencyMs,
      model: null,
      toolName: data.toolName,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      errorType: null,
      metadata: {
        ...cleanMetadata,
        tags: this.tags,
      },
    });
  }

  public captureError(data: ErrorData): void {
    const { _timestamp, ...cleanMetadata } = (data.metadata || {}) as any;
    const eventTimestamp = _timestamp || new Date().toISOString();

    this.analytics.enqueue({
      eventId: generateId('evt'),
      traceId: this.traceId,
      runId: this.runId,
      timestamp: eventTimestamp,
      agentName: this.agentName,
      userId: this.userId,
      eventType: 'error',
      stepIndex: this.stepIndex++,
      status: 'failed',
      latencyMs: null,
      model: null,
      toolName: data.toolName ?? null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      errorType: data.errorType,
      metadata: {
        message: data.message,
        ...cleanMetadata,
        tags: this.tags,
      },
    });
  }

  public captureRetry(data: RetryData): void {
    const { _timestamp, ...cleanMetadata } = (data.metadata || {}) as any;
    const eventTimestamp = _timestamp || new Date().toISOString();

    this.analytics.enqueue({
      eventId: generateId('evt'),
      traceId: this.traceId,
      runId: this.runId,
      timestamp: eventTimestamp,
      agentName: this.agentName,
      userId: this.userId,
      eventType: 'retry',
      stepIndex: this.stepIndex++,
      status: 'success',
      latencyMs: null,
      model: null,
      toolName: data.toolName,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      errorType: null,
      metadata: {
        attempt: data.attempt,
        ...cleanMetadata,
        tags: this.tags,
      },
    });
  }

  public end(data: TraceEndData): void {
    const { _timestamp, ...cleanMetadata } = (data.metadata || {}) as any;
    const eventTimestamp = _timestamp || new Date().toISOString();
    const latencyMs = data.metadata?._latencyMs || (Date.now() - this.startTime);

    this.analytics.enqueue({
      eventId: generateId('evt'),
      traceId: this.traceId,
      runId: this.runId,
      timestamp: eventTimestamp,
      agentName: this.agentName,
      userId: this.userId,
      eventType: 'trace_completed',
      stepIndex: this.stepIndex++,
      status: data.status,
      latencyMs: latencyMs,
      model: null,
      toolName: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      errorType: null,
      metadata: {
        output: data.output,
        ...cleanMetadata,
        tags: this.tags,
      },
    });
  }
}

export function initAgentAnalytics(config: SDKConfig): AgentAnalytics {
  return new AgentAnalytics(config);
}
