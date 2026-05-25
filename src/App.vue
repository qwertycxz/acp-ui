<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { useConfigStore } from './stores/config';
import { AcpClientBridge } from './lib/acp-bridge';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import PermissionDialog from './components/PermissionDialog.vue';
import SettingsView from './components/SettingsView.vue';
import AuthMethodDialog from './components/AuthMethodDialog.vue';
import TrafficMonitor from './components/TrafficMonitor.vue';
import StartupProgress from './components/StartupProgress.vue';
import type { AuthMethod } from '@agentclientprotocol/sdk';
import type {
  AgentSession,
  ChatMessage,
  ModelInfo,
  PermissionRequest,
  SessionMode,
  SlashCommand,
  TrafficEntry,
  TrafficFilter,
} from './lib/types';

type AcpClient = Pick<
  AcpClientBridge,
  | 'pendingPermissionRequest'
  | 'pendingAuthMethods'
  | 'messages'
  | 'availableModes'
  | 'currentModeId'
  | 'availableCommands'
  | 'availableModels'
  | 'currentModelId'
  | 'currentSession'
  | 'sessions'
  | 'isConnected'
  | 'hasActiveSession'
  | 'supportsLoadSession'
  | 'supportsSessionDelete'
  | 'isLoading'
  | 'isConnecting'
  | 'isReconnecting'
  | 'sessionError'
  | 'startupPhase'
  | 'startupLogs'
  | 'startupElapsed'
  | 'trafficEntries'
  | 'filteredTrafficEntries'
  | 'isTrafficPaused'
  | 'trafficFilter'
  | 'trafficSearchQuery'
  | 'disconnect'
  | 'connectAndRefreshSessions'
  | 'refreshSessions'
  | 'startNewSession'
  | 'loadAgentSession'
  | 'deleteAgentSession'
  | 'sendPromptText'
  | 'cancelCurrentSession'
  | 'setSessionMode'
  | 'setSessionModel'
  | 'resolvePermission'
  | 'cancelPermission'
  | 'selectAuthMethod'
  | 'cancelAuthSelection'
>;

const configStore = useConfigStore();
const appVersion =
  (import.meta.env as Record<string, string | undefined>).VITE_APP_VERSION ?? '0.0.0-web';

const selectedCwd = ref('');
const showSidebar = ref(true);
const showSettings = ref(false);
const showTrafficMonitor = ref(false);
const showStartupDetails = ref(false);
const acpClient = ref<AcpClient | null>(null);

// Reactive flag tracking whether the viewport is narrow enough to show the
// sidebar as a slide-in drawer (mobile / very narrow desktop windows). Used
// by the template to decide when the backdrop is interactive and by
// onMounted to default the drawer closed.
const isNarrowLayout = ref(false);
let narrowMql: MediaQueryList | null = null;
function syncNarrowLayout() {
  if (narrowMql) isNarrowLayout.value = narrowMql.matches;
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 1000;
let activeAgentUrl = '';
let isUnmounting = false;

const currentSession = computed(() => acpClient.value?.currentSession ?? null);
const isConnected = computed(() => acpClient.value?.isConnected ?? false);
const hasActiveSession = computed(() => acpClient.value?.hasActiveSession ?? false);
const supportsLoadSession = computed(() => acpClient.value?.supportsLoadSession ?? false);
const supportsSessionDelete = computed(() => acpClient.value?.supportsSessionDelete ?? false);
const isLoading = computed(() => acpClient.value?.isLoading ?? false);
const isConnecting = computed(() => acpClient.value?.isConnecting ?? false);
const isReconnecting = computed(() => acpClient.value?.isReconnecting ?? false);
const sessionError = computed(() => acpClient.value?.sessionError ?? null);
const startupPhase = computed(() => acpClient.value?.startupPhase ?? 'starting');
const startupLogs = computed(() => acpClient.value?.startupLogs ?? []);
const startupElapsed = computed(() => acpClient.value?.startupElapsed ?? 0);
const error = computed(() => sessionError.value || configStore.error);
const hasAgent = computed(() => configStore.hasAgent);
const messages = computed<ChatMessage[]>(() => acpClient.value?.messages ?? []);
const pendingPermission = computed<PermissionRequest | null>(
  () => acpClient.value?.pendingPermissionRequest ?? null
);
const pendingAuthMethods = computed<AuthMethod[]>(() => acpClient.value?.pendingAuthMethods ?? []);
const availableModes = computed<SessionMode[]>(() => acpClient.value?.availableModes ?? []);
const currentModeId = computed(() => acpClient.value?.currentModeId ?? '');
const availableCommands = computed<SlashCommand[]>(() => acpClient.value?.availableCommands ?? []);
const availableModels = computed<ModelInfo[]>(() => acpClient.value?.availableModels ?? []);
const currentModelId = computed(() => acpClient.value?.currentModelId ?? '');
const trafficEntries = computed<TrafficEntry[]>(() => acpClient.value?.trafficEntries ?? []);
const filteredTrafficEntries = computed<TrafficEntry[]>(
  () => acpClient.value?.filteredTrafficEntries ?? []
);
const isTrafficPaused = computed(() => acpClient.value?.isTrafficPaused ?? false);
const trafficFilter = computed<TrafficFilter>(() => acpClient.value?.trafficFilter ?? 'all');
const trafficSearchQuery = computed(() => acpClient.value?.trafficSearchQuery ?? '');
const agentSessions = computed<AgentSession[]>(() => acpClient.value?.sessions ?? []);

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer || !configStore.config.url.trim()) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectToAgent(true);
  }, delay);
}

onMounted(async () => {
  // Track viewport width so the sidebar can default-collapse into a drawer
  // on phones / narrow windows. We watch a MediaQueryList rather than
  // resize for correctness across orientation changes on iOS.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    narrowMql = window.matchMedia('(max-width: 800px)');
    syncNarrowLayout();
    narrowMql.addEventListener('change', syncNarrowLayout);
    if (isNarrowLayout.value) showSidebar.value = false;
  }

  await configStore.loadConfig();
});

async function ensureClient(): Promise<AcpClient> {
  const url = configStore.config.url.trim();
  if (!url) {
    throw new Error('Agent WebSocket URL is not configured');
  }
  if (acpClient.value && activeAgentUrl === url) {
    return acpClient.value;
  }
  if (acpClient.value && activeAgentUrl !== url) {
    await acpClient.value.disconnect();
  }
  const client = reactive(new AcpClientBridge(url));
  acpClient.value = client;
  activeAgentUrl = url;
  return client;
}

async function connectToAgent(reconnecting: boolean): Promise<void> {
  if (isUnmounting || !configStore.config.url.trim()) {
    return;
  }

  try {
    const client = await ensureClient();
    await client.connectAndRefreshSessions(appVersion, reconnecting);
    reconnectDelayMs = 1000;
    clearReconnectTimer();
  } catch (e) {
    console.warn('Agent connection failed:', e);
    scheduleReconnect();
  }
}

function handleCwdInput(event: Event) {
  selectedCwd.value = (event.target as HTMLInputElement).value;
}

async function handleNewSession() {
  if (!configStore.config.url.trim()) {
    configStore.error = 'Agent WebSocket URL is not configured';
    return;
  }

  // ACP requires an absolute working directory; passing '.' is rejected by
  // the agent may reject relative paths. On desktop the folder picker always returns an absolute
  // path, but on mobile the user types it, so validate up-front and surface
  // a helpful error rather than letting the agent reject `session/new`.
  const cwd = selectedCwd.value.trim();
  if (!cwd) {
    const client = await ensureClient();
    client.sessionError = 'Please enter a working directory (absolute path on the agent\u2019s machine).';
    return;
  }
  const isAbsolute = cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd);
  if (!isAbsolute) {
    const client = await ensureClient();
    client.sessionError = `Working directory must be an absolute path (got: ${cwd}).`;
    return;
  }

  try {
    const client = await ensureClient();
    await client.startNewSession(cwd, appVersion);
  } catch (e) {
    console.error('Failed to create session:', e);
    scheduleReconnect();
  }
}

async function handleResumeSession(session: AgentSession) {
  try {
    const client = await ensureClient();
    await client.loadAgentSession(session, appVersion);
  } catch (e) {
    console.error('Failed to resume session:', e);
    scheduleReconnect();
  }
}

async function handleDeleteSession(sessionId: string) {
  try {
    await acpClient.value?.deleteAgentSession(sessionId);
  } catch (e) {
    console.error('Failed to delete session:', e);
  }
}

async function handleSendPrompt(text: string) {
  if (!acpClient.value) {
    return;
  }

  try {
    const response = await acpClient.value.sendPromptText(text);
    console.log('Prompt completed:', response.stopReason);
    if (messages.value.length === 2 && currentSession.value) {
      currentSession.value.title = text.slice(0, 50) + (text.length > 50 ? '...' : '');
      currentSession.value.updatedAt = new Date().toISOString();
      await acpClient.value.refreshSessions();
    }
  } catch (e) {
    console.error('Failed to send prompt:', e);
  }
}

async function handleModeChange(modeId: string) {
  if (!acpClient.value) return;
  try {
    await acpClient.value.setSessionMode(modeId);
  } catch (e) {
    console.error('Failed to change mode:', e);
  }
}

async function handleModelChange(modelId: string) {
  if (!acpClient.value) return;
  try {
    await acpClient.value.setSessionModel(modelId);
  } catch (e) {
    console.error('Failed to change model:', e);
  }
}

onBeforeUnmount(() => {
  isUnmounting = true;
  if (narrowMql) {
    narrowMql.removeEventListener('change', syncNarrowLayout);
    narrowMql = null;
  }
  clearReconnectTimer();
  void acpClient.value?.disconnect();
});

watch(
  () => configStore.config.url,
  async (url) => {
    clearReconnectTimer();
    reconnectDelayMs = 1000;
    if (acpClient.value) {
      activeAgentUrl = '';
      await acpClient.value.disconnect();
      acpClient.value = null;
    }
    if (url.trim()) {
      await connectToAgent(false);
    }
  },
  { immediate: true }
);

watch(isConnected, (connected, wasConnected) => {
  if (connected) {
    reconnectDelayMs = 1000;
    clearReconnectTimer();
    return;
  }
  if (wasConnected && activeAgentUrl && !isUnmounting) {
    scheduleReconnect();
  }
});
</script>

<template>
  <div class="app-container" :class="{ 'narrow-layout': isNarrowLayout }">
    <!-- Sidebar (slides in as a drawer on narrow viewports) -->
    <aside
      v-show="showSidebar"
      class="sidebar"
      :class="{ 'is-drawer': isNarrowLayout }"
    >
      <div class="sidebar-header">
        <h1>ACP UI</h1>
        <div class="header-actions">
          <button
            class="settings-btn"
            :class="{ active: showTrafficMonitor }"
            @click="showTrafficMonitor = !showTrafficMonitor"
            title="ACP Traffic Monitor"
          >📡</button>
          <button class="settings-btn" @click="showSettings = true" title="Settings">⚙</button>
          <button class="toggle-btn" @click="showSidebar = !showSidebar">◀</button>
        </div>
      </div>

      <div class="sidebar-content">
        <!-- Session setup -->
        <div class="section">
          <!-- Working Directory Picker -->
          <div class="cwd-picker">
            <label>Working Directory:</label>
            <input
              class="cwd-input"
              type="text"
              :value="selectedCwd"
              @input="handleCwdInput"
              :disabled="isConnecting"
              placeholder="/absolute/path/on/agent"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
            />
          </div>

          <button
            v-if="hasAgent && isConnected"
            class="new-session-btn"
            :disabled="isLoading"
            @click="handleNewSession"
          >
            {{ isLoading ? 'Connecting...' : 'New Session' }}
          </button>

          <!-- Startup Progress -->
          <StartupProgress
            v-if="isConnecting"
            :phase="startupPhase"
            :logs="startupLogs"
            :elapsed-seconds="startupElapsed"
            :show-details="showStartupDetails"
            @toggle-details="showStartupDetails = !showStartupDetails"
          />

        </div>

        <!-- Session List -->
        <div class="section">
          <SessionList
            :sessions="agentSessions"
            :can-resume="supportsLoadSession"
            :can-delete="supportsSessionDelete"
            @resume="handleResumeSession"
            @delete="handleDeleteSession"
          />
        </div>
      </div>
    </aside>

    <!-- Backdrop behind the drawer on narrow viewports. Only intercepts
         taps when the layout is narrow; on desktop it's display:none. -->
    <div
      v-show="isNarrowLayout && showSidebar"
      class="drawer-backdrop"
      @click="isNarrowLayout && (showSidebar = false)"
    />

    <!-- Mobile hamburger to open the drawer when collapsed. The desktop
         chevron toggle (`.sidebar-toggle-collapsed`) is hidden on narrow
         viewports via CSS so we don't show two affordances. -->
    <button
      v-show="isNarrowLayout && !showSidebar"
      class="mobile-hamburger"
      @click="showSidebar = true"
      aria-label="Open menu"
    >☰</button>

    <!-- Collapsed sidebar toggle -->
    <button
      v-if="!showSidebar"
      class="sidebar-toggle-collapsed"
      @click="showSidebar = !showSidebar"
    >
      ▶
    </button>

    <!-- Main Content Area -->
    <div class="main-area">
      <main class="main-content">
        <!-- Reconnect banner takes priority over the error banner: while a
             reconnect is in progress we don't want a contradictory red
             "Connection lost" pill. -->
        <div v-if="isReconnecting" class="reconnect-banner">
          <span class="reconnect-spinner" aria-hidden="true"></span>
          <span class="reconnect-text">
            Reconnecting...
          </span>
        </div>

        <!-- Error display (suppressed while reconnecting). -->
        <div v-else-if="error" class="error-banner">
          <span class="error-icon">⚠</span>
          <span class="error-text">{{ error }}</span>
          <button
            class="error-close"
            title="Dismiss"
            @click="() => {
              if (acpClient) acpClient.sessionError = null;
              configStore.error = null;
            }"
          >×</button>
        </div>

        <!-- Chat View when connected -->
        <ChatView
          v-if="hasActiveSession"
          :messages="messages"
          :is-loading="isLoading"
          :is-reconnecting="isReconnecting"
          :current-session="currentSession"
          :available-modes="availableModes"
          :current-mode-id="currentModeId"
          :available-models="availableModels"
          :current-model-id="currentModelId"
          :available-commands="availableCommands"
          @send="handleSendPrompt"
          @cancel="acpClient?.cancelCurrentSession()"
          @mode-change="handleModeChange"
          @model-change="handleModelChange"
        />

        <!-- Welcome screen when not connected -->
        <div v-else class="welcome-screen">
          <h2>Welcome to ACP UI</h2>
          <p v-if="isConnected">Select a session or create a new one to get started.</p>
          <p v-else>Connecting to the configured agent...</p>
          <p v-if="!hasAgent" class="hint">
            Configure the agent WebSocket URL in Settings to begin.
          </p>
        </div>
      </main>

      <!-- Traffic Monitor Panel -->
      <div v-if="showTrafficMonitor" class="traffic-panel">
        <TrafficMonitor
          :entries="trafficEntries"
          :filtered-entries="filteredTrafficEntries"
          :is-paused="isTrafficPaused"
          :filter="trafficFilter"
          :search-query="trafficSearchQuery"
          @toggle-pause="acpClient && (acpClient.isTrafficPaused = !acpClient.isTrafficPaused)"
          @clear="acpClient && (acpClient.trafficEntries = [])"
          @search="(query) => acpClient && (acpClient.trafficSearchQuery = query)"
          @clear-search="acpClient && (acpClient.trafficSearchQuery = '')"
          @filter-change="(filter) => acpClient && (acpClient.trafficFilter = filter)"
          @close="showTrafficMonitor = false"
        />
      </div>
    </div>

    <!-- Permission Dialog -->
    <PermissionDialog
      v-if="pendingPermission"
      :request="pendingPermission"
      @select="(optionId) => acpClient?.resolvePermission(optionId)"
      @cancel="acpClient?.cancelPermission()"
    />

    <!-- Auth Method Dialog -->
    <AuthMethodDialog
      v-if="pendingAuthMethods.length > 0"
      :auth-methods="pendingAuthMethods"
      @select="(methodId) => acpClient?.selectAuthMethod(methodId)"
      @cancel="acpClient?.cancelAuthSelection()"
    />

    <!-- Settings -->
    <SettingsView
      v-if="showSettings"
      @close="showSettings = false"
    />
  </div>
</template>

<style>
:root {
  --bg-primary: #0066cc;
  --bg-primary-hover: #0052a3;
  --bg-sidebar: #f8f9fa;
  --bg-main: #ffffff;
  --bg-hover: #f0f0f0;
  --bg-user: #e3f2fd;
  --bg-assistant: #f5f5f5;
  --bg-code: #282c34;
  --bg-success: #28a745;
  --bg-danger: #dc3545;
  --bg-warning: #fff3cd;
  --text-primary: #333;
  --text-secondary: #666;
  --text-muted: #999;
  --text-accent: #0066cc;
  --text-code: #abb2bf;
  --border-color: #e0e0e0;

  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  color: var(--text-primary);
  background-color: #ffffff;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #4da6ff;
    --bg-primary-hover: #3399ff;
    --bg-sidebar: #1e1e1e;
    --bg-main: #252525;
    --bg-hover: #333;
    --bg-user: #1a3a5c;
    --bg-assistant: #2d2d2d;
    --text-primary: #e0e0e0;
    --text-secondary: #a0a0a0;
    --text-muted: #707070;
    --text-accent: #4da6ff;
    --border-color: #404040;
    background-color: #252525;
  }
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body, #app {
  height: 100%;
}
</style>

<style scoped>
.app-container {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.sidebar {
  width: 320px;
  min-width: 320px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem;
  border-bottom: 1px solid var(--border-color);
}

.sidebar-header h1 {
  font-size: 1.25rem;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 0.25rem;
}

.settings-btn,
.toggle-btn {
  padding: 0.25rem 0.5rem;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--text-muted);
}

.settings-btn:hover,
.toggle-btn:hover {
  color: var(--text-primary);
}

.settings-btn.active {
  color: var(--text-accent);
  background: var(--bg-hover);
  border-radius: 4px;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
}

.section {
  padding: 1rem;
  border-bottom: 1px solid var(--border-color);
}

.new-session-btn {
  width: 100%;
  margin-top: 0.75rem;
  padding: 0.625rem 1rem;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
}

.new-session-btn {
  background: var(--bg-primary);
  color: white;
}

.new-session-btn:hover:not(:disabled) {
  background: var(--bg-primary-hover);
}

.new-session-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cwd-picker {
  margin-top: 0.75rem;
}

.cwd-picker label {
  display: block;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 0.25rem;
}

/* Browser free-text cwd input. */
.cwd-input {
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 16px; /* 16px = no iOS auto-zoom */
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.cwd-input:disabled {
  opacity: 0.5;
}

.sidebar-toggle-collapsed {
  position: fixed;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  padding: 0.5rem;
  border: 1px solid var(--border-color);
  border-left: none;
  border-radius: 0 4px 4px 0;
  background: var(--bg-sidebar);
  cursor: pointer;
}

.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-main);
}

.traffic-panel {
  flex-shrink: 0;
  border-top: 2px solid var(--border-color);
}

.error-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: #fee;
  color: #c00;
  border-bottom: 1px solid #fcc;
}

.error-icon {
  flex-shrink: 0;
}

.error-text {
  flex: 1;
}

.error-close {
  flex-shrink: 0;
  padding: 0.25rem 0.5rem;
  border: none;
  background: transparent;
  color: #c00;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.6;
  border-radius: 4px;
}

.error-close:hover {
  opacity: 1;
  background: rgba(204, 0, 0, 0.1);
}

/* Foreground-reconnect banner. Distinct visual style from the red error
   banner so users immediately read it as transient progress, not failure. */
.reconnect-banner {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.75rem 1rem;
  background: #e0f2fe;
  color: #0369a1;
  border-bottom: 1px solid #bae6fd;
}

.reconnect-text {
  flex: 1;
  font-size: 0.9rem;
}

.reconnect-text strong {
  font-weight: 600;
}

.reconnect-spinner {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: reconnect-spin 0.9s linear infinite;
}

@keyframes reconnect-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-color-scheme: dark) {
  .reconnect-banner {
    background: #082f49;
    color: #7dd3fc;
    border-bottom-color: #0c4a6e;
  }
}

.welcome-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 2rem;
  color: var(--text-secondary);
}

.welcome-screen h2 {
  margin-bottom: 0.5rem;
  color: var(--text-primary);
}

.welcome-screen .hint {
  margin-top: 1rem;
  font-size: 0.875rem;
  color: var(--text-muted);
}

/* ---------- Mobile / narrow-viewport layout ---------- */

.drawer-backdrop {
  display: none;
}

.mobile-hamburger {
  display: none;
}

@media (max-width: 800px) {
  .app-container {
    /* Prevent the off-screen drawer from causing horizontal scroll. */
    overflow-x: hidden;
  }

  /* Banners sit at the very top of the main area, where the OS status bar
     / camera notch overlap on phones. Extend the banner colour through the
     safe-area inset and push the text below it so the status bar reads as
     a tinted continuation of the banner instead of clipping its content. */
  .reconnect-banner,
  .error-banner {
    padding-top: calc(0.75rem + env(safe-area-inset-top, 0));
  }

  .sidebar.is-drawer {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 85vw;
    max-width: 360px;
    z-index: 100;
    box-shadow: 2px 0 16px rgba(0, 0, 0, 0.3);
    /* Honour iOS notch / Android status bar. */
    padding-top: env(safe-area-inset-top, 0);
  }

  .drawer-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 90;
  }

  /* Hide the desktop chevron when the mobile hamburger is in play. */
  .sidebar-toggle-collapsed {
    display: none;
  }

  .mobile-hamburger {
    display: flex;
    align-items: center;
    justify-content: center;
    position: fixed;
    top: calc(env(safe-area-inset-top, 0) + 0.5rem);
    left: 0.5rem;
    z-index: 50;
    width: 44px;
    height: 44px;
    padding: 0;
    background: var(--bg-sidebar);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    font-size: 1.25rem;
    cursor: pointer;
    color: var(--text-primary);
  }

  /* Tap-target sizing for the icon buttons inside the sidebar header. */
  .settings-btn,
  .toggle-btn {
    min-width: 40px;
    min-height: 40px;
    font-size: 1rem;
  }

  /* Honour the iOS home indicator at the bottom of the main area. */
  .main-area {
    padding-bottom: env(safe-area-inset-bottom, 0);
  }
}
</style>
