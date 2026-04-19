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

      return (cameras || [])
        // Filter out stale unnamed cameras (decommissioned third-party devices)
        .filter((c: any) => {
          if (!c.name && c.state !== 'CONNECTED') {
            console.log(`[unifi] skipping stale unnamed camera: ${c.model || 'unknown'} @ ${c.host || 'no IP'}`);
            return false;
          }
          return true;
        })
        .map((c: any) => ({
          id: c.id,
          name: c.name || `${c.model || 'Camera'} (${c.host || 'unknown'})`,
          model: c.model || c.type || 'Unknown',
          type: 'camera',
          state: c.state === 'CONNECTED' ? 'online' as const : 'offline' as const,
          ip: c.host,
          firmware: c.firmwareVersion,
          uptime: c.upSince ? Math.floor((Date.now() - c.upSince) / 1000) : undefined,
          extra: {
            isRecording: c.isRecording || false,
            lastMotion: c.lastMotion ? new Date(c.lastMotion).toISOString() : null,
            isManaged: c.isManaged,
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

      // Storage data is in nvr.storageStats.recordingSpace (not storageInfo)
      const stats = nvr.storageStats || {};
      const space = stats.recordingSpace || {};
      const totalBytes = space.total || 0;
      const usedBytes = space.used || 0;
      const availableBytes = space.available || 0;
      const utilization = stats.utilization || 0;

      return {
        storageUsedBytes: usedBytes,
        storageTotalBytes: totalBytes,
        storageAvailableBytes: availableBytes,
        storagePercent: Math.round(utilization),
        recordingRateBytesPerSec: stats.recordingRate || 0,
        retentionCapacitySeconds: stats.capacity || 0,
        remainingCapacitySeconds: stats.remainingCapacity || 0,
        distribution: stats.recordingDistribution || null,
      };
    } catch (err) {
      console.error('[unifi] protect NVR poll failed:', err);
      return null;
    }
  }

  // ── Watched Clients (Play devices, IoT, etc.) ──

  async getWatchedClients(watchList: Array<{ mac: string; name: string; type: string }>): Promise<DeviceSnapshot[]> {
    if (!watchList || watchList.length === 0) return [];

    try {
      const data = await this.request<{ data: any[] }>('/proxy/network/api/s/default/stat/sta');
      const clients = data.data || [];

      // Build MAC lookup set from current clients
      const onlineMacs = new Set(clients.map((c: any) => c.mac?.toLowerCase()));

      return watchList.map((w) => {
        const isOnline = onlineMacs.has(w.mac.toLowerCase());
        // Find the client entry for extra data
        const client = clients.find((c: any) => c.mac?.toLowerCase() === w.mac.toLowerCase());

        return {
          mac: w.mac,
          name: w.name,
          model: w.type,
          type: w.type,
          state: isOnline ? 'online' as const : 'offline' as const,
          ip: client?.ip,
          extra: {
            hostname: client?.hostname,
            lastSeen: client?.last_seen ? new Date(client.last_seen * 1000).toISOString() : null,
            uplink: client?.uplink_mac,
          },
        };
      });
    } catch (err) {
      console.error('[unifi] watched clients poll failed:', err);
      return [];
    }
  }

  // ── Protect Sensors ──

  async getProtectSensors(): Promise<DeviceSnapshot[]> {
    try {
      const sensors = await this.request<any[]>('/proxy/protect/api/sensors');

      return (sensors || []).map((s: any) => ({
        mac: s.mac,
        name: s.name || `Sensor (${s.type || 'unknown'})`,
        model: s.type || 'Sensor',
        type: 'sensor',
        state: s.isConnected || s.connectedSince ? 'online' as const : 'offline' as const,
        firmware: s.firmwareVersion,
        uptime: s.uptime,
        extra: {
          batteryStatus: s.batteryStatus,
          mountType: s.mountType,
          openStatusChangedAt: s.openStatusChangedAt,
          isOpened: s.isOpened,
          leakDetectedAt: s.leakDetectedAt,
          tamperingDetectedAt: s.tamperingDetectedAt,
          alarmTriggeredAt: s.alarmTriggeredAt,
        },
      }));
    } catch (err) {
      console.error('[unifi] protect sensors poll failed:', err);
      return [];
    }
  }

  // ── Protect Lights ──

  async getProtectLights(): Promise<DeviceSnapshot[]> {
    try {
      const lights = await this.request<any[]>('/proxy/protect/api/lights');

      return (lights || []).map((l: any) => ({
        mac: l.mac,
        name: l.name || `Light (${l.type || 'unknown'})`,
        model: l.type || 'Light',
        type: 'light',
        state: l.isConnected || l.connectedSince ? 'online' as const : 'offline' as const,
        ip: l.host,
        firmware: l.firmwareVersion,
        uptime: l.uptime,
        extra: {
          isPirMotionDetected: l.isPirMotionDetected,
          lightOnSettings: l.lightOnSettings,
          lightDeviceSettings: l.lightDeviceSettings,
        },
      }));
    } catch (err) {
      console.error('[unifi] protect lights poll failed:', err);
      return [];
    }
  }

  // ── Access ──

  async getAccessDevices(): Promise<DeviceSnapshot[]> {
    try {
      // Access API v2 returns { code: 1, codeS: "SUCCESS", data: [...] }
      const raw = await this.request<any>('/proxy/access/api/v2/devices');

      // Extract device array from response envelope
      let devices: any[] = [];
      if (Array.isArray(raw)) {
        devices = raw;
      } else if (raw?.data && Array.isArray(raw.data)) {
        devices = raw.data;
      }

      return devices.map((d: any) => ({
        id: d.unique_id || d.id,
        name: d.alias || d.name || 'Unknown Door',
        model: d.device_type || d.type || 'Unknown',
        type: 'door_controller',
        state: (d.is_online || d.is_connected) ? 'online' as const : 'offline' as const,
        ip: d.ip,
        firmware: d.firmware || d.version,
        extra: {
          mac: d.mac,
          isAdopted: d.is_adopted,
          location: d.location?.name,
          startTime: d.start_time ? new Date(d.start_time * 1000).toISOString() : null,
          lastSeen: d.last_seen ? new Date(d.last_seen * 1000).toISOString() : null,
        },
      }));
    } catch (err) {
      console.error('[unifi] access devices poll failed:', err);
      return [];
    }
  }
}
