/**
 * A sliding-window limit per caller, held in memory.
 *
 * On Vercel an instance serves many requests, so this slows down one noisy
 * caller, but each instance counts on its own and a cold start forgets. It is
 * a speed bump. The hard ceiling on spend is the AI Gateway budget.
 */
export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Past this many callers, ones with nothing left in the window are dropped. */
  maxCallers?: number;
}

export interface RateLimiter {
  (caller: string): boolean;
  size(): number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs, now = () => Date.now(), maxCallers = 5000 } = options;
  const asks = new Map<string, number[]>();

  const allow = ((caller: string): boolean => {
    const t = now();
    if (asks.size >= maxCallers) {
      for (const [key, times] of asks) {
        if (times.every((at) => t - at >= windowMs)) asks.delete(key);
      }
    }
    const recent = (asks.get(caller) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= limit) {
      asks.set(caller, recent);
      return false;
    }
    recent.push(t);
    asks.set(caller, recent);
    return true;
  }) as RateLimiter;
  allow.size = () => asks.size;
  return allow;
}
