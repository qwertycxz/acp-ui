// Agent configuration store
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { AgentConfig } from '../lib/types';
import { getConfig } from '../lib/host';

export const useConfigStore = defineStore('config', () => {
  const config = ref<AgentConfig>({ url: '' });
  const loading = ref(false);
  const error = ref<string | null>(null);

  const hasAgent = computed(() => config.value.url.trim().length > 0);

  async function loadConfig() {
    loading.value = true;
    error.value = null;
    try {
      config.value = await getConfig();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  function updateFromEvent(newConfig: AgentConfig) {
    config.value = newConfig;
  }

  return {
    config,
    loading,
    error,
    hasAgent,
    loadConfig,
    updateFromEvent,
  };
});
