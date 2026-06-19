import { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { dbEngine } from './db';
import { dbRevision } from './capture';

// In-memory caches
interface CachedResult {
  revision: number;
  data: any[];
  latencyMs: number;
  sql: string;
}

const nlCache = new Map<string, string>(); // NL string -> SQL query
const resultCache = new Map<string, CachedResult>(); // SQL query -> CachedResult

// Security check for read-only SQL queries
export function validateSQL(sql: string): { valid: boolean; reason?: string } {
  const cleanSql = sql.trim().toUpperCase();

  // Must only run SELECT or WITH queries
  if (!cleanSql.startsWith('SELECT') && !cleanSql.startsWith('WITH')) {
    return { valid: false, reason: 'Query must start with SELECT or WITH' };
  }

  // Reject write/ddl/dml/system commands
  const forbiddenKeywords = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE',
    'COPY', 'INSTALL', 'LOAD', 'PRAGMA', 'TRANSACTION', 'COMMIT', 'ROLLBACK'
  ];

  for (const kw of forbiddenKeywords) {
    // Match word boundaries to avoid false positives (e.g. "model" contains "del" but is fine)
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    if (regex.test(sql)) {
      return { valid: false, reason: `Query contains forbidden keyword: ${kw}` };
    }
  }

  return { valid: true };
}

// Helper function to build traceId-level filters to avoid event-level null matching issues
export function buildTraceIdFilters(filters: any, tableAlias?: string): { clauses: string[]; params: any[] } {
  const clauses: string[] = [];
  const params: any[] = [];
  const prefix = tableAlias ? `${tableAlias}.` : '';

  if (filters.agentName) {
    clauses.push(`${prefix}traceId IN (SELECT DISTINCT traceId FROM events WHERE agentName = ?)`);
    params.push(filters.agentName);
  }
  if (filters.status) {
    if (filters.status === 'running') {
      clauses.push(`${prefix}traceId NOT IN (SELECT DISTINCT traceId FROM events WHERE eventType = 'trace_completed')`);
    } else {
      clauses.push(`${prefix}traceId IN (SELECT DISTINCT traceId FROM events WHERE eventType = 'trace_completed' AND status = ?)`);
      params.push(filters.status);
    }
  }
  if (filters.model) {
    clauses.push(`${prefix}traceId IN (SELECT DISTINCT traceId FROM events WHERE eventType = 'llm_call' AND model = ?)`);
    params.push(filters.model);
  }
  if (filters.toolName) {
    clauses.push(`${prefix}traceId IN (SELECT DISTINCT traceId FROM events WHERE eventType = 'tool_call' AND toolName = ?)`);
    params.push(filters.toolName);
  }
  if (filters.timeRange) {
    const now = new Date();
    let minTime: Date | null = null;
    if (filters.timeRange === 'last_hour') {
      minTime = new Date(now.getTime() - 60 * 60 * 1000);
    } else if (filters.timeRange === 'last_24h') {
      minTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    } else if (filters.timeRange === 'last_7d') {
      minTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    if (minTime) {
      clauses.push(`${prefix}traceId IN (SELECT DISTINCT traceId FROM events WHERE eventType = 'trace_started' AND timestamp >= ?)`);
      params.push(minTime.toISOString());
    }
  }

  return { clauses, params };
}

// Deterministic parser for the 8 standard queries
function parseDeterministic(nlQuery: string): string | null {
  const q = nlQuery.toLowerCase().trim().replace(/[?.!]/g, '');

  // Query 1: average LLM latency by model over time
  if (
    (q.includes('average') || q.includes('avg')) &&
    q.includes('latency') &&
    q.includes('model') &&
    (q.includes('time') || q.includes('hour') || q.includes('day'))
  ) {
    return `SELECT model, date_trunc('hour', timestamp) AS hour, AVG(latencyMs) AS avg_latency FROM events WHERE eventType = 'llm_call' AND model IS NOT NULL GROUP BY model, hour ORDER BY hour ASC;`;
  }

  // Query 2: Which tools fail the most
  if (q.includes('tool') && (q.includes('fail') || q.includes('failed') || q.includes('error')) && q.includes('most')) {
    return `SELECT toolName, COUNT(*) AS fail_count FROM events WHERE eventType = 'tool_call' AND status = 'failed' AND toolName IS NOT NULL GROUP BY toolName ORDER BY fail_count DESC LIMIT 10;`;
  }

  // Query 3: Token usage by agent type
  if (q.includes('token') && q.includes('usage') && (q.includes('agent') || q.includes('type'))) {
    return `SELECT agentName, SUM(inputTokens) AS total_input_tokens, SUM(outputTokens) AS total_output_tokens, SUM(inputTokens + outputTokens) AS total_tokens FROM events WHERE agentName IS NOT NULL GROUP BY agentName ORDER BY total_tokens DESC;`;
  }

  // Query 4: Cost per successful run by model
  if (q.includes('cost') && q.includes('successful') && q.includes('run') && q.includes('model')) {
    return `SELECT model, SUM(costUsd) AS total_cost, COUNT(DISTINCT traceId) AS successful_runs, SUM(costUsd) / COUNT(DISTINCT traceId) AS cost_per_run FROM events WHERE traceId IN (SELECT DISTINCT traceId FROM events WHERE eventType = 'trace_completed' AND status = 'success') AND eventType = 'llm_call' AND model IS NOT NULL GROUP BY model ORDER BY cost_per_run DESC;`;
  }

  // Query 5: Top 10 slowest traces
  if ((q.includes('slowest') || q.includes('slow')) && q.includes('trace')) {
    return `SELECT traceId, agentName, latencyMs, timestamp FROM events WHERE eventType = 'trace_completed' ORDER BY latencyMs DESC LIMIT 10;`;
  }

  // Query 6: Error rate by tool name
  if (q.includes('error rate') && q.includes('tool')) {
    return `SELECT toolName, COUNT(CASE WHEN status = 'failed' OR eventType = 'error' THEN 1 END) * 100.0 / COUNT(*) AS error_rate FROM events WHERE eventType = 'tool_call' AND toolName IS NOT NULL GROUP BY toolName ORDER BY error_rate DESC;`;
  }

  // Query 7: Number of runs per hour
  if (q.includes('runs') && q.includes('hour')) {
    return `SELECT date_trunc('hour', timestamp) AS hour, COUNT(*) AS run_count FROM events WHERE eventType = 'trace_started' GROUP BY hour ORDER BY hour ASC;`;
  }

  // Query 8: Average steps per run by outcome
  if ((q.includes('steps') || q.includes('step index')) && q.includes('run') && q.includes('outcome')) {
    return `SELECT status AS outcome, AVG(steps) AS avg_steps FROM (SELECT traceId, COUNT(*) AS steps, (SELECT status FROM events e2 WHERE e2.traceId = events.traceId AND e2.eventType = 'trace_completed' LIMIT 1) AS status FROM events GROUP BY traceId) WHERE status IS NOT NULL GROUP BY outcome;`;
  }

  return null;
}

// Translate NL query using Gemini LLM
async function translateWithGemini(nlQuery: string): Promise<string> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error('Gemini API key is not configured. Please set the GEMINI_API_KEY environment variable.');
  }

  const ai = new GoogleGenerativeAI(geminiApiKey);
  const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const systemPrompt = `You are a DuckDB SQL expert translating natural language requests into read-only SQL SELECT queries.
The table name is "events".
Here is the schema of the "events" table:
- eventId (VARCHAR, Primary Key)
- traceId (VARCHAR)
- runId (VARCHAR)
- timestamp (TIMESTAMP)
- agentName (VARCHAR)
- userId (VARCHAR)
- eventType (VARCHAR) - Can be 'trace_started', 'llm_call', 'tool_call', 'error', 'retry', 'trace_completed'
- stepIndex (INTEGER)
- status (VARCHAR) - Can be 'success', 'failed', 'running'
- latencyMs (INTEGER, nullable) - Latency of LLM call, tool call, or full trace
- model (VARCHAR, nullable) - LLM model name (e.g. 'gpt-5.2')
- toolName (VARCHAR, nullable) - Tool name (e.g. 'web_search')
- inputTokens (INTEGER, nullable) - Input tokens for LLM call
- outputTokens (INTEGER, nullable) - Output tokens for LLM call
- costUsd (DOUBLE, nullable) - Cost in USD of LLM call
- errorType (VARCHAR, nullable) - Error category (e.g. 'rate_limit')
- metadata (VARCHAR) - Stringified JSON containing custom fields (e.g. prompt text, inputs/outputs)

Instructions:
1. Output ONLY the raw SQL SELECT statement. Do not wrap it in markdown code blocks like \`\`\`sql.
2. The query must be standard DuckDB SQL.
3. Ensure the query is read-only and targets the "events" table.
4. If time binning is requested, use: date_trunc('hour', timestamp).
5. Always return clean, human-readable column headers using AS.

Convert this request: "${nlQuery}"`;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: systemPrompt }] }],
  });

  const responseText = result.response.text();
  const sql = responseText.trim().replace(/^```sql\n?/i, '').replace(/\n?```$/, '').trim();
  return sql;
}

// 1. Endpoint: /api/query/translate (Translate NL to SQL, return pending approval)
export async function translateQueryHandler(req: Request, res: Response): Promise<void> {
  const { query: nlQuery } = req.body;

  if (!nlQuery || typeof nlQuery !== 'string') {
    res.status(400).json({ error: 'Bad Request: "query" string is required.' });
    return;
  }

  // 1. Check NL cache first
  const cachedSql = nlCache.get(nlQuery.toLowerCase());
  if (cachedSql) {
    res.status(200).json({
      sql: cachedSql,
      cached: true,
      requiresApproval: true,
    });
    return;
  }

  // 2. Check deterministic parser next
  const deterministicSql = parseDeterministic(nlQuery);
  if (deterministicSql) {
    nlCache.set(nlQuery.toLowerCase(), deterministicSql);
    res.status(200).json({
      sql: deterministicSql,
      cached: false,
      requiresApproval: true,
    });
    return;
  }

  // 3. Fallback to Gemini LLM
  try {
    const generatedSql = await translateWithGemini(nlQuery);

    // Validate SQL safety before storing/returning
    const safetyCheck = validateSQL(generatedSql);
    if (!safetyCheck.valid) {
      res.status(422).json({
        error: 'Generated SQL failed safety validation.',
        sql: generatedSql,
        reason: safetyCheck.reason,
      });
      return;
    }

    nlCache.set(nlQuery.toLowerCase(), generatedSql);
    res.status(200).json({
      sql: generatedSql,
      cached: false,
      requiresApproval: true,
    });
  } catch (error: any) {
    console.error('[Query Translation] Error:', error);
    res.status(500).json({
      error: 'Query Translation Failed',
      details: error.message,
      isLlmMissing: error.message.includes('API key is not configured'),
    });
  }
}

// 2. Endpoint: /api/query/run (Run approved SQL query with optional dynamic filters)
export async function runQueryHandler(req: Request, res: Response): Promise<void> {
  const { sql, filters } = req.body;

  if (!sql || typeof sql !== 'string') {
    res.status(400).json({ error: 'Bad Request: "sql" string is required.' });
    return;
  }

  // Validate SQL safety
  const safetyCheck = validateSQL(sql);
  if (!safetyCheck.valid) {
    res.status(403).json({ error: `Forbidden: ${safetyCheck.reason}`, sql });
    return;
  }

  // Dynamically rewrite SQL with filters if provided
  let finalSql = sql;
  const paramValues: any[] = [];

  if (filters && typeof filters === 'object') {
    const { clauses, params } = buildTraceIdFilters(filters);

    if (clauses.length > 0) {
      const subquery = `(SELECT * FROM events WHERE ${clauses.join(' AND ')})`;
      const keywords = ['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'CROSS', 'ON', 'USING', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'HAVING', 'AND', 'OR', 'SELECT', 'WITH'];
      
      let matchCount = 0;
      finalSql = sql.replace(/\b(from|join)\s+events(?:\s+(?:as\s+)?([a-z0-9_]+))?\b/gi, (match, p1, p2) => {
        matchCount++;
        if (p2) {
          const upperAlias = p2.toUpperCase();
          if (!keywords.includes(upperAlias)) {
            return `${p1} ${subquery} AS ${p2}`;
          }
          return `${p1} ${subquery} AS events ${p2}`;
        }
        return `${p1} ${subquery} AS events`;
      });
      
      for (let i = 0; i < matchCount; i++) {
        paramValues.push(...params);
      }
    }
  }

  // Check result cache (we use the compiled SQL + stringified parameters as the cache key)
  const cacheKey = finalSql + JSON.stringify(paramValues);
  const cached = resultCache.get(cacheKey);
  if (cached && cached.revision === dbRevision) {
    res.status(200).json({
      data: cached.data,
      sql: finalSql,
      latencyMs: cached.latencyMs,
      cached: true,
    });
    return;
  }

  // Run query in DuckDB
  const startTime = Date.now();
  try {
    const data = await dbEngine.all(finalSql, ...paramValues);
    const latencyMs = Date.now() - startTime;

    // Cache the result
    resultCache.set(cacheKey, {
      revision: dbRevision,
      data,
      latencyMs,
      sql: finalSql,
    });

    res.status(200).json({
      data,
      sql: finalSql,
      latencyMs,
      cached: false,
    });
  } catch (error: any) {
    console.error('[Query Execution] Error running SQL:', error);
    res.status(400).json({
      error: 'SQL Execution Error',
      details: error.message,
      sql: finalSql,
    });
  }
}

// 3. Endpoint: /api/traces (List recent traces with summary aggregation)
export async function listTracesHandler(req: Request, res: Response): Promise<void> {
  const { agentName, status, model, toolName, timeRange } = req.query;

  const { clauses, params } = buildTraceIdFilters({ agentName, status, model, toolName, timeRange });

  // Get unique trace runs summarized
  // We aggregate everything in a single GROUP BY pass to avoid subqueries and handle incomplete traces
  const sql = `
    SELECT 
      traceId,
      ANY_VALUE(runId) as runId,
      COALESCE(MIN(CASE WHEN eventType = 'trace_started' THEN agentName END), ANY_VALUE(agentName)) as agentName,
      COALESCE(MIN(CASE WHEN eventType = 'trace_started' THEN userId END), ANY_VALUE(userId)) as userId,
      MIN(timestamp) as startedAt,
      MAX(CASE WHEN eventType = 'trace_completed' THEN timestamp END) as endedAt,
      COALESCE(MIN(CASE WHEN eventType = 'trace_completed' THEN status END), 'running') as status,
      COALESCE(MIN(CASE WHEN eventType = 'trace_completed' THEN latencyMs END), CAST((EPOCH(MAX(timestamp)) - EPOCH(MIN(timestamp))) * 1000 AS INTEGER)) as totalLatencyMs,
      SUM(costUsd) as totalCostUsd,
      COUNT(CASE WHEN eventType = 'llm_call' THEN 1 END) as llmCalls,
      COUNT(CASE WHEN eventType = 'tool_call' THEN 1 END) as toolCalls,
      COUNT(CASE WHEN eventType = 'error' THEN 1 END) as errorCount
    FROM events
    ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
    GROUP BY traceId
    ORDER BY startedAt DESC
    LIMIT 100;
  `;

  try {
    const data = await dbEngine.all(sql, ...params);
    res.status(200).json({ status: 'success', data });
  } catch (error: any) {
    console.error('[List Traces] Error:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}

// 4. Endpoint: /api/traces/:id (Retrieve complete chronologically ordered events for a trace)
export async function getTraceDetailsHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  try {
    const sql = `SELECT * FROM events WHERE traceId = ? ORDER BY stepIndex ASC;`;
    const data = await dbEngine.all(sql, id);

    if (data.length === 0) {
      res.status(404).json({ error: `Trace ${id} not found.` });
      return;
    }

    res.status(200).json({ status: 'success', data });
  } catch (error: any) {
    console.error('[Get Trace Details] Error:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}

// 5. Endpoint: /api/kpis (Retrieve current aggregated KPIs for KPIs cards)
export async function getKpisHandler(req: Request, res: Response): Promise<void> {
  const { agentName, status, model, toolName, timeRange } = req.query;

  const { clauses, params } = buildTraceIdFilters({ agentName, status, model, toolName, timeRange });

  const sql = `
    SELECT 
      COUNT(DISTINCT traceId) as totalTraces,
      AVG(CASE WHEN eventType = 'trace_completed' THEN latencyMs END) as avgTraceLatencyMs,
      COUNT(DISTINCT CASE WHEN eventType = 'trace_completed' AND status = 'failed' THEN traceId END) * 100.0 / NULLIF(COUNT(DISTINCT traceId), 0) as errorRate,
      SUM(costUsd) as totalCostUsd
    FROM events
    ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
    ;
  `;

  try {
    const data = await dbEngine.all(sql, ...params);
    res.status(200).json({ status: 'success', data: data[0] });
  } catch (error: any) {
    console.error('[Get KPIs] Error:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}

// 6. Endpoint: /api/meta (Retrieve distinct values of agentName, model, and toolName for sidebar filters)
export async function getMetadataHandler(req: Request, res: Response): Promise<void> {
  try {
    const agents = await dbEngine.all(`SELECT DISTINCT agentName FROM events WHERE agentName IS NOT NULL ORDER BY agentName ASC;`);
    const models = await dbEngine.all(`SELECT DISTINCT model FROM events WHERE model IS NOT NULL ORDER BY model ASC;`);
    const tools = await dbEngine.all(`SELECT DISTINCT toolName FROM events WHERE toolName IS NOT NULL ORDER BY toolName ASC;`);

    res.status(200).json({
      status: 'success',
      data: {
        agents: agents.map((row: any) => row.agentName),
        models: models.map((row: any) => row.model),
        tools: tools.map((row: any) => row.toolName)
      }
    });
  } catch (error: any) {
    console.error('[Get Metadata] Error:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}
