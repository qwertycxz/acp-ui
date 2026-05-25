// Agent configuration store
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { AgentsConfig } from '../lib/types';
import { getConfig } from '../lib/host';

export const useConfigStore = defineStore('config', () => {
  const config = ref<AgentsConfig>({ agents: {} });
  const loading = ref(false);
  const error = ref<string | null>(null);

  const agentNames = computed(() => Object.keys(config.value.agents));
  const hasAgents = computed(() => agentNames.value.length > 0);

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

  function getAgent(name: string): string | undefined {
    return config.value.agents[name];
  }

  function updateFromEvent(newConfig: AgentsConfig) {
    config.value = newConfig;
  }

  function clearError() {
    error.value = null;
  }

  function setError(message: string) {
    error.value = message;
  }

  return {
    config,
    loading,
    error,
    agentNames,
    hasAgents,
    loadConfig,
    getAgent,
    updateFromEvent,
    clearError,
    setError,
  };
});
