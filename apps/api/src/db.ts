import { Database, Connection } from 'duckdb';
import * as fs from 'fs';
import * as path from 'path';

export class DuckDBEngine {
  private db: Database;
  private con: Connection;

  constructor(dbPath: string) {
    // Ensure the folder exists if writing to a file
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(dbPath);
    this.con = this.db.connect();
  }

  public async all(sql: string, ...params: any[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
      // DuckDB node bindings: all(sql, ...params, callback)
      this.con.all(sql, ...params, (err: any, res: any) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }

  public async exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.con.exec(sql, (err: any) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  public async close(): Promise<void> {
    // Close connection and database
    return new Promise<void>((resolve) => {
      // The duckdb node API does not always have explicit close callbacks,
      // but closing connections is recommended.
      resolve();
    });
  }
}

// Global database instance
export let dbEngine: DuckDBEngine;

export async function initDatabase(dbPath: string = 'data/db.duckdb'): Promise<DuckDBEngine> {
  dbEngine = new DuckDBEngine(dbPath);

  // Initialize events table
  await dbEngine.exec(`
    CREATE TABLE IF NOT EXISTS events (
      eventId       VARCHAR PRIMARY KEY,
      traceId       VARCHAR,
      runId         VARCHAR,
      timestamp     TIMESTAMP,
      agentName     VARCHAR,
      userId        VARCHAR,
      eventType     VARCHAR,
      stepIndex     INTEGER,
      status        VARCHAR,
      latencyMs     INTEGER,
      model         VARCHAR,
      toolName      VARCHAR,
      inputTokens   INTEGER,
      outputTokens  INTEGER,
      costUsd       DOUBLE,
      errorType     VARCHAR,
      metadata      VARCHAR
    );
  `);

  console.log('[DuckDB] Database initialized successfully.');
  return dbEngine;
}
