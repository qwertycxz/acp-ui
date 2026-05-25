// Browser host abstraction. The app can only use a remote ACP agent and
// browser-native persistence here.

import type { AgentConfig } from '../types';

const WEB_CONFIG_KEY = 'acp-ui:agent';

export async function getConfig(): Promise<AgentConfig> {
  if (typeof localStorage === 'undefined') return { url: '' };
  const raw = localStorage.getItem(WEB_CONFIG_KEY);
  if (!raw) return { url: '' };

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') {
      return { url: parsed };
    }
    if (parsed && typeof parsed === 'object') {
      if (typeof (parsed as { url?: unknown }).url === 'string') {
        return { url: (parsed as { url: string }).url };
      }
    }
  } catch (e) {
    console.warn('Failed to parse stored agent config:', e);
  }
  return { url: '' };
}

export async function saveConfig(url: string): Promise<AgentConfig> {
  const config = { url: url.trim() };
  if (config.url && !/^(ws|wss):\/\//i.test(config.url)) {
    throw new Error(`WebSocket URL must start with ws:// or wss://: ${config.url}`);
  }

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(WEB_CONFIG_KEY, JSON.stringify(config));
    } catch (e) {
      console.warn('Failed to persist agent config:', e);
    }
  }

  return config;
}

export { loadKvStore } from './storage';
export type { KVStore } from './storage';
