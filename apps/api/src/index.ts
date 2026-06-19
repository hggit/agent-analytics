import express from 'express';
import cors from 'cors';
import { initDatabase, dbEngine } from './db';
import { kafkaService } from './kafka';
import { captureHandler, flushHandler } from './capture';
import {
  translateQueryHandler,
  runQueryHandler,
  listTracesHandler,
  getTraceDetailsHandler,
  getKpisHandler,
  getMetadataHandler
} from './query';

// Add BigInt JSON serialization patch for ClickHouse/DuckDB aggregation results
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
    service: 'Agent Trace Analytics Engine - API (ClickHouse & Kafka Enabled)',
    database: 'ClickHouse',
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

// Initialize DB, Kafka, and start Express server
let server: any;
async function startServer() {
  const dbPath = process.env.NODE_ENV === 'test' ? ':memory:' : '';
  try {
    // 1. Initialize ClickHouse (or Mock in test)
    await initDatabase(dbPath);

    // 2. Initialize Kafka Broker connection & Start Sink Consumer
    await kafkaService.connect();
    await kafkaService.startConsumer();

    server = app.listen(port, () => {
      console.log(`[API Server] Running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Failed to initialize database, broker or start API server:', error);
    process.exit(1);
  }
}

// Graceful shutdown handler
async function handleShutdown() {
  console.log('\n[API Server] SIGINT/SIGTERM received. Starting graceful shutdown...');
  if (server) {
    server.close(() => {
      console.log('[API Server] HTTP server closed.');
    });
  }
  try {
    await kafkaService.disconnect();
    if (dbEngine) {
      await dbEngine.close();
      console.log('[ClickHouse] Client connection closed.');
    }
  } catch (err) {
    console.error('[API Server] Error during shutdown:', err);
  }
  process.exit(0);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

startServer();
