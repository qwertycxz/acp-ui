// Browser host abstraction. The app can only use remote ACP agents and
// browser-native persistence here.

import type { AgentsConfig } from '../types';

/** Optional fields used when adding/updating a WebSocket agent. */
export interface RemoteAgentOptions {
  url?: string;
}

const WEB_CONFIG_KEY = 'acp-ui:agents';

function loadWebConfig(): AgentsConfig {
  if (typeof localStorage === 'undefined') return { agents: {} };
  const raw = localStorage.getItem(WEB_CONFIG_KEY);
  if (!raw) return { agents: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.agents) {
      const agents: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed.agents)) {
        if (typeof value === 'string') {
          agents[name] = value;
        } else if (value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string') {
          agents[name] = (value as { url: string }).url;
        }
      }
      return { agents };
    }
  } catch (e) {
    console.warn('Failed to parse stored agents config:', e);
  }
  return { agents: {} };
}

function saveWebConfig(config: AgentsConfig): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(WEB_CONFIG_KEY, JSON.stringify(config));
  } catch (e) {
    console.warn('Failed to persist agents config:', e);
  }
}

export async function getConfig(): Promise<AgentsConfig> {
  return loadWebConfig();
}

export async function addAgent(
  name: string,
  remote: RemoteAgentOptions = {}
): Promise<AgentsConfig> {
  const config = loadWebConfig();
  if (config.agents[name]) {
    throw new Error(`Agent '${name}' already exists`);
  }
  const url = remote.url?.trim();
  if (!url) throw new Error('remote agent requires a url');
  if (!/^(ws|wss):\/\//i.test(url)) {
    throw new Error(`WebSocket URL must start with ws:// or wss://: ${url}`);
  }
  config.agents[name] = url;
  saveWebConfig(config);
  return config;
}

export async function updateAgent(
  name: string,
  remote: RemoteAgentOptions = {}
): Promise<AgentsConfig> {
  const config = loadWebConfig();
  const url = remote.url?.trim();
  if (!url) throw new Error('remote agent requires a url');
  if (!/^(ws|wss):\/\//i.test(url)) {
    throw new Error(`WebSocket URL must start with ws:// or wss://: ${url}`);
  }
  config.agents[name] = url;
  saveWebConfig(config);
  return config;
}

export async function removeAgent(name: string): Promise<AgentsConfig> {
  const config = loadWebConfig();
  delete config.agents[name];
  saveWebConfig(config);
  return config;
}

export { loadKvStore } from './storage';
export type { KVStore } from './storage';
