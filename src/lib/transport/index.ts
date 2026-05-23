// Transport factory for remote browser transports.
import type { AgentConfig } from '../types';
import { getTransportKind } from '../types';
import type { AcpTransport } from './types';
import { WebSocketTransport } from './websocket';

/**
 * Create and connect a transport for the named agent.
 *
 * Opens a WebSocket / HTTP connection from the browser directly.
 *
 * @throws if the requested transport is not supported or if the agent config
 *   is missing required fields.
 */
export async function createTransport(
  agentName: string,
  config: AgentConfig
): Promise<AcpTransport> {
  const kind = getTransportKind(config);

  switch (kind) {
    case 'websocket': {
      if (!config.url) {
        throw new Error(`Agent '${agentName}' is missing 'url' for websocket transport`);
      }
      return WebSocketTransport.connect({
        url: config.url,
        headers: config.headers,
      });
    }
    case 'http': {
      throw new Error(
        `HTTP transport is not yet implemented (agent '${agentName}')`
      );
    }
    default: {
      // Exhaustiveness check.
      const _never: never = kind;
      throw new Error(`Unknown transport kind: ${String(_never)}`);
    }
  }
}

export type { AcpTransport, Unsubscribe } from './types';
export { WebSocketTransport } from './websocket';
