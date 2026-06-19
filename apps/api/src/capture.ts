import { Request, Response } from 'express';
import { kafkaService } from './kafka';

// Global database revision tracker for result caching
export let dbRevision = 0;

export function incrementDbRevision(): void {
  dbRevision++;
}

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
    // Publish directly to Kafka buffer
    await kafkaService.publishEvents(events);
    res.status(200).json({ status: 'success', inserted: events.length });
  } catch (error: any) {
    console.error('[Capture] Ingestion buffer error:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}

export async function flushHandler(req: Request, res: Response): Promise<void> {
  // writes are buffered via Kafka and consumed in background.
  res.status(200).json({ status: 'success', message: 'Database writes queued.' });
}
