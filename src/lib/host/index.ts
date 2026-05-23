// Browser host abstraction. The app can only use remote ACP agents and
// browser-native persistence here.

import type {
  AgentsConfig,
  AgentConfig,
} from '../types';
import { getTransportKind } from '../types';

export type Unlisten = () => void;

/** Optional fields used when adding/updating a remote (websocket / http) agent. */
export interface RemoteAgentOptions {
  transport?: 'websocket' | 'http';
  url?: string;
  headers?: Record<string, string>;
}

const WEB_CONFIG_KEY = 'acp-ui:agents';
const WEB_CONFIG_PATH_LABEL = '(browser local storage)';

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

function buildAgentConfig(
  command: string | null,
  args: string[],
  env: Record<string, string>,
  remote: RemoteAgentOptions
): AgentConfig {
  const transport = remote.transport ?? 'websocket';

  const url = remote.url?.trim();
  if (!url) throw new Error('remote agent requires a url');
  const lower = url.toLowerCase();
  if (transport === 'websocket' && !(lower.startsWith('ws://') || lower.startsWith('wss://'))) {
    throw new Error(`URL scheme does not match transport 'websocket': ${url}`);
  }
  if (transport === 'http' && !(lower.startsWith('http://') || lower.startsWith('https://'))) {
    throw new Error(`URL scheme does not match transport 'http': ${url}`);
  }

  void command;
  void args;
  void env;
  return {
    transport,
    url,
    headers: remote.headers && Object.keys(remote.headers).length > 0 ? remote.headers : undefined,
  };
}

export async function getConfig(): Promise<AgentsConfig> {
  return loadWebConfig();
}

export async function reloadConfig(): Promise<AgentsConfig> {
  return loadWebConfig();
}

export async function getConfigPath(): Promise<string> {
  return WEB_CONFIG_PATH_LABEL;
}

export async function addAgent(
  name: string,
  command: string | null,
  args: string[],
  env: Record<string, string> = {},
  remote: RemoteAgentOptions = {}
): Promise<AgentsConfig> {
  const config = loadWebConfig();
  if (config.agents[name]) {
    throw new Error(`Agent '${name}' already exists`);
  }
  config.agents[name] = buildAgentConfig(command, args, env, remote);
  saveWebConfig(config);
  return config;
}

export async function updateAgent(
  name: string,
  command: string | null,
  args: string[],
  env: Record<string, string> = {},
  remote: RemoteAgentOptions = {}
): Promise<AgentsConfig> {
  const config = loadWebConfig();
  config.agents[name] = buildAgentConfig(command, args, env, remote);
  saveWebConfig(config);
  return config;
}

export async function removeAgent(name: string): Promise<AgentsConfig> {
  const config = loadWebConfig();
  delete config.agents[name];
  saveWebConfig(config);
  return config;
}

export async function onConfigChanged(
  _callback: (config: AgentsConfig) => void
): Promise<Unlisten> {
  return () => {};
}

const FALLBACK_VERSION = '0.0.0-web';

export async function getAppVersion(): Promise<string> {
  const v = (import.meta.env as Record<string, string | undefined>).VITE_APP_VERSION;
  return v ?? FALLBACK_VERSION;
}

/** True when the host can present a native folder picker. */
export function canPickFolder(): boolean {
  return false;
}

/** Browser builds cannot present a native folder picker. */
export async function pickFolder(_title?: string): Promise<string | null> {
  return null;
}

export async function readTextFile(_path: string): Promise<string> {
  throw new Error('readTextFile is not supported in the browser app');
}

export async function writeTextFile(_path: string, _content: string): Promise<void> {
  throw new Error('writeTextFile is not supported in the browser app');
}

export { loadKvStore } from './storage';
export type { KVStore } from './storage';
export { getTransportKind };
