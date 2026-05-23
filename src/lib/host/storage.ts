// Minimal browser-backed KV-store shim.

export interface KVStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

class WebKVStore implements KVStore {
  private readonly storageKey: string;
  private data: Record<string, unknown>;

  constructor(name: string) {
    this.storageKey = `acp-ui:${name}`;
    this.data = {};
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        try {
          this.data = JSON.parse(raw) ?? {};
        } catch (e) {
          console.warn(`Failed to parse ${this.storageKey} from localStorage:`, e);
          this.data = {};
        }
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const v = this.data[key];
    return v === undefined ? null : (v as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data[key] = value;
  }

  async save(): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.data));
    } catch (e) {
      console.warn(`Failed to persist ${this.storageKey} to localStorage:`, e);
    }
  }
}

/** Open or create a persistent browser KV store. */
export async function loadKvStore(name: string): Promise<KVStore> {
  return new WebKVStore(name);
}
