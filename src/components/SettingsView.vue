<script setup lang="ts">
import { ref, watch } from 'vue';
import { useConfigStore } from '../stores/config';
import { saveConfig } from '../lib/host';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const configStore = useConfigStore();
const url = ref(configStore.config.url);
const formError = ref('');
const isSubmitting = ref(false);

watch(
  () => configStore.config.url,
  (newUrl) => {
    url.value = newUrl;
  }
);

async function handleSubmit() {
  formError.value = '';

  const trimmedUrl = url.value.trim();
  if (!trimmedUrl) {
    formError.value = 'URL is required';
    return;
  }
  if (!/^(ws|wss):\/\//i.test(trimmedUrl)) {
    formError.value = 'WebSocket URL must start with ws:// or wss://';
    return;
  }

  isSubmitting.value = true;

  try {
    configStore.updateFromEvent(await saveConfig(trimmedUrl));
    emit('close');
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isSubmitting.value = false;
  }
}
</script>

<template>
  <div class="settings-overlay" @click.self="emit('close')">
    <div class="settings-panel">
      <div class="settings-header">
        <h2>Settings</h2>
        <button class="close-btn" @click="emit('close')">✕</button>
      </div>

      <div class="settings-content">
        <section>
          <h3>Agent</h3>

          <div class="form-group">
            <label>WebSocket URL</label>
            <input
              v-model="url"
              type="text"
              placeholder="wss://acp.example.com/v1"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
            />
            <small>WebSocket endpoint (ws:// or wss://)</small>
          </div>

          <div v-if="formError" class="form-error">
            {{ formError }}
          </div>

          <div class="form-actions">
            <button
              class="save-btn"
              @click="handleSubmit"
              :disabled="isSubmitting"
            >
              {{ isSubmitting ? 'Saving...' : 'Save' }}
            </button>
            <button class="cancel-btn" @click="emit('close')">
              Cancel
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.settings-panel {
  background: var(--bg-main);
  border-radius: 8px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
}

.settings-header h2 {
  margin: 0;
  font-size: 1.25rem;
}

.close-btn {
  border: none;
  background: transparent;
  font-size: 1.25rem;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 0.25rem;
}

.close-btn:hover {
  color: var(--text-primary);
}

.settings-content {
  padding: 1.25rem;
  overflow-y: auto;
}

h3 {
  margin: 0 0 1rem 0;
}

.form-group {
  margin-bottom: 0.75rem;
}

.form-group label {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.form-group input {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 0.9rem;
  background: var(--bg-main);
  color: var(--text-primary);
}

.form-group input:focus {
  outline: none;
  border-color: var(--bg-primary);
}

.form-group small {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.form-error {
  color: var(--bg-danger);
  font-size: 0.875rem;
  margin-bottom: 0.75rem;
}

.form-actions {
  display: flex;
  gap: 0.5rem;
}

.save-btn {
  padding: 0.5rem 1rem;
  background: var(--bg-primary);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.save-btn:hover:not(:disabled) {
  background: var(--bg-primary-hover);
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cancel-btn {
  padding: 0.5rem 1rem;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
}

.cancel-btn:hover {
  background: var(--bg-hover);
}
</style>
