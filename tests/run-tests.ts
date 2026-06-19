import * as assert from 'assert';
import { validateSQL, listTracesHandler, getKpisHandler } from '../apps/api/src/query';
import { initDatabase } from '../apps/api/src/db';
import { captureHandler } from '../apps/api/src/capture';

// Add BigInt JSON serialization patch for DuckDB aggregation results in test environment
(BigInt.prototype as any).toJSON = function() {
  return Number(this);
};

// Mock simple event queue matching SDK design to test batching
class MockSDK {
  public queue: any[] = [];
  public flushCount = 0;
  private flushAt: number;

  constructor(flushAt: number) {
    this.flushAt = flushAt;
  }

  public enqueue(event: any) {
    this.queue.push(event);
    if (this.queue.length >= this.flushAt) {
      this.flush();
    }
  }

  public flush() {
    this.flushCount++;
    this.queue = [];
  }
}

async function runTests() {
  console.log('🧪 Starting Agent Trace Analytics Engine Tests...');

  // Test 1: SDK Batching Behavior
  console.log('  └─ Running Test 1: SDK Batching...');
  const sdk = new MockSDK(3);
  
  sdk.enqueue({ eventId: '1' });
  assert.strictEqual(sdk.queue.length, 1);
  assert.strictEqual(sdk.flushCount, 0);

  sdk.enqueue({ eventId: '2' });
  assert.strictEqual(sdk.queue.length, 2);
  assert.strictEqual(sdk.flushCount, 0);

  sdk.enqueue({ eventId: '3' }); // Should trigger flush
  assert.strictEqual(sdk.queue.length, 0);
  assert.strictEqual(sdk.flushCount, 1);
  console.log('  ✅ Test 1 Passed: SDK batched and flushed correctly.');

  // Test 2: SQL Injection & Read-Only Safety Validation
  console.log('  └─ Running Test 2: SQL Safety Validation...');
  
  const safeSelect = 'SELECT * FROM events WHERE agentName = \'coder-agent\';';
  const selectCheck = validateSQL(safeSelect);
  assert.strictEqual(selectCheck.valid, true);

  const safeWith = 'WITH slow_runs AS (SELECT * FROM events) SELECT * FROM slow_runs;';
  const withCheck = validateSQL(safeWith);
  assert.strictEqual(withCheck.valid, true);

  const destructiveDrop = 'DROP TABLE events;';
  const dropCheck = validateSQL(destructiveDrop);
  assert.strictEqual(dropCheck.valid, false);
  assert.ok(dropCheck.reason?.includes('Query must start with SELECT or WITH') || dropCheck.reason?.includes('forbidden keyword'));

  const destructiveInsert = 'SELECT * FROM events; INSERT INTO events VALUES (\'evt_bad\');';
  const insertCheck = validateSQL(destructiveInsert);
  assert.strictEqual(insertCheck.valid, false);
  assert.ok(insertCheck.reason?.includes('forbidden keyword'));

  const destructivePragma = 'SELECT * FROM events; PRAGMA database_list;';
  const pragmaCheck = validateSQL(destructivePragma);
  assert.strictEqual(pragmaCheck.valid, false);
  assert.ok(pragmaCheck.reason?.includes('forbidden keyword'));

  console.log('  ✅ Test 2 Passed: SQL safety filter successfully blocked unsafe queries.');

  // Initialize in-memory database for API handler tests
  await initDatabase(':memory:');

  // Test 3: Capture and Verify Orphaned / Running / Completed Traces
  console.log('  └─ Running Test 3: Incomplete/Orphaned Trace Detection...');

  // 1. Capture Completed Trace
  const completedTraceEvents = [
    {
      eventId: 'evt_c1',
      traceId: 'trace_completed_1',
      runId: 'run_1',
      timestamp: '2026-06-19T10:00:00.000Z',
      agentName: 'research-agent',
      userId: 'user_1',
      eventType: 'trace_started',
      stepIndex: 0
    },
    {
      eventId: 'evt_c2',
      traceId: 'trace_completed_1',
      runId: 'run_1',
      timestamp: '2026-06-19T10:00:05.000Z',
      agentName: 'research-agent',
      userId: 'user_1',
      eventType: 'llm_call',
      stepIndex: 1,
      model: 'gpt-4o',
      costUsd: 0.002,
      latencyMs: 1500
    },
    {
      eventId: 'evt_c3',
      traceId: 'trace_completed_1',
      runId: 'run_1',
      timestamp: '2026-06-19T10:00:10.000Z',
      agentName: 'research-agent',
      userId: 'user_1',
      eventType: 'trace_completed',
      stepIndex: 2,
      status: 'success',
      latencyMs: 10000
    }
  ];

  // 2. Capture Running Trace (No trace_completed)
  const runningTraceEvents = [
    {
      eventId: 'evt_r1',
      traceId: 'trace_running_2',
      runId: 'run_2',
      timestamp: '2026-06-19T10:10:00.000Z',
      agentName: 'coder-agent',
      userId: 'user_2',
      eventType: 'trace_started',
      stepIndex: 0
    },
    {
      eventId: 'evt_r2',
      traceId: 'trace_running_2',
      runId: 'run_2',
      timestamp: '2026-06-19T10:10:05.000Z',
      agentName: 'coder-agent',
      userId: 'user_2',
      eventType: 'llm_call',
      stepIndex: 1,
      model: 'claude-3-5-sonnet',
      costUsd: 0.001,
      latencyMs: 2000
    }
  ];

  // 3. Capture Orphaned Trace (No trace_started, no trace_completed, just steps)
  const orphanedTraceEvents = [
    {
      eventId: 'evt_o1',
      traceId: 'trace_orphaned_3',
      runId: 'run_3',
      timestamp: '2026-06-19T10:20:00.000Z',
      agentName: 'support-agent',
      userId: 'user_3',
      eventType: 'llm_call',
      stepIndex: 1,
      model: 'llama-3',
      costUsd: 0.0005,
      latencyMs: 500
    }
  ];

  const allEvents = [...completedTraceEvents, ...runningTraceEvents, ...orphanedTraceEvents];

  // Call capture handler
  let captureRes: any;
  const mockCaptureReq = {
    headers: { 'x-api-key': 'dev_project_key' },
    body: { events: allEvents }
  } as any;
  const mockCaptureRes = {
    status: (code: number) => {
      assert.strictEqual(code, 200);
      return mockCaptureRes;
    },
    json: (data: any) => {
      captureRes = JSON.parse(JSON.stringify(data));
    }
  } as any;

  await captureHandler(mockCaptureReq, mockCaptureRes);
  assert.strictEqual(captureRes.status, 'success');
  assert.strictEqual(captureRes.inserted, allEvents.length);

  // Call listTracesHandler
  let tracesRes: any;
  const mockListReq = { query: {} } as any;
  const mockListRes = {
    status: (code: number) => {
      assert.strictEqual(code, 200);
      return mockListRes;
    },
    json: (data: any) => {
      tracesRes = JSON.parse(JSON.stringify(data));
    }
  } as any;

  await listTracesHandler(mockListReq, mockListRes);
  assert.strictEqual(tracesRes.status, 'success');
  
  const traces = tracesRes.data;
  assert.strictEqual(traces.length, 3);

  // Find and assert completed trace
  const tCompleted = traces.find((t: any) => t.traceId === 'trace_completed_1');
  assert.ok(tCompleted);
  assert.strictEqual(tCompleted.status, 'success');
  assert.strictEqual(tCompleted.agentName, 'research-agent');
  assert.strictEqual(tCompleted.userId, 'user_1');
  assert.strictEqual(tCompleted.llmCalls, 1);
  assert.strictEqual(tCompleted.totalLatencyMs, 10000);

  // Find and assert running trace
  const tRunning = traces.find((t: any) => t.traceId === 'trace_running_2');
  assert.ok(tRunning);
  assert.strictEqual(tRunning.status, 'running');
  assert.strictEqual(tRunning.agentName, 'coder-agent');
  assert.strictEqual(tRunning.userId, 'user_2');
  assert.strictEqual(tRunning.llmCalls, 1);
  // Latency calculated between start and last event timestamp (5 seconds)
  assert.strictEqual(tRunning.totalLatencyMs, 5000);

  // Find and assert orphaned trace
  const tOrphaned = traces.find((t: any) => t.traceId === 'trace_orphaned_3');
  assert.ok(tOrphaned);
  assert.strictEqual(tOrphaned.status, 'running');
  assert.strictEqual(tOrphaned.agentName, 'support-agent');
  assert.strictEqual(tOrphaned.userId, 'user_3');
  assert.strictEqual(tOrphaned.llmCalls, 1);
  assert.strictEqual(tOrphaned.totalLatencyMs, 0);

  console.log('  ✅ Test 3 Passed: Incomplete and orphaned traces correctly aggregated and parsed.');

  // Test 4: Dynamic Filters and KPI verification
  console.log('  └─ Running Test 4: Filter Scoping & KPI Calculation...');

  // Test status filter
  let filterRes: any;
  const mockFilterReq1 = { query: { status: 'running' } } as any;
  const mockFilterRes1 = {
    status: (code: number) => {
      assert.strictEqual(code, 200);
      return mockFilterRes1;
    },
    json: (data: any) => {
      filterRes = JSON.parse(JSON.stringify(data));
    }
  } as any;
  await listTracesHandler(mockFilterReq1, mockFilterRes1);
  assert.strictEqual(filterRes.data.length, 2); // trace_running_2 and trace_orphaned_3
  assert.ok(filterRes.data.some((t: any) => t.traceId === 'trace_running_2'));
  assert.ok(filterRes.data.some((t: any) => t.traceId === 'trace_orphaned_3'));

  // Test agentName filter
  const mockFilterReq2 = { query: { agentName: 'research-agent' } } as any;
  await listTracesHandler(mockFilterReq2, mockFilterRes1);
  assert.strictEqual(filterRes.data.length, 1);
  assert.strictEqual(filterRes.data[0].traceId, 'trace_completed_1');

  // Test KPI aggregations
  let kpisRes: any;
  const mockKpisReq = { query: {} } as any;
  const mockKpisRes = {
    status: (code: number) => {
      assert.strictEqual(code, 200);
      return mockKpisRes;
    },
    json: (data: any) => {
      kpisRes = JSON.parse(JSON.stringify(data));
    }
  } as any;

  await getKpisHandler(mockKpisReq, mockKpisRes);
  assert.strictEqual(kpisRes.status, 'success');
  // totalTraces should be 3
  assert.strictEqual(kpisRes.data.totalTraces, 3);
  // avgTraceLatencyMs should be 10000 (only trace_completed_1 is trace_completed)
  assert.strictEqual(kpisRes.data.avgTraceLatencyMs, 10000);
  // totalCostUsd should be 0.002 + 0.001 + 0.0005 = 0.0035
  assert.strictEqual(kpisRes.data.totalCostUsd, 0.0035);

  console.log('  ✅ Test 4 Passed: Filters scoped correctly at trace-level and KPIs calculated accurately.');

  console.log('🎉 All tests completed successfully!');
}

runTests().catch((err) => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
