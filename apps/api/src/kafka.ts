import { Kafka, Producer, Consumer } from 'kafkajs';
import { dbEngine } from './db';
import { incrementDbRevision } from './capture';

const KAFKA_BROKER = process.env.KAFKA_BROKER || 'localhost:9092';
const TOPIC = 'agent-events';

export interface KafkaService {
  connect(): Promise<void>;
  publishEvents(events: any[]): Promise<void>;
  startConsumer(): Promise<void>;
  disconnect(): Promise<void>;
}

class RealKafkaService implements KafkaService {
  private kafka: Kafka;
  private producer: Producer;
  private consumer: Consumer;

  constructor() {
    this.kafka = new Kafka({
      clientId: 'agent-trace-api',
      brokers: [KAFKA_BROKER],
      retry: {
        initialRetryTime: 100,
        retries: 3
      }
    });
    this.producer = this.kafka.producer();
    this.consumer = this.kafka.consumer({ groupId: 'clickhouse-sink-group' });
  }

  public async connect(): Promise<void> {
    await this.producer.connect();
    console.log('[Kafka] Producer connected.');
  }

  public async publishEvents(events: any[]): Promise<void> {
    const messages = events.map(e => ({
      key: e.traceId,
      value: JSON.stringify(e)
    }));

    await this.producer.send({
      topic: TOPIC,
      messages
    });
  }

  public async startConsumer(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: TOPIC, fromBeginning: true });
    
    await this.consumer.run({
      eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
        const events: any[] = [];
        for (const message of batch.messages) {
          if (message.value) {
            try {
              events.push(JSON.parse(message.value.toString()));
            } catch (err) {
              console.error('[Kafka Consumer] Failed to parse message value:', err);
            }
          }
        }

        if (events.length > 0) {
          try {
            await dbEngine.insertEvents(events);
            incrementDbRevision();
          } catch (err) {
            console.error('[Kafka Consumer] Failed to write batch to ClickHouse:', err);
            throw err; // Trigger standard Kafka retry
          }
        }

        for (const message of batch.messages) {
          resolveOffset(message.offset);
        }
        await commitOffsetsIfNecessary();
        await heartbeat();
      }
    });
    console.log('[Kafka] Batch consumer worker started.');
  }

  public async disconnect(): Promise<void> {
    try {
      await this.producer.disconnect();
      await this.consumer.disconnect();
      console.log('[Kafka] Disconnected.');
    } catch (err) {
      console.error('[Kafka] Error disconnecting:', err);
    }
  }
}

class MockKafkaService implements KafkaService {
  public async connect(): Promise<void> {
    console.log('[Kafka Mock] Mock producer connected.');
  }

  public async publishEvents(events: any[]): Promise<void> {
    // In mock mode, we immediately insert to mock dbEngine to simulate the pipeline
    setImmediate(async () => {
      try {
        await dbEngine.insertEvents(events);
        incrementDbRevision();
      } catch (err) {
        console.error('[Kafka Mock] Insert error:', err);
      }
    });
  }

  public async startConsumer(): Promise<void> {
    console.log('[Kafka Mock] Mock batch consumer worker started.');
  }

  public async disconnect(): Promise<void> {
    console.log('[Kafka Mock] Mock disconnected.');
  }
}

export const kafkaService: KafkaService = 
  (process.env.NODE_ENV === 'test' || process.argv.some(arg => arg.includes('run-tests')))
    ? new MockKafkaService() 
    : new RealKafkaService();
