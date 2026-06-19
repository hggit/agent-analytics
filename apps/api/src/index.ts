import express from 'express';
import cors from 'cors';
import { initDatabase } from './db';
import { captureHandler, flushHandler } from './capture';
import {
  translateQueryHandler,
  runQueryHandler,
  listTracesHandler,
  getTraceDetailsHandler,
  getKpisHandler,
  getMetadataHandler
} from './query';

// Add BigInt JSON serialization patch for DuckDB aggregation results
(BigInt.prototype as any).toJSON = function() {
  return Number(this);
};

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Welcome / Health check route
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Agent Trace Analytics Engine - API',
    database: 'DuckDB (durable)',
    endpoints: {
      kpis: '/api/kpis',
      traces: '/api/traces',
      capture: '/capture',
      meta: '/api/meta'
    }
  });
});

// Ingestion endpoints
app.post('/capture', captureHandler);
app.post('/flush', flushHandler);

// Query endpoints
app.post('/api/query/translate', translateQueryHandler);
app.post('/api/query/run', runQueryHandler);
app.get('/api/traces', listTracesHandler);
app.get('/api/traces/:id', getTraceDetailsHandler);
app.get('/api/kpis', getKpisHandler);
app.get('/api/meta', getMetadataHandler);

// Initialize DB and start Express server
async function startServer() {
  const dbPath = process.env.NODE_ENV === 'test' ? ':memory:' : 'data/db.duckdb';
  try {
    await initDatabase(dbPath);
    app.listen(port, () => {
      console.log(`[API Server] Running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Failed to initialize database or start API server:', error);
    process.exit(1);
  }
}

startServer();
