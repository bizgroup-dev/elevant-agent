/**
 * Elevant Monitoring Agent — DW Spectrum (Nx Witness) Client
 *
 * Polls Digital Watchdog DW Spectrum NVR via its REST API.
 * DW Spectrum is a rebranded Nx Witness VMS.
 *
 * API docs: https://support.networkoptix.com/hc/en-us/articles/360024447474
 */

import type { AgentConfig, DeviceSnapshot } from './types';

export class DwSpectrumClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private sessionToken: string | null = null;

  constructor(config: AgentConfig) {
    const dw = config.dwSpectrum!;
    this.baseUrl = `https://${dw.host}:${dw.port}`;
    this.username = dw.username;
    this.password = dw.password;
  }

  private async login(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rest/v2/login/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
      // @ts-ignore — Bun supports this
      tls: { rejectUnauthorized: false },
    });

    if (!res.ok) throw new Error(`DW login failed: ${res.status}`);
    const data = await res.json() as any;
    this.sessionToken = data.token || data.sessionToken;
  }

  private async request<T>(path: string): Promise<T> {
    if (!this.sessionToken) await this.login();

    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.sessionToken}`,
        Accept: 'application/json',
      },
      // @ts-ignore
      tls: { rejectUnauthorized: false },
    });

    if (res.status === 401) {
      this.sessionToken = null;
      await this.login();
      const retry = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${this.sessionToken}`,
          Accept: 'application/json',
        },
        // @ts-ignore
        tls: { rejectUnauthorized: false },
      });
      if (!retry.ok) throw new Error(`DW API ${retry.status}`);
      return retry.json() as Promise<T>;
    }

    if (!res.ok) throw new Error(`DW API ${res.status}`);
    return res.json() as Promise<T>;
  }

  async pollCameras(): Promise<DeviceSnapshot[]> {
    try {
      const devices = await this.request<any[]>('/rest/v2/devices');
      const snapshots: DeviceSnapshot[] = [];

      for (const d of (devices || [])) {
        const isOnline = d.status === 'Online' || d.status === 'Recording';

        snapshots.push({
          id: d.id || d.physicalId,
          mac: d.mac,
          name: d.name || 'Unknown Camera',
          model: d.model || d.vendor || 'DW Camera',
          type: 'camera',
          state: isOnline ? 'online' : 'offline',
          ip: d.url ? new URL(d.url).hostname : undefined,
          firmware: d.firmware,
          extra: {
            product: 'dw_spectrum',
            status: d.status,
            vendor: d.vendor,
            isRecording: d.status === 'Recording',
            serverId: d.parentId,
          },
        });
      }

      console.log(`[dw-spectrum] ${snapshots.filter(s => s.state === 'online').length}/${snapshots.length} cameras online`);
      return snapshots;
    } catch (err) {
      console.error('[dw-spectrum] camera poll failed:', err);
      return [];
    }
  }

  async pollServer(): Promise<DeviceSnapshot | null> {
    try {
      const servers = await this.request<any[]>('/rest/v2/servers');
      if (!servers?.length) return null;

      const server = servers[0]; // Primary server
      const isOnline = server.status === 'Online';

      // Get storage info
      let storageInfo: Record<string, unknown> = {};
      try {
        const storages = await this.request<any[]>(`/rest/v2/servers/${server.id}/storages`);
        if (storages?.length) {
          const total = storages.reduce((s: number, st: any) => s + (st.totalSpaceB || 0), 0);
          const free = storages.reduce((s: number, st: any) => s + (st.freeSpaceB || 0), 0);
          storageInfo = {
            storageTotalBytes: total,
            storageFreeBytes: free,
            storageUsedPercent: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
          };
        }
      } catch { /* storage endpoint may not be available */ }

      return {
        id: server.id,
        name: server.name || 'DW Spectrum NVR',
        model: `DW Spectrum ${server.version || ''}`.trim(),
        type: 'nvr',
        state: isOnline ? 'online' : 'offline',
        ip: server.url ? new URL(server.url).hostname : undefined,
        firmware: server.version,
        extra: {
          product: 'dw_spectrum',
          status: server.status,
          ...storageInfo,
        },
      };
    } catch (err) {
      console.error('[dw-spectrum] server poll failed:', err);
      return null;
    }
  }

  async poll(): Promise<DeviceSnapshot[]> {
    const results: DeviceSnapshot[] = [];

    const server = await this.pollServer();
    if (server) results.push(server);

    const cameras = await this.pollCameras();
    results.push(...cameras);

    return results;
  }
}
