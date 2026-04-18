/**
 * Elevant Monitoring Agent — Main Entry
 *
 * Polls the UniFi Dream Machine local API on a schedule and pushes
 * device state snapshots to Elevant. Runs as a systemd service.
 *
 * Usage:
 *   bun run src/agent.ts         # Production
 *   bun --watch run src/agent.ts # Development (auto-reload)
 */

import { loadConfig } from './config';
import { UniFiClient } from './unifi';
import { Pusher } from './pusher';
import type { StateSnapshot, HealthReport } from './types';

const AGENT_VERSION = '1.0.0';

async function main() {
  console.log(`[agent] Elevant Monitoring Agent v${AGENT_VERSION}`);
  console.log(`[agent] starting...`);

  const config = await loadConfig();
  const unifi = new UniFiClient(config);
  const pusher = new Pusher(config);

  const startedAt = Date.now();
  let lastPollAt: string | null = null;
  let lastPollStatus: 'success' | 'error' | 'timeout' = 'success';
  let lastPollDurationMs = 0;
  let lastPushAt: string | null = null;
  let lastPushStatus: 'success' | 'error' = 'success';
  let recentErrors: string[] = [];

  console.log(`[agent] site: ${config.site.name} (${config.site.id})`);
  console.log(`[agent] UDM: ${config.unifi.host}`);
  console.log(`[agent] Elevant: ${config.elevant.url}`);
  console.log(`[agent] poll interval: ${config.polling.intervalSeconds}s`);
  console.log(`[agent] features: network=${config.features.network} protect=${config.features.protect} access=${config.features.access}`);

  // ── Poll cycle ──
  async function poll(): Promise<void> {
    const pollStart = Date.now();
    console.log(`[poll] starting cycle...`);

    try {
      const snapshot: StateSnapshot = {
        agentId: config.site.id,
        agentVersion: AGENT_VERSION,
        timestamp: new Date().toISOString(),
        pollDurationMs: 0,
        network: null,
        protect: null,
        access: null,
      };

      // Network
      if (config.features.network) {
        const devices = await unifi.getNetworkDevices();
        const health = await unifi.getNetworkHealth();
        const onlineCount = devices.filter(d => d.state === 'online').length;

        snapshot.network = {
          devices,
          health: {
            totalDevices: devices.length,
            onlineDevices: onlineCount,
            totalClients: health.totalClients,
          },
          gateway: health.gateway,
        };

        console.log(`[poll] network: ${onlineCount}/${devices.length} devices online, ${health.totalClients} clients`);
      }

      // Protect
      if (config.features.protect) {
        const cameras = await unifi.getProtectCameras();
        const nvr = await unifi.getProtectNvr();
        const onlineCams = cameras.filter(c => c.state === 'online').length;

        snapshot.protect = {
          cameras,
          nvr: nvr || undefined,
        };

        console.log(`[poll] protect: ${onlineCams}/${cameras.length} cameras online${nvr ? `, storage ${nvr.storagePercent}%` : ''}`);
      }

      // Access
      if (config.features.access) {
        const devices = await unifi.getAccessDevices();
        const onlineDoors = devices.filter(d => d.state === 'online').length;

        snapshot.access = { devices };

        console.log(`[poll] access: ${onlineDoors}/${devices.length} devices online`);
      }

      // Finalize timing
      snapshot.pollDurationMs = Date.now() - pollStart;
      lastPollDurationMs = snapshot.pollDurationMs;
      lastPollAt = new Date().toISOString();
      lastPollStatus = 'success';

      // Push to Elevant
      const pushOk = await pusher.pushState(snapshot);
      lastPushAt = new Date().toISOString();
      lastPushStatus = pushOk ? 'success' : 'error';

      if (pushOk) {
        console.log(`[poll] cycle complete in ${snapshot.pollDurationMs}ms, pushed to Elevant`);
      } else {
        console.log(`[poll] cycle complete in ${snapshot.pollDurationMs}ms, buffered (Elevant unreachable)`);
      }

      // Clear recent errors on success
      recentErrors = [];

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[poll] cycle failed: ${msg}`);
      lastPollAt = new Date().toISOString();
      lastPollStatus = 'error';
      recentErrors.push(`${new Date().toISOString()}: ${msg}`);
      // Keep only last 10 errors
      if (recentErrors.length > 10) recentErrors = recentErrors.slice(-10);
    }
  }

  // ── Health report ──
  async function reportHealth(): Promise<void> {
    const report: HealthReport = {
      agentId: config.site.id,
      agentVersion: AGENT_VERSION,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      lastPollAt,
      lastPollStatus,
      lastPollDurationMs,
      lastPushAt,
      lastPushStatus,
      bufferSize: pusher.bufferSize,
      errors: recentErrors,
    };

    const ok = await pusher.pushHealth(report);
    if (ok) {
      console.log(`[health] reported (uptime: ${report.uptimeSeconds}s, buffer: ${report.bufferSize})`);
    }
  }

  // ── Run initial poll immediately ──
  await poll();

  // ── Schedule recurring polls ──
  setInterval(poll, config.polling.intervalSeconds * 1000);

  // ── Schedule health reports ──
  setInterval(reportHealth, config.polling.healthIntervalSeconds * 1000);

  console.log(`[agent] running. Ctrl+C to stop.`);
}

main().catch(err => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});
