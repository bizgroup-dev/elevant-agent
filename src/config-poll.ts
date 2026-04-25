/**
 * Config Poll
 *
 * Periodically fetches the agent's config from Elevant. If the remote config
 * differs from the on-disk config, writes the new file and exits the process
 * — systemd restarts the agent cleanly with the new config.
 */

import type { AgentConfig } from './types';

const CONFIG_PATH = '/opt/elevant-agent/config/config.json';
const FALLBACK_PATH = './config/config.json';

async function fetchRemote(config: AgentConfig, agentVersion: string): Promise<AgentConfig | null> {
  const token = config.elevant.agentToken;
  if (!token) return null; // Not provisioned for live config pull

  const url = `${config.elevant.url}/api/monitoring/agents/${config.site.id}/config`;
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Agent-Version': agentVersion,
        'X-Machine-Id': process.env.HOSTNAME || 'unknown',
      },
    });
    if (!res.ok) {
      console.warn(`[config-poll] HTTP ${res.status} from ${url}`);
      return null;
    }
    const body = await res.json() as { config: AgentConfig };
    return body.config;
  } catch (err) {
    console.warn(`[config-poll] fetch failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function configsDiffer(a: AgentConfig, b: AgentConfig): boolean {
  // Strip volatile fields and compare. Use stable JSON serialization.
  return JSON.stringify(stripVolatile(a)) !== JSON.stringify(stripVolatile(b));
}

function stripVolatile(c: AgentConfig): unknown {
  const { ...rest } = c;
  return rest;
}

async function writeConfig(next: AgentConfig): Promise<boolean> {
  for (const path of [CONFIG_PATH, FALLBACK_PATH]) {
    try {
      await Bun.write(path, JSON.stringify(next, null, 2));
      console.log(`[config-poll] wrote new config to ${path}`);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

export function startConfigPoll(current: AgentConfig, agentVersion: string): void {
  const intervalSec = current.elevant.configPollIntervalSeconds ?? 300;
  if (!current.elevant.agentToken) {
    console.log(`[config-poll] no agentToken — live config pull disabled`);
    return;
  }
  console.log(`[config-poll] enabled, interval ${intervalSec}s`);

  const tick = async () => {
    const remote = await fetchRemote(current, agentVersion);
    if (!remote) return;
    if (!configsDiffer(current, remote)) return;

    console.log(`[config-poll] remote config differs — applying and restarting`);
    const ok = await writeConfig(remote);
    if (!ok) {
      console.error(`[config-poll] failed to write new config; not restarting`);
      return;
    }
    // systemd Restart=always brings us back with the new config
    process.exit(0);
  };

  setInterval(() => { tick().catch(err => console.error('[config-poll] tick error:', err)); }, intervalSec * 1000);
}
