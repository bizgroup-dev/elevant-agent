/**
 * Elevant Monitoring Agent — State Pusher
 *
 * Pushes device state snapshots to Elevant's monitoring ingest endpoint.
 * Buffers locally when Elevant is unreachable and retries.
 */

import type { AgentConfig, StateSnapshot, HealthReport } from './types';

export class Pusher {
  private url: string;
  private apiKey: string;
  private buffer: StateSnapshot[] = [];
  private maxBufferSize: number;

  constructor(config: AgentConfig) {
    this.url = config.elevant.url.replace(/\/$/, '');
    this.apiKey = config.elevant.apiKey;
    this.maxBufferSize = Math.floor((config.polling.bufferMaxMinutes * 60) / config.polling.intervalSeconds);
  }

  get bufferSize(): number {
    return this.buffer.length;
  }

  async pushState(snapshot: StateSnapshot): Promise<boolean> {
    // Try to send current snapshot + any buffered ones
    this.buffer.push(snapshot);

    try {
      const payload = this.buffer.length === 1
        ? { type: 'state', data: this.buffer[0] }
        : { type: 'state_batch', data: this.buffer };

      const res = await fetch(`${this.url}/api/monitoring/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Agent-Id': snapshot.agentId,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const flushed = this.buffer.length;
        this.buffer = [];
        if (flushed > 1) {
          console.log(`[pusher] flushed ${flushed} buffered snapshots`);
        }
        return true;
      }

      console.warn(`[pusher] Elevant returned ${res.status}: ${await res.text()}`);
      this.trimBuffer();
      return false;
    } catch (err) {
      console.warn(`[pusher] Elevant unreachable, buffering (${this.buffer.length}/${this.maxBufferSize})`);
      this.trimBuffer();
      return false;
    }
  }

  async pushHealth(report: HealthReport): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/api/monitoring/health`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'X-Agent-Id': report.agentId,
        },
        body: JSON.stringify(report),
      });

      return res.ok;
    } catch {
      // Health reports are best-effort — don't buffer
      return false;
    }
  }

  private trimBuffer(): void {
    if (this.buffer.length > this.maxBufferSize) {
      const dropped = this.buffer.length - this.maxBufferSize;
      this.buffer = this.buffer.slice(dropped);
      console.warn(`[pusher] buffer full, dropped ${dropped} oldest snapshots`);
    }
  }
}
