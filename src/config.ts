/**
 * Elevant Monitoring Agent — Configuration
 *
 * Loads config from /etc/elevant-agent/config.json (production)
 * or ./config/config.json (development).
 *
 * Sensitive values (passwords, API keys) can be overridden via
 * environment variables.
 */

import type { AgentConfig } from './types';

const CONFIG_PATHS = [
  '/etc/elevant-agent/config.json',
  './config/config.json',
];

export async function loadConfig(): Promise<AgentConfig> {
  let raw: string | null = null;

  for (const path of CONFIG_PATHS) {
    try {
      raw = await Bun.file(path).text();
      console.log(`[config] loaded from ${path}`);
      break;
    } catch {
      // Try next path
    }
  }

  if (!raw) {
    console.error('[config] No config file found. Checked:', CONFIG_PATHS.join(', '));
    process.exit(1);
  }

  const config = JSON.parse(raw) as AgentConfig;

  // Environment variable overrides for sensitive values
  if (process.env.UNIFI_HOST) config.unifi.host = process.env.UNIFI_HOST;
  if (process.env.UNIFI_USERNAME) config.unifi.username = process.env.UNIFI_USERNAME;
  if (process.env.UNIFI_PASSWORD) config.unifi.password = process.env.UNIFI_PASSWORD;
  if (process.env.ELEVANT_URL) config.elevant.url = process.env.ELEVANT_URL;
  if (process.env.ELEVANT_API_KEY) config.elevant.apiKey = process.env.ELEVANT_API_KEY;
  if (process.env.SITE_ID) config.site.id = process.env.SITE_ID;

  // Validate required fields — only check UniFi creds if UniFi features are enabled
  const needsUnifi = config.features.network || config.features.protect || config.features.access;
  if (needsUnifi && (!config.unifi.host || !config.unifi.username || !config.unifi.password)) {
    console.error('[config] Missing required UniFi credentials (network/protect/access is enabled)');
    process.exit(1);
  }
  if (!config.elevant.url) {
    console.error('[config] Missing Elevant URL');
    process.exit(1);
  }
  if (!config.site.id) {
    console.error('[config] Missing site ID');
    process.exit(1);
  }

  return config;
}
