import { Request, Response } from 'express';
import { dbEngine } from './db';

// Global database revision tracker for result caching
export let dbRevision = 0;

export async function captureHandler(req: Request, res: Response): Promise<void> {
  const apiKey = req.headers['x-api-key'] || req.headers['api-key'];

  if (apiKey !== 'dev_project_key') {
    res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    return;
  }

  const { events } = req.body;

  if (!events || !Array.isArray(events)) {
    res.status(400).json({ error: 'Bad Request: "events" must be an array' });
    return;
  }

  if (events.length === 0) {
    res.status(200).json({ status: 'success', inserted: 0 });
    return;
  }

  // Validate fields on all events
  for (const e of events) {
    if (!e.eventId || !e.traceId || !e.runId || !e.timestamp || !e.agentName || !e.userId || !e.eventType || e.stepIndex === undefined) {
      res.status(400).json({
        error: 'Bad Request: Event missing required fields',
        invalidEvent: e,
      });
      return;
    }
  }

  try {
    const chunkSize = 200; // Batch into sets of 200 to keep parameter counts well below the 65,535 arguments stack limit
    
    for (let i = 0; i < events.length; i += chunkSize) {
      const chunk = events.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const sql = `INSERT INTO events (
        eventId, traceId, runId, timestamp, agentName, userId, eventType, stepIndex,
        status, latencyMs, model, toolName, inputTokens, outputTokens, costUsd, errorType, metadata
      ) VALUES ${placeholders}`;

      const values = chunk.flatMap((e: any) => [
        e.eventId,
        e.traceId,
        e.runId,
        e.timestamp,
        e.agentName,
        e.userId,
        e.eventType,
        e.stepIndex,
        e.status !== undefined ? e.status : null,
        e.latencyMs !== undefined && e.latencyMs !== null ? Number(e.latencyMs) : null,
        e.model !== undefined ? e.model : null,
        e.toolName !== undefined ? e.toolName : null,
        e.inputTokens !== undefined && e.inputTokens !== null ? Number(e.inputTokens) : null,
        e.outputTokens !== undefined && e.outputTokens !== null ? Number(e.outputTokens) : null,
        e.costUsd !== undefined && e.costUsd !== null ? Number(e.costUsd) : null,
        e.errorType !== undefined ? e.errorType : null,
        JSON.stringify(e.metadata || {}),
      ]);

      await dbEngine.all(sql, ...values);
    }

    // Increment revision to invalidate query cache
    dbRevision++;

    res.status(200).json({ status: 'success', inserted: events.length });
  } catch (error: any) {
    console.error('[Capture] Insertion error:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}

export async function flushHandler(req: Request, res: Response): Promise<void> {
  // Since we write directly to DuckDB on capture, we are immediately consistent.
  // We return success immediately.
  res.status(200).json({ status: 'success', message: 'Database writes completed.' });
}
