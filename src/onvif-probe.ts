/**
 * Elevant Monitoring Agent — ONVIF/HTTP Camera Probe
 *
 * Basic health check for standalone IP cameras.
 * Tests HTTP reachability and optional RTSP port connectivity.
 * No ONVIF SOAP complexity — just simple probes.
 */

import { connect } from 'net';
import type { AgentConfig, DeviceSnapshot } from './types';

/**
 * Check if a TCP port is open (connection succeeds within timeout)
 */
function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
  });
}

/**
 * Check if HTTP responds (any status code = reachable)
 */
async function httpProbe(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://${host}:${port}/`, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'manual',
    });
    clearTimeout(timer);
    return true; // Any response = online
  } catch {
    return false;
  }
}

export class OnvifProbe {
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  async poll(): Promise<DeviceSnapshot[]> {
    if (!this.config.features.onvifCameras || !this.config.onvifCameras?.cameras?.length) {
      return [];
    }

    const snapshots: DeviceSnapshot[] = [];

    for (const cam of this.config.onvifCameras.cameras) {
      const httpOk = await httpProbe(cam.host, cam.httpPort);
      let rtspOk: boolean | undefined;

      if (cam.rtspPort) {
        rtspOk = await tcpProbe(cam.host, cam.rtspPort);
      }

      const isOnline = httpOk || (rtspOk === true);

      snapshots.push({
        id: `onvif-${cam.host}`,
        name: cam.name,
        model: 'IP Camera',
        type: 'camera',
        state: isOnline ? 'online' : 'offline',
        ip: cam.host,
        extra: {
          product: 'onvif',
          httpReachable: httpOk,
          rtspReachable: rtspOk,
          httpPort: cam.httpPort,
          rtspPort: cam.rtspPort,
        },
      });

      const status = isOnline
        ? `online (HTTP: ${httpOk ? 'ok' : 'fail'}${rtspOk !== undefined ? `, RTSP: ${rtspOk ? 'ok' : 'fail'}` : ''})`
        : 'OFFLINE';
      console.log(`[onvif] ${cam.name}: ${status}`);
    }

    return snapshots;
  }
}
