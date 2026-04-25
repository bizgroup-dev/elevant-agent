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
import { SnmpPoller } from './snmp';
import { DwSpectrumClient } from './dw-spectrum';
import { OnvifProbe } from './onvif-probe';
import { Pusher } from './pusher';
import { startConfigPoll } from './config-poll';
import type { StateSnapshot, HealthReport } from './types';

const AGENT_VERSION = '2.1.0';

async function main() {
  console.log(`[agent] Elevant Monitoring Agent v${AGENT_VERSION}`);
  console.log(`[agent] starting...`);

  const config = await loadConfig();
  const unifi = new UniFiClient(config);
  const snmpPoller = config.features.snmp ? new SnmpPoller(config) : null;
  const dwSpectrum = config.features.dwSpectrum && config.dwSpectrum ? new DwSpectrumClient(config) : null;
  const onvifProbe = config.features.onvifCameras ? new OnvifProbe(config) : null;
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
  const featureList = Object.entries(config.features).filter(([, v]) => v).map(([k]) => k).join(', ');
  console.log(`[agent] features: ${featureList}`);

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

      // Protect (cameras + sensors + lights)
      if (config.features.protect) {
        const cameras = await unifi.getProtectCameras();
        const sensors = await unifi.getProtectSensors();
        const lights = await unifi.getProtectLights();
        const nvr = await unifi.getProtectNvr();
        const onlineCams = cameras.filter(c => c.state === 'online').length;
        const onlineSensors = sensors.filter(s => s.state === 'online').length;
        const onlineLights = lights.filter(l => l.state === 'online').length;

        snapshot.protect = {
          cameras: [...cameras, ...sensors, ...lights],
          nvr: nvr || undefined,
        };

        const retentionDays = nvr?.retentionCapacitySeconds ? Math.round(nvr.retentionCapacitySeconds / 86400) : null;
        const parts = [`${onlineCams}/${cameras.length} cameras`];
        if (sensors.length > 0) parts.push(`${onlineSensors}/${sensors.length} sensors`);
        if (lights.length > 0) parts.push(`${onlineLights}/${lights.length} lights`);
        console.log(`[poll] protect: ${parts.join(', ')}${nvr ? `, storage ${nvr.storagePercent}%${retentionDays ? ` ~${retentionDays}d retention` : ''}` : ''}`);
      }

      // Access
      if (config.features.access) {
        const devices = await unifi.getAccessDevices();
        const onlineDoors = devices.filter(d => d.state === 'online').length;

        snapshot.access = { devices };

        console.log(`[poll] access: ${onlineDoors}/${devices.length} devices online`);
      }

      // Watched clients (Play devices, IoT, Connect devices)
      if (config.watchedClients && config.watchedClients.length > 0) {
        const watched = await unifi.getWatchedClients(config.watchedClients);
        const onlineWatched = watched.filter(w => w.state === 'online').length;

        // Add to network devices (they're network clients, just specifically tracked)
        if (!snapshot.network) {
          snapshot.network = { devices: [], health: { totalDevices: 0, onlineDevices: 0, totalClients: 0 } };
        }
        snapshot.network.devices.push(...watched);

        console.log(`[poll] watched: ${onlineWatched}/${watched.length} online`);
        if (onlineWatched < watched.length) {
          const offline = watched.filter(w => w.state === 'offline').map(w => w.name);
          console.log(`[poll] ⚠️  watched OFFLINE: ${offline.join(', ')}`);
        }
      }

      // SNMP devices (Fortinet, legacy switches, printers)
      if (snmpPoller) {
        const snmpDevices = await snmpPoller.poll();
        if (snmpDevices.length > 0) {
          snapshot.snmp = { devices: snmpDevices };
          console.log(`[poll] snmp: ${snmpDevices.filter(d => d.state === 'online').length}/${snmpDevices.length} devices online`);
        }
      }

      // DW Spectrum (cameras + NVR)
      if (dwSpectrum) {
        const dwDevices = await dwSpectrum.poll();
        if (dwDevices.length > 0) {
          snapshot.dwSpectrum = { devices: dwDevices };
          const onlineDw = dwDevices.filter(d => d.state === 'online').length;
          console.log(`[poll] dw-spectrum: ${onlineDw}/${dwDevices.length} devices online`);
        }
      }

      // ONVIF cameras (standalone IP cameras)
      if (onvifProbe) {
        const onvifDevices = await onvifProbe.poll();
        if (onvifDevices.length > 0) {
          snapshot.onvif = { devices: onvifDevices };
          const onlineOnvif = onvifDevices.filter(d => d.state === 'online').length;
          console.log(`[poll] onvif: ${onlineOnvif}/${onvifDevices.length} cameras online`);
        }
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

  // ── Live config pull from Elevant ──
  startConfigPoll(config, AGENT_VERSION);

  console.log(`[agent] running. Ctrl+C to stop.`);
}

main().catch(err => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});
