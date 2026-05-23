// Session store for managing ACP sessions and persistence
import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import type { SavedSession, ChatMessage, ToolCallInfo, PermissionRequest, SessionMode, SlashCommand, ModelInfo, AgentConfig } from '../lib/types';
import { AcpClientBridge, createAcpClient } from '../lib/acp-bridge';
import { useConfigStore } from './config';
import type { SessionNotification, AuthMethod } from '@agentclientprotocol/sdk';

const STORE_PATH = 'sessions.json';
const PROTOCOL_VERSION = 1;

const appVersion =
  (import.meta.env as Record<string, string | undefined>).VITE_APP_VERSION ?? '0.0.0-web';

export const useSessionStore = defineStore('session', () => {
  // State
  const savedSessions = ref<SavedSession[]>([]);
  const currentSession = ref<SavedSession | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const toolCalls = ref<Map<string, ToolCallInfo>>(new Map());
  const isConnected = ref(false);
  const isLoading = ref(false);
  const isConnecting = ref(false);
  // True while a foreground reconnect attempt is in flight. Distinct from
  // `isConnecting` (which is the multi-phase initial spawn/connect path):
  // reconnects skip the spawn/stderr-progress UI and just need a small
  // "Reconnecting鈥? indicator.
  const isReconnecting = ref(false);
  const error = ref<string | null>(null);
  const pendingPermission = ref<PermissionRequest | null>(null);

  // Authentication state
  const pendingAuthMethods = ref<AuthMethod[]>([]);
  const pendingAuthAgentName = ref<string>('');
  let authMethodResolver: ((methodId: string | null) => void) | null = null;

  // Session modes
  const availableModes = ref<SessionMode[]>([]);
  const currentModeId = ref<string>('');

  // Slash commands
  const availableCommands = ref<SlashCommand[]>([]);

  // Session models
  const availableModels = ref<ModelInfo[]>([]);
  const currentModelId = ref<string>('');

  // Connection cancellation
  let connectionAborted = false;

  // Startup progress tracking
  const startupPhase = ref<string>('starting');
  const startupLogs = ref<string[]>([]);
  const startupElapsed = ref<number>(0);
  let startupTimer: ReturnType<typeof setInterval> | null = null;

  // Current ACP client
  let acpClient: AcpClientBridge | null = null;
  let store: KVStore | null = null;

  // Computed
  const hasActiveSession = computed(() => currentSession.value !== null);
  const messageList = computed(() => messages.value);
  const toolCallList = computed(() => Array.from(toolCalls.value.values()));
  // Only sessions that support resuming (loadSession capability)
  const resumableSessions = computed(() =>
    savedSessions.value.filter(s => s.supportsLoadSession === true)
  );

  // Initialize store
  async function initStore() {
    store = await loadKvStore(STORE_PATH);
    const saved = await store.get<SavedSession[]>('sessions');
    if (saved) {
      savedSessions.value = saved;
    }
  }

  async function saveSessionsToStore() {
    if (store) {
      await store.set('sessions', savedSessions.value);
      await store.save();
    }
  }

  // Handle an unexpected WebSocket close. The bridge has already rejected any
  // in-flight requests; we just need to tear down UI state so the user gets
  // a clear "disconnected" signal instead of a stale "connected" view.
  function handleUnexpectedClose(reason?: string): void {
    // If `acpClient` is already null, this fired during a voluntary
    // disconnect that's tearing down anyway 鈥?nothing to do.
    if (!acpClient) return;
    acpClient = null;
    isConnected.value = false;
    isLoading.value = false;
    pendingPermission.value = null;
    error.value = `Connection lost: ${reason ?? 'websocket closed'}`;
  }

  // Session update handler
  function handleSessionUpdate(notification: SessionNotification) {
    const update = notification.update;

    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        // Append to last user message or create new (for replay)
        const lastUserMsg = messages.value[messages.value.length - 1];
        if (lastUserMsg && lastUserMsg.role === 'user') {
          if (update.content.type === 'text') {
            lastUserMsg.content += update.content.text;
          }
        } else {
          messages.value.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
          });
        }
        break;

      case 'agent_message_chunk':
        // Append to last assistant message or create new
        const lastMsg = messages.value[messages.value.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          if (update.content.type === 'text') {
            lastMsg.content += update.content.text;
          }
        } else {
          messages.value.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
            toolCalls: [],
          });
        }
        break;

      case 'agent_thought_chunk':
        // Append to last assistant message's thought field or create new
        const lastAssistantMsg = messages.value[messages.value.length - 1];
        if (lastAssistantMsg && lastAssistantMsg.role === 'assistant') {
          if (update.content.type === 'text') {
            lastAssistantMsg.thought = (lastAssistantMsg.thought || '') + update.content.text;
          }
        } else {
          messages.value.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            thought: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
            toolCalls: [],
          });
        }
        break;

      case 'tool_call':
        // Add tool call to the current assistant message
        const currentAssistantMsg = messages.value[messages.value.length - 1];
        if (currentAssistantMsg && currentAssistantMsg.role === 'assistant') {
          if (!currentAssistantMsg.toolCalls) {
            currentAssistantMsg.toolCalls = [];
          }
          currentAssistantMsg.toolCalls.push({
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind || 'other',
            status: update.status || 'pending',
            locations: update.locations,
          });
        }
        // Also keep in global map for updates
        toolCalls.value.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind || 'other',
          status: update.status || 'pending',
          locations: update.locations,
        });
        break;

      case 'tool_call_update':
        const existing = toolCalls.value.get(update.toolCallId);
        if (existing) {
          if (update.status) existing.status = update.status;
          if (update.title) existing.title = update.title;
          // Also update in the message's toolCalls array
          for (const msg of messages.value) {
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

      case 'current_mode_update':
        // Agent changed the mode
        if ('modeId' in update && update.modeId) {
          currentModeId.value = update.modeId as string;
        }
        break;

      case 'available_commands_update':
        // Agent advertised slash commands
        if ('availableCommands' in update && Array.isArray(update.availableCommands)) {
          availableCommands.value = update.availableCommands.map((cmd) => ({
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

  // Prompt user to select auth method
  async function promptForAuthMethod(authMethods: AuthMethod[], agentName: string): Promise<string | null> {
    return new Promise((resolve) => {
      pendingAuthMethods.value = authMethods;
      pendingAuthAgentName.value = agentName;
      authMethodResolver = resolve;
    });
  }

  // User selected an auth method
  function selectAuthMethod(methodId: string): void {
    if (authMethodResolver) {
      authMethodResolver(methodId);
      authMethodResolver = null;
      pendingAuthMethods.value = [];
      pendingAuthAgentName.value = '';
    }
  }

  // User cancelled auth selection
  function cancelAuthSelection(): void {
    if (authMethodResolver) {
      authMethodResolver(null);
      authMethodResolver = null;
      pendingAuthMethods.value = [];
      pendingAuthAgentName.value = '';
    }
  }

  // Create new session
  async function createSession(agentName: string, cwd: string): Promise<void> {
    isLoading.value = true;
    isConnecting.value = true;
    connectionAborted = false;
    error.value = null;

    const configStore = useConfigStore();
    const agentConfig: AgentConfig | undefined = configStore.getAgent(agentName);

    startupPhase.value = 'connecting';
    startupLogs.value = [];
    startupElapsed.value = 0;
    startupTimer = setInterval(() => {
      startupElapsed.value++;
    }, 1000);

    try {
      if (!agentConfig) {
        throw new Error(`Agent '${agentName}' not found in config`);
      }

      if (connectionAborted) {
        throw new Error('Connection cancelled');
      }

      acpClient = await createAcpClient({ name: agentName, config: agentConfig });
      acpClient.onSessionUpdate = handleSessionUpdate;
      acpClient.onTransportClose = (reason) => {
        handleUnexpectedClose(reason);
      };

      watch(
        () => acpClient?.pendingPermissionRequest.value,
        (newValue) => {
          pendingPermission.value = newValue ?? null;
        },
        { immediate: true }
      );

      if (connectionAborted) {
        await acpClient.disconnect();
        throw new Error('Connection cancelled');
      }

      const initResponse = await acpClient.initialize({
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

      console.log('Agent initialized:', initResponse);

      const supportsLoadSession = initResponse.agentCapabilities?.loadSession ?? false;

      if (connectionAborted) {
        await acpClient.disconnect();
        throw new Error('Connection cancelled');
      }

      const availableAuthMethods = initResponse.authMethods || [];

      if (connectionAborted) {
        await acpClient.disconnect();
        throw new Error('Connection cancelled');
      }

      let sessionResponse;
      try {
        sessionResponse = await acpClient.newSession({
          cwd,
          mcpServers: [],
        });
      } catch (sessionError: unknown) {
        const errorMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
        const isAuthRequired = errorMessage.toLowerCase().includes('authentication required') ||
                               errorMessage.includes('-32000');

        if (isAuthRequired && availableAuthMethods.length > 0) {
          console.log('Authentication required, available methods:', availableAuthMethods);

          const selectedMethodId = await promptForAuthMethod(availableAuthMethods, agentName);

          if (!selectedMethodId || connectionAborted) {
            await acpClient.disconnect();
            throw new Error('Authentication cancelled by user');
          }

          console.log('Authenticating with method:', selectedMethodId);
          const authResponse = await acpClient.authenticate({
            methodId: selectedMethodId,
          });
          console.log('Authentication successful:', authResponse);

          if (connectionAborted) {
            await acpClient.disconnect();
            throw new Error('Connection cancelled');
          }

          sessionResponse = await acpClient.newSession({
            cwd,
            mcpServers: [],
          });
        } else {
          throw sessionError;
        }
      }

      const session: SavedSession = {
        id: crypto.randomUUID(),
        agentName,
        sessionId: sessionResponse.sessionId,
        title: `Session ${new Date().toLocaleString()}`,
        lastUpdated: Date.now(),
        cwd,
        supportsLoadSession,
      };

      currentSession.value = session;
      savedSessions.value.push(session);
      await saveSessionsToStore();

      isConnected.value = true;
      messages.value = [];
      toolCalls.value.clear();

      if (sessionResponse.modes) {
        availableModes.value = (sessionResponse.modes.availableModes || []).map(m => ({
          id: m.id,
          name: m.name,
          description: m.description ?? undefined,
        }));
        currentModeId.value = sessionResponse.modes.currentModeId || '';
      } else {
        availableModes.value = [];
        currentModeId.value = '';
      }

      if (sessionResponse.models) {
        availableModels.value = (sessionResponse.models.availableModels || []).map(m => ({
          modelId: m.modelId,
          name: m.name,
          description: m.description ?? undefined,
        }));
        currentModelId.value = sessionResponse.models.currentModelId || '';
      } else {
        availableModels.value = [];
        currentModelId.value = '';
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      if (acpClient) {
        try {
          await acpClient.disconnect();
        } catch (cleanupErr) {
          console.warn('disconnect during createSession cleanup failed:', cleanupErr);
        }
      }
      acpClient = null;
      throw e;
    } finally {
      isLoading.value = false;
      isConnecting.value = false;
      if (startupTimer) {
        clearInterval(startupTimer);
        startupTimer = null;
      }
    }
  }
  // Resume existing session
  async function resumeSession(savedSession: SavedSession): Promise<void> {
    isLoading.value = true;
    error.value = null;

    try {
      const configStore = useConfigStore();
      const agentConfig: AgentConfig | undefined = configStore.getAgent(savedSession.agentName);
      if (!agentConfig) {
        throw new Error(`Agent '${savedSession.agentName}' not found in config`);
      }

      // Create ACP client bridge.
      acpClient = await createAcpClient({
        name: savedSession.agentName,
        config: agentConfig,
      });
      acpClient.onSessionUpdate = handleSessionUpdate;
      // Surface unexpected WebSocket closes so the UI doesn't sit on a stale
      // "connected" view forever.
      acpClient.onTransportClose = (reason) => {
        handleUnexpectedClose(reason);
      };

      // Sync bridge's pendingPermissionRequest to store's pendingPermission
      watch(
        () => acpClient?.pendingPermissionRequest.value,
        (newValue) => {
          pendingPermission.value = newValue ?? null;
        },
        { immediate: true }
      );

      // Initialize connection
      const initResponse = await acpClient.initialize({
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

      // Store available auth methods for potential retry
      const availableAuthMethods = initResponse.authMethods || [];

      // Clear messages BEFORE loadSession - the agent will stream replay via notifications
      messages.value = [];
      toolCalls.value.clear();

      // Try to load existing session - may fail with auth_required
      try {
        await acpClient.loadSession({
          sessionId: savedSession.sessionId,
          cwd: savedSession.cwd,
          mcpServers: [],
        });
      } catch (sessionError: unknown) {
        // Check if auth is required (error code -32000)
        const errorMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
        const isAuthRequired = errorMessage.toLowerCase().includes('authentication required') ||
                               errorMessage.includes('-32000');

        if (isAuthRequired && availableAuthMethods.length > 0) {
          console.log('Authentication required, available methods:', availableAuthMethods);

          // Prompt user to select auth method
          const selectedMethodId = await promptForAuthMethod(availableAuthMethods, savedSession.agentName);

          if (!selectedMethodId) {
            await acpClient.disconnect();
            throw new Error('Authentication cancelled by user');
          }

          console.log('Authenticating with method:', selectedMethodId);
          const authResponse = await acpClient.authenticate({
            methodId: selectedMethodId,
          });
          console.log('Authentication successful:', authResponse);

          // Retry loading session after auth
          await acpClient.loadSession({
            sessionId: savedSession.sessionId,
            cwd: savedSession.cwd,
            mcpServers: [],
          });
        } else {
          throw sessionError;
        }
      }

      currentSession.value = savedSession;
      isConnected.value = true;
      // Messages already populated by session/update notifications during loadSession

      // Update last accessed time
      savedSession.lastUpdated = Date.now();
      await saveSessionsToStore();

    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      if (acpClient) {
        try {
          await acpClient.disconnect();
        } catch (cleanupErr) {
          console.warn('disconnect during resumeSession cleanup failed:', cleanupErr);
        }
        acpClient = null;
      }
      throw e;
    } finally {
      isLoading.value = false;
    }
  }

  // Send prompt
  async function sendPrompt(text: string): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }

    // Add user message
    messages.value.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    });

    isLoading.value = true;
    try {
      const response = await acpClient.prompt({
        sessionId: currentSession.value.sessionId,
        prompt: [
          {
            type: 'text',
            text,
          },
        ],
      });

      console.log('Prompt completed:', response.stopReason);

      // Update session title if it's the first message
      if (messages.value.length === 2 && currentSession.value) {
        currentSession.value.title = text.slice(0, 50) + (text.length > 50 ? '...' : '');
        currentSession.value.lastUpdated = Date.now();
        await saveSessionsToStore();
      }
    } finally {
      isLoading.value = false;
    }
  }

  // Cancel current operation
  async function cancelOperation(): Promise<void> {
    if (!acpClient || !currentSession.value) return;

    await acpClient.cancel({
      sessionId: currentSession.value.sessionId,
    });
  }

  // Cancel ongoing connection attempt
  async function cancelConnection(): Promise<void> {
    connectionAborted = true;

    // Cancel auth selection if pending
    if (authMethodResolver) {
      authMethodResolver(null);
      authMethodResolver = null;
      pendingAuthMethods.value = [];
      pendingAuthAgentName.value = '';
    }

    // Disconnect if client exists
    if (acpClient) {
      try {
        await acpClient.disconnect();
      } catch (e) {
        console.error('Error disconnecting:', e);
      }
      acpClient = null;
    }

    isLoading.value = false;
    isConnecting.value = false;
    error.value = null;
  }

  // Handle permission response
  function resolvePermission(optionId: string): void {
    if (acpClient) {
      acpClient.resolvePermission(optionId);
    }
  }

  function cancelPermission(): void {
    if (acpClient) {
      acpClient.cancelPermission();
    }
  }

  // Disconnect current session
  async function disconnect(): Promise<void> {
    if (acpClient) {
      await acpClient.disconnect();
      acpClient = null;
    }

    currentSession.value = null;
    isConnected.value = false;
    messages.value = [];
    toolCalls.value.clear();
    availableModes.value = [];
    currentModeId.value = '';
    availableCommands.value = [];
    availableModels.value = [];
    currentModelId.value = '';
  }

  // Delete saved session
  async function deleteSession(sessionId: string): Promise<void> {
    savedSessions.value = savedSessions.value.filter(s => s.id !== sessionId);
    await saveSessionsToStore();
  }

  // Set session mode
  async function setMode(modeId: string): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }

    await acpClient.setMode({
      sessionId: currentSession.value.sessionId,
      modeId,
    });

    // Optimistically update the current mode
    currentModeId.value = modeId;
  }

  // Set session model
  async function setModel(modelId: string): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }

    await acpClient.unstable_setSessionModel({
      sessionId: currentSession.value.sessionId,
      modelId,
    });

    // Optimistically update the current model
    currentModelId.value = modelId;
  }

  function clearError() {
    error.value = null;
  }

  /**
   * Foreground reconnect: when the user returns to the app and we're
   * disconnected (because the OS froze the WebView, the NAT killed the TCP
   * connection, or the network changed), silently re-attach to the saved
   * session if possible.
   *
   * Returns `true` if a reconnect was attempted, `false` if there was
   * nothing to do (no saved session, already connected/connecting, agent
   * doesn't advertise session-load support, etc.).
   *
   * Errors are surfaced via `error.value` exactly like a manual resume
   * would; the caller doesn't need to handle them.
   */
  async function tryReconnect(): Promise<boolean> {
    // Already connected or already trying 鈥?leave it alone.
    if (isConnected.value || isConnecting.value || isLoading.value) {
      return false;
    }
    // No prior session to reconnect to.
    const session = currentSession.value;
    if (!session) {
      return false;
    }
    // Bridge already exists (race with another reconnect in flight).
    if (acpClient) {
      return false;
    }
    // Agent must support `session/load` for resume to be meaningful;
    // otherwise we'd just create a fresh session, which is a strictly
    // user-initiated action.
    if (!session.supportsLoadSession) {
      return false;
    }

    // Clear the stale "Connection lost" banner up-front so the UI shows
    // an honest "Reconnecting鈥? state instead of a contradictory red
    // banner during the attempt. If the reconnect ultimately fails, the
    // catch below restores a real error message.
    error.value = null;
    isReconnecting.value = true;
    try {
      await resumeSession(session);
      return true;
    } catch (e) {
      // `resumeSession`'s own catch already wrote `error.value`; nothing
      // more to do here. Returning true so the caller knows we tried.
      console.warn('Foreground reconnect failed:', e);
      return true;
    } finally {
      isReconnecting.value = false;
    }
  }

  return {
    // State
    savedSessions,
    currentSession,
    messages,
    isConnected,
    isLoading,
    isConnecting,
    isReconnecting,
    error,
    pendingPermission,
    pendingAuthMethods,
    pendingAuthAgentName,
    availableModes,
    currentModeId,
    availableCommands,
    availableModels,
    currentModelId,
    startupPhase,
    startupLogs,
    startupElapsed,

    // Computed
    hasActiveSession,
    messageList,
    toolCallList,
    resumableSessions,

    // Actions
    initStore,
    createSession,
    resumeSession,
    sendPrompt,
    cancelOperation,
    cancelConnection,
    resolvePermission,
    cancelPermission,
    selectAuthMethod,
    cancelAuthSelection,
    disconnect,
    deleteSession,
    setMode,
    setModel,
    clearError,
    tryReconnect,

    // Expose client for permission handling
    get acpClient() { return acpClient; },
  };
});
