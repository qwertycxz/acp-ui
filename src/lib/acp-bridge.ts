// ACP Client Bridge - adapts the browser WebSocket API to the ACP SDK's
// Client interface.
import type {
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  AuthenticateRequest,
  AuthenticateResponse,
} from '@agentclientprotocol/sdk';
import type { AgentConfig, PermissionRequest as LocalPermissionRequest } from './types';
import { ref, type Ref } from 'vue';
import { useTrafficStore } from '../stores/traffic';

type PermissionResolver = (response: RequestPermissionResponse) => void;

let trafficStore: ReturnType<typeof useTrafficStore> | null = null;
function getTrafficStore() {
  if (!trafficStore) {
    trafficStore = useTrafficStore();
  }
  return trafficStore;
}

const JSONRPC_METHOD_NOT_FOUND = -32601;
const CONNECT_TIMEOUT_MS = 15_000;

export class AcpClientBridge implements Client {
  private socket: WebSocket;
  private messageResolvers: Map<number, (response: unknown) => void> = new Map();
  private messageRejecters: Map<number, (error: Error) => void> = new Map();
  private pendingMethods: Map<number, string> = new Map();
  private nextRequestId = 0;
  private disconnected = false;

  public pendingPermissionRequest: Ref<LocalPermissionRequest | null> = ref(null);
  private permissionResolver: PermissionResolver | null = null;

  public onSessionUpdate: ((notification: SessionNotification) => void) | null = null;
  public onTransportClose: ((reason?: string) => void) | null = null;

  constructor(socket: WebSocket) {
    this.socket = socket;

    socket.addEventListener('message', (event) => {
      this.handleSocketMessage(event);
    });
    socket.addEventListener('close', (event) => {
      this.handleSocketClose(
        `websocket closed (code=${event.code}, reason=${event.reason || 'unknown'})`
      );
    });
    socket.addEventListener('error', () => {
      this.handleSocketClose('websocket error');
    });
  }

  async connect(): Promise<void> {
    // No-op: the factory hands us an already-open WebSocket.
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    this.disconnected = true;
    this.rejectInFlight(new Error('websocket closed: client disconnected'));
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(1000, 'client closed');
    }
  }

  private handleSocketMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') {
      console.error('Received non-string WebSocket frame; dropping', event.data);
      return;
    }

    for (const frame of event.data.includes('\n') ? event.data.split('\n') : [event.data]) {
      const message = frame.trim();
      if (message) {
        this.handleMessage(message);
      }
    }
  }

  private handleSocketClose(reason: string): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.rejectInFlight(new Error(reason));
    if (this.onTransportClose) {
      this.onTransportClose(reason);
    }
  }

  private rejectInFlight(error: Error): void {
    for (const reject of this.messageRejecters.values()) {
      try {
        reject(error);
      } catch {
        /* ignore */
      }
    }
    this.messageResolvers.clear();
    this.messageRejecters.clear();
    this.pendingMethods.clear();
  }

  private handleMessage(message: string): void {
    try {
      const parsed = JSON.parse(message);
      const store = getTrafficStore();

      if ('id' in parsed && parsed.id !== undefined && !('method' in parsed)) {
        store.addEntry({
          direction: 'in',
          type: 'response',
          method: this.pendingMethods.get(parsed.id) || 'unknown',
          requestId: parsed.id,
          payload: parsed,
          error: !!parsed.error,
        });
        this.pendingMethods.delete(parsed.id);

        const resolver = this.messageResolvers.get(parsed.id);
        const rejecter = this.messageRejecters.get(parsed.id);
        if (resolver && rejecter) {
          this.messageResolvers.delete(parsed.id);
          this.messageRejecters.delete(parsed.id);
          if (parsed.error) {
            console.error('JSON-RPC error:', parsed.error);
            rejecter(new Error(parsed.error.message || 'Unknown error'));
          } else {
            resolver(parsed.result);
          }
        }
      }

      if ('id' in parsed && parsed.id !== undefined && 'method' in parsed) {
        store.addEntry({
          direction: 'in',
          type: 'request',
          method: parsed.method,
          requestId: parsed.id,
          payload: parsed,
        });
        void this.handleRequest(parsed.id, parsed.method, parsed.params);
      }

      if (!('id' in parsed) && parsed.method) {
        store.addEntry({
          direction: 'in',
          type: 'notification',
          method: parsed.method,
          payload: parsed,
        });
        this.handleNotification(parsed.method, parsed.params);
      }
    } catch (e) {
      console.error('Failed to parse message:', message, e);
    }
  }

  private async handleRequest(id: number | string, method: string, params: unknown): Promise<void> {
    let result: unknown;
    let error: { code: number; message: string } | undefined;

    try {
      switch (method) {
        case 'fs/read_text_file':
          error = { code: JSONRPC_METHOD_NOT_FOUND, message: 'fs/read_text_file not available on this client' };
          break;
        case 'fs/write_text_file':
          error = { code: JSONRPC_METHOD_NOT_FOUND, message: 'fs/write_text_file not available on this client' };
          break;
        case 'session/request_permission':
          result = await this.requestPermission(params as RequestPermissionRequest);
          break;
        default:
          error = { code: JSONRPC_METHOD_NOT_FOUND, message: `Method not found: ${method}` };
      }
    } catch (e) {
      error = { code: -32603, message: e instanceof Error ? e.message : String(e) };
    }

    const response = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result };

    getTrafficStore().addEntry({
      direction: 'out',
      type: 'response',
      method,
      requestId: id,
      payload: response,
      error: !!error,
    });

    this.sendFrame(JSON.stringify(response));
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'session/update' && this.onSessionUpdate) {
      this.onSessionUpdate(params as SessionNotification);
    }
  }

  private async sendRequest<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextRequestId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params: params || {},
    };

    getTrafficStore().addEntry({
      direction: 'out',
      type: 'request',
      method,
      requestId: id,
      payload: request,
    });
    this.pendingMethods.set(id, method);

    console.log('Sending request:', request);

    return new Promise((resolve, reject) => {
      this.messageResolvers.set(id, (response) => {
        resolve(response as T);
      });
      this.messageRejecters.set(id, reject);

      try {
        this.sendFrame(JSON.stringify(request));
      } catch (e) {
        this.messageResolvers.delete(id);
        this.messageRejecters.delete(id);
        this.pendingMethods.delete(id);
        reject(e);
      }

      setTimeout(() => {
        if (this.messageResolvers.has(id)) {
          this.messageResolvers.delete(id);
          this.messageRejecters.delete(id);
          this.pendingMethods.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 60000);
    });
  }

  private async sendNotification(method: string, params?: unknown): Promise<void> {
    const notification = {
      jsonrpc: '2.0',
      method,
      params: params || {},
    };

    getTrafficStore().addEntry({
      direction: 'out',
      type: 'notification',
      method,
      payload: notification,
    });

    this.sendFrame(JSON.stringify(notification));
  }

  private sendFrame(json: string): void {
    if (this.disconnected || this.socket.readyState === WebSocket.CLOSED) {
      throw new Error('WebSocket is closed');
    }
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket is not open (readyState=${this.socket.readyState})`);
    }
    this.socket.send(json.endsWith('\n') ? json : `${json}\n`);
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return this.sendRequest<InitializeResponse>('initialize', params);
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return this.sendRequest<NewSessionResponse>('session/new', params);
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.sendRequest<LoadSessionResponse>('session/load', params);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.sendRequest<PromptResponse>('session/prompt', params);
  }

  async cancel(params: CancelNotification): Promise<void> {
    await this.sendNotification('session/cancel', params);
  }

  async setMode(params: { sessionId: string; modeId: string }): Promise<void> {
    await this.sendRequest('session/set_mode', params);
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    await this.sendRequest('session/set_model', params);
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return this.sendRequest<AuthenticateResponse>('authenticate', params);
  }

  async requestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      this.pendingPermissionRequest.value = {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: params.toolCall.toolCallId,
          title: params.toolCall.title ?? '',
          kind: params.toolCall.kind ?? 'other',
          status: (params.toolCall.status as 'pending' | 'in_progress' | 'completed' | 'failed') ?? 'pending',
          locations: params.toolCall.locations ?? undefined,
        },
        options: params.options.map((opt) => ({
          kind: opt.kind,
          name: opt.name,
          optionId: opt.optionId,
        })),
      };
      this.permissionResolver = resolve;
    });
  }

  resolvePermission(optionId: string): void {
    if (this.permissionResolver) {
      this.permissionResolver({
        outcome: {
          outcome: 'selected',
          optionId,
        },
      });
      this.permissionResolver = null;
      this.pendingPermissionRequest.value = null;
    }
  }

  cancelPermission(): void {
    if (this.permissionResolver) {
      this.permissionResolver({
        outcome: {
          outcome: 'cancelled',
        },
      });
      this.permissionResolver = null;
      this.pendingPermissionRequest.value = null;
    }
  }

  async sessionUpdate(_params: SessionNotification): Promise<void> {
    // This is called by the agent; inbound notifications are handled above.
  }

}

export async function createAcpClient(
  arg: { name: string; config: AgentConfig }
): Promise<AcpClientBridge> {
  if (!arg.config.url) {
    throw new Error(`Agent '${arg.name}' is missing 'url' for websocket transport`);
  }

  const socket = new WebSocket(arg.config.url);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`WebSocket connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
      });
    }, CONNECT_TIMEOUT_MS);

    socket.addEventListener('open', () => settle(resolve));
    socket.addEventListener('error', () => settle(() => reject(new Error('WebSocket connect failed'))));
    socket.addEventListener('close', (event) => {
      settle(() =>
        reject(
          new Error(
            `WebSocket closed before open (code=${event.code}, reason=${event.reason || 'unknown'})`
          )
        )
      );
    });
  });

  return new AcpClientBridge(socket);
}
