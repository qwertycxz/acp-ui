// Browser host abstraction. The app can only use remote ACP agents and
// browser-native persistence here.

import type { AgentsConfig } from '../types';

/** Optional fields used when adding/updating a WebSocket agent. */
export interface RemoteAgentOptions {
  url?: string;
  headers?: Record<string, string>;
}

const WEB_CONFIG_KEY = 'acp-ui:agents';

function loadWebConfig(): AgentsConfig {
  if (typeof localStorage === 'undefined') return { agents: {} };
  const raw = localStorage.getItem(WEB_CONFIG_KEY);
  if (!raw) return { agents: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.agents) {
      return parsed as AgentsConfig;
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
    throw new Error(`URL scheme does not match transport 'websocket': ${url}`);
  }
  config.agents[name] = {
    transport: 'websocket',
    url,
    headers: remote.headers && Object.keys(remote.headers).length > 0 ? remote.headers : undefined,
  };
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
    throw new Error(`URL scheme does not match transport 'websocket': ${url}`);
  }
  config.agents[name] = {
    transport: 'websocket',
    url,
    headers: remote.headers && Object.keys(remote.headers).length > 0 ? remote.headers : undefined,
  };
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
