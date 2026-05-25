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
  ChatMessage,
  ModelInfo,
  PermissionRequest as LocalPermissionRequest,
  SavedSession,
  SessionMode,
  SlashCommand,
  ToolCallInfo,
  TrafficEntry,
  TrafficFilter,
} from './types';
import { markRaw } from 'vue';

type PermissionResolver = (response: RequestPermissionResponse) => void;
type AuthMethodResolver = (methodId: string | null) => void;

const JSONRPC_METHOD_NOT_FOUND = -32601;
const PROTOCOL_VERSION = 1;
const MAX_TRAFFIC_ENTRIES = 500;

export class AcpClientBridge implements Client {
  private socket: WebSocket | null = null;
  private readonly url: string;
  private socketReadyState: number = WebSocket.CLOSED;
  private connectPromise: Promise<void> | null = null;
  private messageResolvers: Map<number, (response: unknown) => void> = markRaw(new Map());
  private messageRejecters: Map<number, (error: Error) => void> = markRaw(new Map());
  private pendingMethods: Map<number, string> = markRaw(new Map());
  private nextRequestId = 0;
  private disconnected = false;
  private connectionAborted = false;
  private startupTimer: ReturnType<typeof setInterval> | null = null;

  public pendingPermissionRequest: LocalPermissionRequest | null = null;
  private permissionResolver: PermissionResolver | null = null;
  public pendingAuthMethods: AuthMethod[] = [];
  public pendingAuthAgentName = '';
  private authMethodResolver: AuthMethodResolver | null = null;

  public messages: ChatMessage[] = [];
  public toolCalls: Map<string, ToolCallInfo> = new Map();
  public availableModes: SessionMode[] = [];
  public currentModeId = '';
  public availableCommands: SlashCommand[] = [];
  public availableModels: ModelInfo[] = [];
  public currentModelId = '';

  public currentSession: SavedSession | null = null;
  public isLoading = false;
  public isConnecting = false;
  public isReconnecting = false;
  public sessionError: string | null = null;
  public startupPhase = 'starting';
  public startupLogs: string[] = [];
  public startupElapsed = 0;
  public trafficEntries: TrafficEntry[] = [];
  public isTrafficPaused = false;
  public trafficFilter: TrafficFilter = 'all';
  public trafficSearchQuery = '';

  constructor(url: string) {
    this.url = url;
  }

  public get isConnected(): boolean {
    return this.socketReadyState === WebSocket.OPEN && this.currentSession !== null;
  }

  public get filteredTrafficEntries(): TrafficEntry[] {
    let result = this.trafficEntries;

    switch (this.trafficFilter) {
      case 'requests':
        result = result.filter((entry) => entry.type === 'request');
        break;
      case 'responses':
        result = result.filter((entry) => entry.type === 'response');
        break;
      case 'notifications':
        result = result.filter((entry) => entry.type === 'notification');
        break;
    }

    const query = this.trafficSearchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter(
        (entry) =>
          entry.method.toLowerCase().includes(query) ||
          JSON.stringify(entry.payload).toLowerCase().includes(query)
      );
    }

    return result;
  }

  private addTrafficEntry(entry: Omit<TrafficEntry, 'id' | 'timestamp'>): void {
    if (this.isTrafficPaused) return;

    this.trafficEntries.push({
      ...entry,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    });

    if (this.trafficEntries.length > MAX_TRAFFIC_ENTRIES) {
      this.trafficEntries = this.trafficEntries.slice(-MAX_TRAFFIC_ENTRIES);
    }
  }

  clearTraffic(): void {
    this.trafficEntries = [];
  }

  toggleTrafficPause(): void {
    this.isTrafficPaused = !this.isTrafficPaused;
  }

  setTrafficFilter(filter: TrafficFilter): void {
    this.trafficFilter = filter;
  }

  setTrafficSearch(query: string): void {
    this.trafficSearchQuery = query;
  }

  clearTrafficSearch(): void {
    this.trafficSearchQuery = '';
  }

  async connect(): Promise<void> {
    if (this.socketReadyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    if (this.disconnected) {
      throw new Error('WebSocket is closed');
    }

    const socket = markRaw(new WebSocket(this.url));
    this.socket = socket;
    this.socketReadyState = socket.readyState;
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

    this.connectPromise = new Promise<void>((resolve, reject) => {
      function cleanup() {
        socket.removeEventListener('open', handleOpen);
        socket.removeEventListener('error', handleError);
        socket.removeEventListener('close', handleClose);
      }
      const handleOpen = () => {
        cleanup();
        this.socketReadyState = socket.readyState;
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error('WebSocket connect failed'));
      };
      const handleClose = (event: CloseEvent) => {
        cleanup();
        reject(
          new Error(
            `WebSocket closed before open (code=${event.code}, reason=${event.reason || 'unknown'})`
          )
        );
      };

      socket.addEventListener('open', handleOpen);
      socket.addEventListener('error', handleError);
      socket.addEventListener('close', handleClose);
    });

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    this.disconnected = true;
    this.rejectInFlight(new Error('websocket closed: client disconnected'));
    this.stopConnectionTimer();
    this.isLoading = false;
    this.isConnecting = false;
    this.isReconnecting = false;
    this.socketReadyState = WebSocket.CLOSED;
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
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
    this.stopConnectionTimer();
    this.socketReadyState = WebSocket.CLOSED;
    this.isLoading = false;
    this.isConnecting = false;
    this.isReconnecting = false;
    this.sessionError = `Connection lost: ${reason}`;
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

      if ('id' in parsed && parsed.id !== undefined && !('method' in parsed)) {
        this.addTrafficEntry({
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
        this.addTrafficEntry({
          direction: 'in',
          type: 'request',
          method: parsed.method,
          requestId: parsed.id,
          payload: parsed,
        });
        void this.handleRequest(parsed.id, parsed.method, parsed.params);
      }

      if (!('id' in parsed) && parsed.method) {
        this.addTrafficEntry({
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

    this.addTrafficEntry({
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
        const lastUserMsg = this.messages[this.messages.length - 1];
        if (lastUserMsg && lastUserMsg.role === 'user') {
          if (update.content.type === 'text') {
            lastUserMsg.content += update.content.text;
          }
        } else {
          this.messages.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'agent_message_chunk': {
        const lastMsg = this.messages[this.messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          if (update.content.type === 'text') {
            lastMsg.content += update.content.text;
          }
        } else {
          this.messages.push({
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
        const lastAssistantMsg = this.messages[this.messages.length - 1];
        if (lastAssistantMsg && lastAssistantMsg.role === 'assistant') {
          if (update.content.type === 'text') {
            lastAssistantMsg.thought = (lastAssistantMsg.thought || '') + update.content.text;
          }
        } else {
          this.messages.push({
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
        const currentAssistantMsg = this.messages[this.messages.length - 1];
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
        this.toolCalls.set(update.toolCallId, toolCall);
        break;
      }

      case 'tool_call_update': {
        const existing = this.toolCalls.get(update.toolCallId);
        if (existing) {
          if (update.status) existing.status = update.status;
          if (update.title) existing.title = update.title;
          for (const msg of this.messages) {
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
          this.currentModeId = update.modeId as string;
        }
        break;

      case 'available_commands_update':
        if ('availableCommands' in update && Array.isArray(update.availableCommands)) {
          this.availableCommands = update.availableCommands.map((cmd) => ({
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

    this.addTrafficEntry({
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
    });
  }

  private async sendNotification(method: string, params?: unknown): Promise<void> {
    const notification = {
      jsonrpc: '2.0',
      method,
      params: params || {},
    };

    this.addTrafficEntry({
      direction: 'out',
      type: 'notification',
      method,
      payload: notification,
    });

    this.sendFrame(JSON.stringify(notification));
  }

  private sendFrame(json: string): void {
    if (!this.socket || this.disconnected || this.socket.readyState === WebSocket.CLOSED) {
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
    this.messages = [];
    this.toolCalls.clear();
    this.availableModes = [];
    this.currentModeId = '';
    this.availableCommands = [];
    this.availableModels = [];
    this.currentModelId = '';
  }

  private startConnectionTimer(): void {
    this.startupPhase = 'connecting';
    this.startupLogs = [];
    this.startupElapsed = 0;
    this.stopConnectionTimer();
    this.startupTimer = setInterval(() => {
      this.startupElapsed++;
    }, 1000);
  }

  private stopConnectionTimer(): void {
    if (this.startupTimer) {
      clearInterval(this.startupTimer);
      this.startupTimer = null;
    }
  }

  private applyNewSessionMetadata(sessionResponse: NewSessionResponse): void {
    if (sessionResponse.modes) {
      this.availableModes = (sessionResponse.modes.availableModes || []).map(m => ({
        id: m.id,
        name: m.name,
        description: m.description ?? undefined,
      }));
      this.currentModeId = sessionResponse.modes.currentModeId || '';
    } else {
      this.availableModes = [];
      this.currentModeId = '';
    }

    if (sessionResponse.models) {
      this.availableModels = (sessionResponse.models.availableModels || []).map(m => ({
        modelId: m.modelId,
        name: m.name,
        description: m.description ?? undefined,
      }));
      this.currentModelId = sessionResponse.models.currentModelId || '';
    } else {
      this.availableModels = [];
      this.currentModelId = '';
    }
  }

  private assertNotAborted(): void {
    if (this.connectionAborted) {
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
      this.pendingAuthMethods = authMethods;
      this.pendingAuthAgentName = agentName;
      this.authMethodResolver = resolve;
    });
  }

  private clearAuthPrompt(): void {
    this.authMethodResolver = null;
    this.pendingAuthMethods = [];
    this.pendingAuthAgentName = '';
  }

  async retryWithAuth<T>(
    error: unknown,
    authMethods: AuthMethod[],
    agentName: string,
    retry: () => Promise<T>
  ): Promise<T> {
    if (!this.isAuthenticationRequired(error) || authMethods.length === 0) {
      throw error;
    }

    const selectedMethodId = await this.promptForAuthMethod(authMethods, agentName);
    this.assertNotAborted();
    if (!selectedMethodId) {
      await this.disconnect();
      throw new Error('Authentication cancelled by user');
    }

    await this.authenticate({ methodId: selectedMethodId });
    this.assertNotAborted();
    return retry();
  }

  async startNewSession(
    agentName: string,
    cwd: string,
    appVersion: string
  ): Promise<void> {
    this.isLoading = true;
    this.isConnecting = true;
    this.connectionAborted = false;
    this.sessionError = null;
    this.currentSession = null;
    this.startConnectionTimer();

    try {
      await this.connect();
      this.assertNotAborted();
      this.resetSessionData();
      const initResponse = await this.initializeForSession(appVersion);
      const authMethods = initResponse.authMethods || [];
      const supportsLoadSession = initResponse.agentCapabilities?.loadSession ?? false;
      this.assertNotAborted();

      const sessionResponse = await this.newSession({ cwd, mcpServers: [] }).catch((error: unknown) =>
        this.retryWithAuth(
          error,
          authMethods,
          agentName,
          () => this.newSession({ cwd, mcpServers: [] })
        )
      );
      this.assertNotAborted();
      this.applyNewSessionMetadata(sessionResponse);
      const session = {
        id: crypto.randomUUID(),
        agentName,
        sessionId: sessionResponse.sessionId,
        title: `Session ${new Date().toLocaleString()}`,
        lastUpdated: Date.now(),
        cwd,
        supportsLoadSession,
      };
      this.currentSession = session;
    } catch (e) {
      this.sessionError = e instanceof Error ? e.message : String(e);
      await this.disconnect();
      throw e;
    } finally {
      this.isLoading = false;
      this.isConnecting = false;
      this.stopConnectionTimer();
    }
  }

  async loadSavedSession(
    savedSession: SavedSession,
    appVersion: string,
    reconnecting = false
  ): Promise<void> {
    this.isLoading = true;
    this.isReconnecting = reconnecting;
    this.connectionAborted = false;
    this.sessionError = null;

    try {
      await this.connect();
      this.assertNotAborted();
      const initResponse = await this.initializeForSession(appVersion);
      const authMethods = initResponse.authMethods || [];
      this.resetSessionData();
      this.assertNotAborted();

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
            })
        )
      );
      this.currentSession = savedSession;
      savedSession.lastUpdated = Date.now();
    } catch (e) {
      this.sessionError = e instanceof Error ? e.message : String(e);
      await this.disconnect();
      throw e;
    } finally {
      this.isLoading = false;
      this.isReconnecting = false;
    }
  }

  async sendPromptText(text: string): Promise<PromptResponse> {
    const sessionId = this.currentSession?.sessionId;
    if (!sessionId) {
      this.sessionError = 'No active session';
      throw new Error('No active session');
    }

    this.isLoading = true;
    this.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    });

    try {
      return await this.prompt({
        sessionId,
        prompt: [
          {
            type: 'text',
            text,
          },
        ],
      });
    } catch (e) {
      this.sessionError = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.isLoading = false;
    }
  }

  async cancelCurrentSession(): Promise<void> {
    const sessionId = this.currentSession?.sessionId;
    if (sessionId) {
      await this.cancel({ sessionId });
    }
  }

  async setSessionMode(modeId: string): Promise<void> {
    const sessionId = this.currentSession?.sessionId;
    if (!sessionId) return;
    await this.setMode({ sessionId, modeId });
    this.currentModeId = modeId;
  }

  async setSessionModel(modelId: string): Promise<void> {
    const sessionId = this.currentSession?.sessionId;
    if (!sessionId) return;
    await this.unstable_setSessionModel({ sessionId, modelId });
    this.currentModelId = modelId;
  }

  cancelConnection(): void {
    this.connectionAborted = true;
    this.cancelAuthSelection();
  }

  clearError(): void {
    this.sessionError = null;
  }

  setError(message: string): void {
    this.sessionError = message;
  }

  setCurrentSession(session: SavedSession | null): void {
    this.currentSession = session;
  }

  async requestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      this.pendingPermissionRequest = {
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
      this.pendingPermissionRequest = null;
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
      this.pendingPermissionRequest = null;
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
