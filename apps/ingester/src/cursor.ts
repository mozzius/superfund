import type { Redis } from "./redis.ts";

const CURSOR_KEY = "ingester:cursor";
const FLUSH_INTERVAL_MS = 2000;

export function createCursorStore(redis: Redis) {
  let latest: number | undefined;
  let lastFlushed: number | undefined;

  const flush = async () => {
    if (latest === undefined || latest === lastFlushed) return;
    const toWrite = latest;
    await redis.set(CURSOR_KEY, String(toWrite));
    lastFlushed = toWrite;
  };

  const interval = setInterval(() => {
    void flush().catch((err) => console.error("cursor flush failed", err));
  }, FLUSH_INTERVAL_MS);
  interval.unref();

  return {
    async load(): Promise<number | undefined> {
      const raw = await redis.get(CURSOR_KEY);
      if (!raw) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    },
    update(cursor: number) {
      latest = cursor;
    },
    async flush() {
      clearInterval(interval);
      await flush();
    },
  };
}
