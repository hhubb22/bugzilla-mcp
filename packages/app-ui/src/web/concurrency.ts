/**
 * Unified concurrency gate for MCP App `app.callServerTool()` calls:
 * Antigravity enforces at most 4 in-flight calls per view.
 * Reserves 3 read slots + 1 serial high-priority write/draft slot (total <= 4),
 * and tags every request with a generation token so stale responses are discarded.
 */
export interface RpcGate {
  runRead<T>(generation: number, fn: () => Promise<T>): Promise<{ stale: boolean; value?: T }>;
  runWrite<T>(generation: number, fn: () => Promise<T>): Promise<{ stale: boolean; value?: T }>;
  bumpGeneration(): number;
  currentGeneration(): number;
  inFlightCount(): number;
}

export function createRpcGate(): RpcGate {
  let generation = 1;
  let activeReads = 0;
  let activeWrites = 0;
  const readWaiters: Array<() => void> = [];
  const writeWaiters: Array<() => void> = [];

  async function acquireRead(): Promise<void> {
    if (activeReads < 3) {
      activeReads += 1;
      return;
    }
    // Slot ownership is transferred directly by releaseRead without decrementing activeReads (UI-01)
    await new Promise<void>((resolve) => {
      readWaiters.push(resolve);
    });
  }

  function releaseRead(): void {
    const next = readWaiters.shift();
    if (next) {
      next();
      return;
    }
    activeReads -= 1;
  }

  async function acquireWrite(): Promise<void> {
    if (activeWrites < 1) {
      activeWrites += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      writeWaiters.push(resolve);
    });
  }

  function releaseWrite(): void {
    const next = writeWaiters.shift();
    if (next) {
      next();
      return;
    }
    activeWrites -= 1;
  }

  return {
    async runRead<T>(gen: number, fn: () => Promise<T>) {
      await acquireRead();
      try {
        if (gen !== generation) return { stale: true };
        const value = await fn();
        if (gen !== generation) return { stale: true };
        return { stale: false, value };
      } finally {
        releaseRead();
      }
    },

    async runWrite<T>(gen: number, fn: () => Promise<T>) {
      await acquireWrite();
      try {
        if (gen !== generation) return { stale: true };
        const value = await fn();
        if (gen !== generation) return { stale: true };
        return { stale: false, value };
      } finally {
        releaseWrite();
      }
    },

    bumpGeneration() {
      generation += 1;
      return generation;
    },

    currentGeneration() {
      return generation;
    },

    inFlightCount() {
      return activeReads + activeWrites;
    },
  };
}
