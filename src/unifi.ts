/**
 * Elevant Monitoring Agent — UniFi API Client
 *
 * Handles authentication and data collection from the UniFi Dream Machine
 * local API. Supports Network, Protect, and Access applications.
 *
 * Authentication: POST /api/auth/login → session cookie → use for all requests.
 * Session expires after ~30 min; we re-auth on any 401.
 */

import type { AgentConfig, DeviceSnapshot } from './types';

export class UniFiClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private sessionCookie: string | null = null;

  constructor(config: AgentConfig) {
    this.baseUrl = `https://${config.unifi.host}`;
    this.username = config.unifi.username;
    this.password = config.unifi.password;
  }

  // ── Authentication ──

  private async login(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
      // @ts-ignore — Bun supports this for self-signed certs
      tls: { rejectUnauthorized: false },
    });

    if (!res.ok) {
      throw new Error(`UniFi login failed: ${res.status} ${res.statusText}`);
    }

    // Extract session cookie from Set-Cookie header
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      // TOKEN=xxx; Path=/; ...
      const match = setCookie.match(/TOKEN=([^;]+)/);
      if (match) {
        this.sessionCookie = `TOKEN=${match[1]}`;
      }
    }

    if (!this.sessionCookie) {
      throw new Error('UniFi login succeeded but no session cookie returned');
    }

    console.log('[unifi] authenticated successfully');
  }

  private async request<T>(path: string): Promise<T> {
    if (!this.sessionCookie) {
      await this.login();
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Cookie: this.sessionCookie!,
      },
      // @ts-ignore — Bun supports this for self-signed certs
      tls: { rejectUnauthorized: false },
    });

    // Re-auth on 401 and retry once
    if (res.status === 401) {
      console.log('[unifi] session expired, re-authenticating');
      this.sessionCookie = null;
      await this.login();
      const retry = await fetch(`${this.baseUrl}${path}`, {
        headers: { Cookie: this.sessionCookie! },
        // @ts-ignore
        tls: { rejectUnauthorized: false },
      });
      if (!retry.ok) {
        throw new Error(`UniFi API error after re-auth: ${retry.status} on ${path}`);
      }
      return retry.json() as Promise<T>;
    }

    if (!res.ok) {
      throw new Error(`UniFi API error: ${res.status} on ${path}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Network ──

  async getNetworkDevices(): Promise<DeviceSnapshot[]> {
    try {
      const data = await this.request<{ data: any[] }>('/proxy/network/api/s/default/stat/device');
      const devices = data.data || [];

      return devices.map((d: any) => ({
        mac: d.mac,
        name: d.name || d.model || 'Unknown',
        model: d.model || 'Unknown',
        type: d.type || 'unknown',
        state: d.state === 1 ? 'online' as const : 'offline' as const,
        ip: d.ip,
        firmware: d.version,
        uptime: d.uptime,
        clients: d['num_sta'] || 0,
        extra: {
          upgradable: d.upgradable || false,
          satisfaction: d.satisfaction,
          bytes_r: d['bytes-r'],
          // AP radio info
          ...(d.radio_table ? {
            radios: d.radio_table.map((r: any) => ({
              radio: r.radio,
              channel: r.channel,
              txPower: r.tx_power,
            })),
          } : {}),
          // Switch port summary
          ...(d.port_table ? {
            ports: d.port_table.length,
            portsUp: d.port_table.filter((p: any) => p.up).length,
          } : {}),
        },
      }));
    } catch (err) {
      console.error('[unifi] network device poll failed:', err);
      return [];
    }
  }

  async getNetworkHealth(): Promise<{ totalClients: number; gateway?: any }> {
    try {
      const data = await this.request<{ data: any[] }>('/proxy/network/api/s/default/stat/health');
      const subsystems = data.data || [];

      let totalClients = 0;
      let gateway: any = null;

      for (const s of subsystems) {
        if (s.subsystem === 'wlan' || s.subsystem === 'lan') {
          totalClients += s.num_user || 0;
        }
        if (s.subsystem === 'wan') {
          gateway = {
            state: s.status === 'ok' ? 'online' : 'degraded',
            wanIp: s.wan_ip,
            wanLatency: s.latency,
          };
        }
      }

      return { totalClients, gateway };
    } catch (err) {
      console.error('[unifi] health poll failed:', err);
      return { totalClients: 0 };
    }
  }

  // ── Protect ──

  async getProtectCameras(): Promise<DeviceSnapshot[]> {
    try {
      const cameras = await this.request<any[]>('/proxy/protect/api/cameras');

      return (cameras || []).map((c: any) => ({
        id: c.id,
        name: c.name || 'Unknown Camera',
        model: c.model || c.type || 'Unknown',
        type: 'camera',
        state: c.state === 'CONNECTED' ? 'online' as const : 'offline' as const,
        ip: c.host,
        firmware: c.firmwareVersion,
        uptime: c.upSince ? Math.floor((Date.now() - c.upSince) / 1000) : undefined,
        extra: {
          isRecording: c.isRecording || false,
          lastMotion: c.lastMotion ? new Date(c.lastMotion).toISOString() : null,
        },
      }));
    } catch (err) {
      console.error('[unifi] protect cameras poll failed:', err);
      return [];
    }
  }

  async getProtectNvr(): Promise<any | null> {
    try {
      const nvr = await this.request<any>('/proxy/protect/api/nvr');
      if (!nvr) return null;

      const storage = nvr.storageInfo || {};
      const totalBytes = storage.totalSize || 0;
      const usedBytes = storage.usedSize || storage.totalSpaceUsed || 0;

      return {
        storageUsedBytes: usedBytes,
        storageTotalBytes: totalBytes,
        storagePercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
        recordingRetentionDays: nvr.recordingRetentionDurationMs
          ? Math.round(nvr.recordingRetentionDurationMs / 86400000)
          : 0,
      };
    } catch (err) {
      console.error('[unifi] protect NVR poll failed:', err);
      return null;
    }
  }

  // ── Access ──

  async getAccessDevices(): Promise<DeviceSnapshot[]> {
    try {
      // Try v2 API first, fall back to v1
      let devices: any[];
      try {
        devices = await this.request<any[]>('/proxy/access/api/v2/devices');
      } catch {
        devices = await this.request<any[]>('/proxy/access/api/devices');
      }

      return (devices || []).map((d: any) => ({
        id: d.id || d.unique_id,
        name: d.name || d.alias || 'Unknown Door',
        model: d.type || d.device_type || 'Unknown',
        type: 'door_controller',
        state: d.connected || d.is_online ? 'online' as const : 'offline' as const,
        firmware: d.firmware || d.firmware_version,
        extra: {
          batteryPercent: d.battery_level ?? d.battery_status?.percentage,
          lockState: d.lock_status || d.lock_state,
        },
      }));
    } catch (err) {
      console.error('[unifi] access devices poll failed:', err);
      return [];
    }
  }
}
