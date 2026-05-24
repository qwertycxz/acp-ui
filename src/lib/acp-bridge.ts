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
  AuthMethod,
} from '@agentclientprotocol/sdk';
import type {
  AgentConfig,
  ChatMessage,
  ModelInfo,
  PermissionRequest as LocalPermissionRequest,
  SavedSession,
  SessionMode,
  SlashCommand,
  ToolCallInfo,
} from './types';
import { ref, type Ref } from 'vue';
import { useTrafficStore } from '../stores/traffic';

type PermissionResolver = (response: RequestPermissionResponse) => void;
type AuthMethodResolver = (methodId: string | null) => void;

let trafficStore: ReturnType<typeof useTrafficStore> | null = null;
function getTrafficStore() {
  if (!trafficStore) {
    trafficStore = useTrafficStore();
  }
  return trafficStore;
}

const JSONRPC_METHOD_NOT_FOUND = -32601;
const CONNECT_TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = 1;

interface SessionStartResult {
  sessionId: string;
  supportsLoadSession: boolean;
}

export class AcpClientBridge implements Client {
  private socket: WebSocket;
  private messageResolvers: Map<number, (response: unknown) => void> = new Map();
  private messageRejecters: Map<number, (error: Error) => void> = new Map();
  private pendingMethods: Map<number, string> = new Map();
  private nextRequestId = 0;
  private disconnected = false;

  public pendingPermissionRequest: Ref<LocalPermissionRequest | null> = ref(null);
  private permissionResolver: PermissionResolver | null = null;
  public pendingAuthMethods: Ref<AuthMethod[]> = ref([]);
  public pendingAuthAgentName = ref('');
  private authMethodResolver: AuthMethodResolver | null = null;

  public messages: Ref<ChatMessage[]> = ref([]);
  public toolCalls: Ref<Map<string, ToolCallInfo>> = ref(new Map());
  public availableModes: Ref<SessionMode[]> = ref([]);
  public currentModeId = ref('');
  public availableCommands: Ref<SlashCommand[]> = ref([]);
  public availableModels: Ref<ModelInfo[]> = ref([]);
  public currentModelId = ref('');

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
    if (method === 'session/update') {
      this.handleSessionUpdate(params as SessionNotification);
    }
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;

    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        const lastUserMsg = this.messages.value[this.messages.value.length - 1];
        if (lastUserMsg && lastUserMsg.role === 'user') {
          if (update.content.type === 'text') {
            lastUserMsg.content += update.content.text;
          }
        } else {
          this.messages.value.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'agent_message_chunk': {
        const lastMsg = this.messages.value[this.messages.value.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          if (update.content.type === 'text') {
            lastMsg.content += update.content.text;
          }
        } else {
          this.messages.value.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
            toolCalls: [],
          });
        }
        break;
      }

      case 'agent_thought_chunk': {
        const lastAssistantMsg = this.messages.value[this.messages.value.length - 1];
        if (lastAssistantMsg && lastAssistantMsg.role === 'assistant') {
          if (update.content.type === 'text') {
            lastAssistantMsg.thought = (lastAssistantMsg.thought || '') + update.content.text;
          }
        } else {
          this.messages.value.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            thought: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
            toolCalls: [],
          });
        }
        break;
      }

      case 'tool_call': {
        const currentAssistantMsg = this.messages.value[this.messages.value.length - 1];
        const toolCall = {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind || 'other',
          status: update.status || 'pending',
          locations: update.locations,
        };
        if (currentAssistantMsg && currentAssistantMsg.role === 'assistant') {
          if (!currentAssistantMsg.toolCalls) {
            currentAssistantMsg.toolCalls = [];
          }
          currentAssistantMsg.toolCalls.push(toolCall);
        }
        this.toolCalls.value.set(update.toolCallId, toolCall);
        break;
      }

      case 'tool_call_update': {
        const existing = this.toolCalls.value.get(update.toolCallId);
        if (existing) {
          if (update.status) existing.status = update.status;
          if (update.title) existing.title = update.title;
          for (const msg of this.messages.value) {
            if (msg.toolCalls) {
              const tc = msg.toolCalls.find(t => t.toolCallId === update.toolCallId);
              if (tc) {
                if (update.status) tc.status = update.status;
                if (update.title) tc.title = update.title;
              }
            }
          }
        }
        break;
      }

      case 'current_mode_update':
        if ('modeId' in update && update.modeId) {
          this.currentModeId.value = update.modeId as string;
        }
        break;

      case 'available_commands_update':
        if ('availableCommands' in update && Array.isArray(update.availableCommands)) {
          this.availableCommands.value = update.availableCommands.map((cmd) => ({
            name: cmd.name,
            description: cmd.description,
            hint: cmd.input?.hint ?? undefined,
          }));
        }
        break;

      default:
        console.log('Unhandled session update:', update);
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

  private async initializeForSession(appVersion: string): Promise<InitializeResponse> {
    return this.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
      },
      clientInfo: {
        name: 'acp-ui',
        title: 'ACP UI',
        version: appVersion,
      },
    });
  }

  private resetSessionData(): void {
    this.messages.value = [];
    this.toolCalls.value.clear();
    this.availableModes.value = [];
    this.currentModeId.value = '';
    this.availableCommands.value = [];
    this.availableModels.value = [];
    this.currentModelId.value = '';
  }

  private applyNewSessionMetadata(sessionResponse: NewSessionResponse): void {
    if (sessionResponse.modes) {
      this.availableModes.value = (sessionResponse.modes.availableModes || []).map(m => ({
        id: m.id,
        name: m.name,
        description: m.description ?? undefined,
      }));
      this.currentModeId.value = sessionResponse.modes.currentModeId || '';
    } else {
      this.availableModes.value = [];
      this.currentModeId.value = '';
    }

    if (sessionResponse.models) {
      this.availableModels.value = (sessionResponse.models.availableModels || []).map(m => ({
        modelId: m.modelId,
        name: m.name,
        description: m.description ?? undefined,
      }));
      this.currentModelId.value = sessionResponse.models.currentModelId || '';
    } else {
      this.availableModels.value = [];
      this.currentModelId.value = '';
    }
  }

  private assertNotAborted(shouldAbort?: () => boolean): void {
    if (shouldAbort?.()) {
      throw new Error('Connection cancelled');
    }
  }

  private isAuthenticationRequired(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes('authentication required') || message.includes('-32000');
  }

  private async promptForAuthMethod(
    authMethods: AuthMethod[],
    agentName: string
  ): Promise<string | null> {
    return new Promise((resolve) => {
      this.pendingAuthMethods.value = authMethods;
      this.pendingAuthAgentName.value = agentName;
      this.authMethodResolver = resolve;
    });
  }

  private clearAuthPrompt(): void {
    this.authMethodResolver = null;
    this.pendingAuthMethods.value = [];
    this.pendingAuthAgentName.value = '';
  }

  async retryWithAuth<T>(
    error: unknown,
    authMethods: AuthMethod[],
    agentName: string,
    retry: () => Promise<T>,
    shouldAbort?: () => boolean
  ): Promise<T> {
    if (!this.isAuthenticationRequired(error) || authMethods.length === 0) {
      throw error;
    }

    const selectedMethodId = await this.promptForAuthMethod(authMethods, agentName);
    this.assertNotAborted(shouldAbort);
    if (!selectedMethodId) {
      await this.disconnect();
      throw new Error('Authentication cancelled by user');
    }

    await this.authenticate({ methodId: selectedMethodId });
    this.assertNotAborted(shouldAbort);
    return retry();
  }

  async startNewSession(
    agentName: string,
    cwd: string,
    appVersion: string,
    shouldAbort?: () => boolean
  ): Promise<SessionStartResult> {
    this.assertNotAborted(shouldAbort);
    this.resetSessionData();
    const initResponse = await this.initializeForSession(appVersion);
    const authMethods = initResponse.authMethods || [];
    const supportsLoadSession = initResponse.agentCapabilities?.loadSession ?? false;
    this.assertNotAborted(shouldAbort);

    const sessionResponse = await this.newSession({ cwd, mcpServers: [] }).catch((error: unknown) =>
      this.retryWithAuth(
        error,
        authMethods,
        agentName,
        () => this.newSession({ cwd, mcpServers: [] }),
        shouldAbort
      )
    );
    this.assertNotAborted(shouldAbort);
    this.applyNewSessionMetadata(sessionResponse);
    return {
      sessionId: sessionResponse.sessionId,
      supportsLoadSession,
    };
  }

  async loadSavedSession(
    savedSession: SavedSession,
    appVersion: string,
    shouldAbort?: () => boolean
  ): Promise<void> {
    this.assertNotAborted(shouldAbort);
    const initResponse = await this.initializeForSession(appVersion);
    const authMethods = initResponse.authMethods || [];
    this.resetSessionData();
    this.assertNotAborted(shouldAbort);

    await this.loadSession({
      sessionId: savedSession.sessionId,
      cwd: savedSession.cwd,
      mcpServers: [],
    }).catch((error: unknown) =>
      this.retryWithAuth(
        error,
        authMethods,
        savedSession.agentName,
        () =>
          this.loadSession({
            sessionId: savedSession.sessionId,
            cwd: savedSession.cwd,
            mcpServers: [],
          }),
        shouldAbort
      )
    );
  }

  async sendPromptText(sessionId: string, text: string): Promise<PromptResponse> {
    this.messages.value.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    });

    return this.prompt({
      sessionId,
      prompt: [
        {
          type: 'text',
          text,
        },
      ],
    });
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.cancel({ sessionId });
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    await this.setMode({ sessionId, modeId });
    this.currentModeId.value = modeId;
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    await this.unstable_setSessionModel({ sessionId, modelId });
    this.currentModelId.value = modelId;
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

  selectAuthMethod(methodId: string): void {
    if (this.authMethodResolver) {
      this.authMethodResolver(methodId);
      this.clearAuthPrompt();
    }
  }

  cancelAuthSelection(): void {
    if (this.authMethodResolver) {
      this.authMethodResolver(null);
      this.clearAuthPrompt();
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
