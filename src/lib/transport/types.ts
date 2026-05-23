// AcpTransport abstracts how a single ACP JSON-RPC stream is carried.

/** Unsubscribe function returned by `onMessage` / `onClose`. */
export type Unsubscribe = () => void;

export interface AcpTransport {
  /** Send a single JSON-RPC frame that is already JSON-encoded. */
  send(json: string): Promise<void>;

  /** Register a listener for complete inbound JSON-RPC frames. */
  onMessage(cb: (json: string) => void): Unsubscribe;

  /** Register a listener that fires once when the transport closes. */
  onClose(cb: (reason?: string) => void): Unsubscribe;

  /** Tear down the transport and release all resources. Idempotent. */
  close(): Promise<void>;
}

/** Lightweight emitter helper shared by transport implementations. */
export class TransportListeners<T> {
  private callbacks = new Set<(value: T) => void>();

  add(cb: (value: T) => void): Unsubscribe {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  emit(value: T): void {
    for (const cb of [...this.callbacks]) {
      try {
        cb(value);
      } catch (e) {
        console.error('Transport listener threw:', e);
      }
    }
  }

  clear(): void {
    this.callbacks.clear();
  }
}
