/**
 * Elevant Monitoring Agent — Type Definitions
 */

export interface AgentConfig {
  site: {
    id: string;
    name: string;
    cwCompanyId?: number;
  };
  unifi: {
    host: string;
    username: string;
    password: string;
    verifySsl: boolean;
  };
  elevant: {
    url: string;
    apiKey?: string;
    agentToken?: string;
    configPollIntervalSeconds?: number;
  };
  polling: {
    intervalSeconds: number;
    healthIntervalSeconds: number;
    retryIntervalSeconds: number;
    bufferMaxMinutes: number;
  };
  features: {
    network: boolean;
    protect: boolean;
    access: boolean;
    snmp: boolean;
    syslog: boolean;
    dwSpectrum: boolean;
    onvifCameras: boolean;
  };
  snmp?: {
    targets: Array<{
      host: string;
      community: string;
      version: '1' | '2c';
      name: string;
      type: 'firewall' | 'switch' | 'router';
    }>;
    pollIntervalSeconds: number;
  };
  syslog?: {
    port: number;
    protocol: 'udp';
    sources: Array<{
      ip: string;
      name: string;
      type: string;
    }>;
  };
  dwSpectrum?: {
    host: string;
    port: number;
    username: string;
    password: string;
    pollIntervalSeconds: number;
  };
  onvifCameras?: {
    cameras: Array<{
      host: string;
      name: string;
      httpPort: number;
      rtspPort: number;
    }>;
    pollIntervalSeconds: number;
  };
  watchedClients?: Array<{
    mac: string;
    name: string;
    type: string;  // 'play', 'connect', 'iot', etc.
  }>;
}

// ── UniFi API Response Types ──

export interface UniFiDevice {
  mac: string;
  name: string;
  model: string;
  model_in_lts?: string;
  type: string; // uap, usw, ugw, udm, etc.
  state: number; // 1 = connected, 0 = disconnected
  ip: string;
  version: string;
  upgradable: boolean;
  uptime: number;
  'num_sta'?: number; // client count
  'bytes-r'?: number; // throughput
  // Switch-specific
  port_table?: Array<{
    port_idx: number;
    name: string;
    up: boolean;
    speed: number;
    poe_enable?: boolean;
    poe_power?: string;
  }>;
  // AP-specific
  radio_table?: Array<{
    radio: string;
    channel: number;
    ht: string;
    tx_power: number;
    satisfaction?: number;
  }>;
}

export interface UniFiGatewayHealth {
  subsystem: string;
  status: string;
  wan_ip?: string;
  latency?: number;
  speedtest_lastrun?: number;
  uptime?: number;
  'tx_bytes-r'?: number;
  'rx_bytes-r'?: number;
}

export interface UniFiProtectCamera {
  id: string;
  name: string;
  type: string;
  model: string;
  state: string; // CONNECTED, DISCONNECTED
  isRecording: boolean;
  lastMotion: number | null;
  firmwareVersion: string;
  host: string;
  upSince: number | null;
}

export interface UniFiProtectNvr {
  id: string;
  name: string;
  version: string;
  uptime: number;
  storageInfo: {
    totalSize: number;
    usedSize: number;
    totalSpaceUsed: number;
  };
  recordingRetentionDurationMs: number;
}

export interface UniFiAccessDevice {
  id: string;
  name: string;
  type: string;
  connected: boolean;
  firmware: string;
  battery_level?: number;
  lock_status?: string;
}

// ── State Snapshot ──

export interface WanSnapshot {
  subsystem: 'wan' | 'wan2' | string;
  state: 'online' | 'degraded' | 'offline' | 'unknown';
  ispName?: string;
  ispOrg?: string;
  wanIp?: string;
  gatewayMac?: string;
  latencyMs?: number;
  uptimeSeconds?: number;
  xputUpKbps?: number;
  xputDownKbps?: number;
  numAdopted?: number;
  numDisconnected?: number;
}

export interface DeviceSnapshot {
  mac?: string;
  id?: string;
  name: string;
  model: string;
  type: string;
  state: 'online' | 'offline' | 'degraded' | 'unknown';
  ip?: string;
  firmware?: string;
  uptime?: number;
  clients?: number;
  extra?: Record<string, unknown>;
}

export interface StateSnapshot {
  agentId: string;
  agentVersion: string;
  timestamp: string;
  pollDurationMs: number;
  network: {
    devices: DeviceSnapshot[];
    health: {
      totalDevices: number;
      onlineDevices: number;
      totalClients: number;
    };
    gateway?: {
      state: string;
      wanIp?: string;
      wanLatency?: number;
    };
    wans?: WanSnapshot[];
  } | null;
  protect: {
    cameras: DeviceSnapshot[];
    nvr?: {
      storageUsedBytes: number;
      storageTotalBytes: number;
      storagePercent: number;
      recordingRetentionDays: number;
    };
  } | null;
  access: {
    devices: DeviceSnapshot[];
  } | null;
  snmp?: {
    devices: DeviceSnapshot[];
  } | null;
  dwSpectrum?: {
    devices: DeviceSnapshot[];
  } | null;
  onvif?: {
    devices: DeviceSnapshot[];
  } | null;
}

export interface HealthReport {
  agentId: string;
  agentVersion: string;
  timestamp: string;
  uptimeSeconds: number;
  lastPollAt: string | null;
  lastPollStatus: 'success' | 'error' | 'timeout';
  lastPollDurationMs: number;
  lastPushAt: string | null;
  lastPushStatus: 'success' | 'error';
  bufferSize: number;
  errors: string[];
}
