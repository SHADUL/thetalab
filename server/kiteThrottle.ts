/**
 * Process-wide pacing for Kite Connect REST calls.
 *
 * On Vercel every cron hit ran in its own function instance; on the VM they
 * all share ONE process and ONE api_key, and the per-minute burst (paper-scan
 * × symbols, position-monitor, vwap-scalper, dashboard) blew through Kite's
 * documented limits (quote: 1 req/s, historical: 3 req/s, rest: 10 req/s),
 * so Kite answered "Too many requests" and AUTO refused every entry because
 * broker reconciliation could not be fetched.
 *
 * Scope is deliberately narrow: only GET requests to api.kite.trade are paced
 * and retried. Order placement/modification/cancel (POST/PUT/DELETE) passes
 * straight through, unchanged, never delayed and never retried.
 */
export type Lane = 'quote' | 'historical' | 'other';

const KITE_HOST = 'api.kite.trade';

export const DEFAULT_SPACING_MS: Record<Lane, number> = { quote: 1_100, historical: 350, other: 120 };

function urlOf(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return null;
}

function methodOf(input: unknown, init?: { method?: string }): string {
  const m = init?.method ?? (input && typeof input === 'object' && 'method' in input ? String((input as { method: unknown }).method) : 'GET');
  return m.toUpperCase();
}

/** Which pacing lane a request belongs to, or null if it must pass through untouched. */
export function laneFor(input: unknown, init?: { method?: string }): Lane | null {
  const raw = urlOf(input);
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.hostname !== KITE_HOST) return null;
  if (methodOf(input, init) !== 'GET') return null;
  if (u.pathname.startsWith('/quote')) return 'quote';
  if (u.pathname.startsWith('/instruments/historical')) return 'historical';
  return 'other';
}

export interface ThrottleOptions {
  spacingMs?: Partial<Record<Lane, number>>;
  /** Extra attempts after a 429 (GET only). */
  retries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (e: { kind: 'retry' | 'slow'; lane: Lane; path: string; waitMs?: number; attempt?: number }) => void;
}

export function createKiteThrottledFetch(base: typeof fetch, opts: ThrottleOptions = {}): typeof fetch {
  const spacing = { ...DEFAULT_SPACING_MS, ...opts.spacingMs };
  const retries = opts.retries ?? 2;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nextAt: Record<Lane, number> = { quote: 0, historical: 0, other: 0 };
  const lastSent: Record<Lane, number> = { quote: -Infinity, historical: -Infinity, other: -Infinity };

  /** Reserve the next slot synchronously (so concurrent callers queue in call order), then wait for it. */
  const acquire = async (lane: Lane, minDelay = 0): Promise<number> => {
    const t = now();
    const at = Math.max(t + minDelay, nextAt[lane]);
    nextAt[lane] = at + spacing[lane];
    let wait = Math.max(0, at - t);
    if (wait > 0) await sleep(wait);
    // Timers can fire late and together when the event loop is busy; enforce
    // the gap against the ACTUAL previous send, not just the reserved slot.
    for (;;) {
      const gap = now() - lastSent[lane];
      if (gap >= spacing[lane]) break;
      const extra = spacing[lane] - gap;
      wait += extra;
      await sleep(extra);
    }
    lastSent[lane] = now();
    return wait;
  };

  const throttled = async (input: any, init?: any): Promise<Response> => {
    const lane = laneFor(input, init);
    if (!lane) return base(input, init);
    const path = (() => { try { return new URL(urlOf(input)!).pathname; } catch { return '?'; } })();
    let attempt = 0;
    let waited = await acquire(lane);
    if (waited > 5_000) opts.onEvent?.({ kind: 'slow', lane, path, waitMs: waited });
    for (;;) {
      const resp = await base(input, init);
      if (resp.status !== 429 || attempt >= retries) return resp;
      attempt++;
      opts.onEvent?.({ kind: 'retry', lane, path, attempt });
      // Back off a full second beyond the lane spacing before the retry slot.
      waited = await acquire(lane, 1_000);
    }
  };
  return throttled as typeof fetch;
}

let installed = false;
/** Wrap globalThis.fetch once for this process. */
export function installKiteThrottle(): void {
  if (installed) return;
  installed = true;
  globalThis.fetch = createKiteThrottledFetch(globalThis.fetch.bind(globalThis), {
    onEvent: (e) => console.warn(`[kite-throttle] ${e.kind} ${e.lane} ${e.path}${e.waitMs ? ` waited ${e.waitMs}ms` : ''}${e.attempt ? ` attempt ${e.attempt}` : ''}`),
  });
}
