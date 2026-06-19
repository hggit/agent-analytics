import { initAgentAnalytics, AgentAnalytics, Trace } from '@mini-posthog/sdk';

// Configuration
const API_URL = process.env.API_URL || 'http://localhost:3000';
const API_KEY = 'dev_project_key';

// Mock values
const AGENTS = [
  { name: 'research-agent', models: ['claude-3-5-sonnet', 'gemini-2.5-flash'], tools: ['web_search', 'fetch_url'] },
  { name: 'coder-agent', models: ['gpt-4o', 'deepseek-coder'], tools: ['read_file', 'write_file'] },
  { name: 'support-agent', models: ['llama-3'], tools: ['calculator', 'web_search'] }
];

const USERS = ['user_101', 'user_102', 'user_103', 'user_204', 'user_305', 'user_500', 'user_999'];

const PROMPTS = [
  'Find the cost of hosting a node server',
  'Write a python script to parse logs',
  'Help me calculate my tax refund',
  'Check the status of package delivery',
  'Search for latest AI news',
  'Refactor index.ts to use classes',
  'Summarize this paper on machine learning',
  'How do I implement binary search in Rust',
  'Fix the alignment of this navigation header',
  'Explain the difference between SQLite and DuckDB'
];

const ERRORS = [
  { type: 'rate_limit', message: 'API rate limit exceeded. Please try again later.' },
  { type: 'timeout', message: 'Connection timed out while fetching response.' },
  { type: 'file_not_found', message: 'Unable to open target file: file does not exist.' },
  { type: 'parse_error', message: 'JSON syntax error: unexpected character in response.' }
];

function getRandomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Generate a trace programmatically with custom backdated timestamp
async function generateSimulatedTrace(
  sdk: AgentAnalytics,
  timestampMs: number,
  traceIndex: number
): Promise<void> {
  const agent = getRandomItem(AGENTS);
  const userId = getRandomItem(USERS);
  const prompt = getRandomItem(PROMPTS);
  const startTime = timestampMs;
  let offset = 0;

  const trace = sdk.startTrace({
    agentName: agent.name,
    userId,
    input: prompt,
    tags: ['simulator', agent.name],
    // Pass custom timestamp to trace_started event via internal private _timestamp
    ...({ _timestamp: new Date(startTime).toISOString() } as any)
  });

  const numSteps = getRandomInt(3, 8);
  let status: 'success' | 'failed' = 'success';
  let finalOutput = 'Execution finished successfully.';
  let lastModel = getRandomItem(agent.models);

  for (let step = 1; step < numSteps; step++) {
    offset += getRandomInt(1000, 3000);
    const stepTime = startTime + offset;
    const stepTimestamp = new Date(stepTime).toISOString();

    const stepType = getRandomItem(['llm', 'tool', 'tool', 'error_or_retry']);

    if (stepType === 'llm') {
      const model = getRandomItem(agent.models);
      lastModel = model;
      let latency = getRandomInt(300, 1500);
      let cost = 0.0001;
      let inputTokens = getRandomInt(100, 3000);
      let outputTokens = getRandomInt(50, 800);

      if (model === 'gpt-4o') {
        cost = (inputTokens * 5 + outputTokens * 15) / 1000000;
      } else if (model === 'claude-3-5-sonnet') {
        cost = (inputTokens * 3 + outputTokens * 15) / 1000000;
      } else if (model === 'gemini-2.5-flash') {
        cost = (inputTokens * 0.075 + outputTokens * 0.3) / 1000000;
        latency = getRandomInt(200, 700);
      } else if (model === 'deepseek-coder') {
        cost = (inputTokens * 0.14 + outputTokens * 0.28) / 1000000;
      }

      trace.captureLLMCall({
        model,
        latencyMs: latency,
        inputTokens,
        outputTokens,
        costUsd: cost,
        metadata: {
          route: step % 2 === 0 ? 'planning' : 'execution',
          _timestamp: stepTimestamp
        }
      });
    } else if (stepType === 'tool') {
      const tool = getRandomItem(agent.tools);
      const toolLatency = getRandomInt(50, 1000);
      const isSuccess = Math.random() > 0.1; // 10% tool fail rate

      trace.captureToolCall({
        toolName: tool,
        latencyMs: toolLatency,
        status: isSuccess ? 'success' : 'failed',
        metadata: {
          query: 'search query payload',
          _timestamp: stepTimestamp
        }
      });

      if (!isSuccess) {
        // Capture error immediately
        const error = getRandomItem(ERRORS);
        offset += getRandomInt(500, 1000);
        trace.captureError({
          errorType: error.type,
          message: error.message,
          toolName: tool,
          metadata: { _timestamp: new Date(startTime + offset).toISOString() }
        });
        status = 'failed';
        finalOutput = `Error occurred at tool ${tool}: ${error.message}`;
        break; // Stop trace execution
      }
    } else if (stepType === 'error_or_retry') {
      const tool = getRandomItem(agent.tools);
      const isRetrySuccess = Math.random() > 0.5;

      // Fail tool first
      const error = getRandomItem(ERRORS);
      trace.captureToolCall({
        toolName: tool,
        latencyMs: getRandomInt(50, 300),
        status: 'failed',
        metadata: { _timestamp: stepTimestamp }
      });

      offset += getRandomInt(200, 500);
      trace.captureError({
        errorType: error.type,
        message: error.message,
        toolName: tool,
        metadata: { _timestamp: new Date(startTime + offset).toISOString() }
      });

      if (isRetrySuccess) {
        // Capture retry
        offset += getRandomInt(1000, 2000);
        trace.captureRetry({
          toolName: tool,
          attempt: 2,
          metadata: { _timestamp: new Date(startTime + offset).toISOString() }
        });

        // Run tool successfully
        offset += getRandomInt(200, 500);
        trace.captureToolCall({
          toolName: tool,
          latencyMs: getRandomInt(50, 300),
          status: 'success',
          metadata: { _timestamp: new Date(startTime + offset).toISOString() }
        });
      } else {
        status = 'failed';
        finalOutput = `Execution halted: retry failed for tool ${tool}.`;
        break;
      }
    }
  }

  // End trace
  offset += getRandomInt(1000, 2000);
  const endTime = startTime + offset;
  const traceLatency = endTime - startTime;

  trace.end({
    status,
    output: finalOutput,
    metadata: {
      _timestamp: new Date(endTime).toISOString(),
      _latencyMs: traceLatency // Override calculated latency with backdated latency
    }
  });
}

// Main execution function
async function main() {
  const args = process.argv.slice(2);
  const isDemo = args.includes('--demo');
  const isBenchmark = args.includes('--benchmark');

  if (!isDemo && !isBenchmark) {
    console.error('Error: Please specify either --demo or --benchmark');
    console.log('Usage: npm run simulate -- [--demo | --benchmark]');
    process.exit(1);
  }

  // Initialize SDK
  // Set flushAt extremely high for benchmark mode to disable auto-flushing
  // and rely entirely on explicit batch-level awaits.
  const sdk = initAgentAnalytics({
    apiKey: API_KEY,
    host: API_URL,
    flushAt: isBenchmark ? 9999999 : 20,
    flushIntervalMs: 60000 // Disable interval flushing during active runs
  });

  const startTime = Date.now();

  if (isDemo) {
    console.log('[Simulator] Starting demo mode. Generating 10 traces (~80 events)...');
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

    for (let i = 0; i < 10; i++) {
      const traceTimestamp = twoHoursAgo + (i / 10) * (2 * 60 * 60 * 1000);
      await generateSimulatedTrace(sdk, traceTimestamp, i);
    }

    await sdk.flush();
    console.log(`[Simulator] Demo generation finished in ${Date.now() - startTime}ms.`);
  } else if (isBenchmark) {
    console.log('[Simulator] Starting benchmark mode. Generating ~1,000,000 events (~120,000 traces)...');
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const totalTraces = 120000;
    const batchSize = 1000; // 1,000 traces at a time (approx 8,000 events)

    let generatedTraces = 0;

    for (let b = 0; b < totalTraces / batchSize; b++) {
      const batchStartTime = Date.now();

      // Generate traces sequentially in the current batch to avoid task overlap
      for (let i = 0; i < batchSize; i++) {
        const traceIndex = b * batchSize + i;
        const traceTimestamp = sevenDaysAgo + (traceIndex / totalTraces) * (7 * 24 * 60 * 60 * 1000);
        await generateSimulatedTrace(sdk, traceTimestamp, traceIndex);
      }

      // Explicitly await the flush and make sure it finishes before starting the next batch
      await sdk.flush();

      generatedTraces += batchSize;
      const progress = ((generatedTraces / totalTraces) * 100).toFixed(1);
      const batchDuration = Date.now() - batchStartTime;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Simulator] Progress: ${progress}% (${generatedTraces}/${totalTraces} traces). Batch took ${batchDuration}ms. Elapsed: ${elapsed}s`);
    }

    console.log(`[Simulator] Benchmark generation completed successfully.`);
    console.log(`[Simulator] Total time: ${((Date.now() - startTime) / 1000).toFixed(1)} seconds.`);
  }
}

main().catch((err) => {
  console.error('[Simulator] Runner error:', err);
  process.exit(1);
});
