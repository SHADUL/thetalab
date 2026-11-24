/**
 * LIVE ORDERS — shared server context (one broker, store and runner per strategy).
 * Created lazily; null when Supabase / Kite are not configured. Real orders
 * additionally need LIVE_ORDERS=on and the strategy ARMED by the owner.
 */
import { createClient } from '@supabase/supabase-js';
import { LiveOrderRunner, type BrokerPort, type LivePosition, type LiveStorePort, type Strategy } from '../../src/live-orders/runner.ts';
import { defaultControl, type LiveControlPort, type LiveControlState } from '../../src/live-orders/control.ts';
import { KiteBroker, liveOrdersOn } from './kiteBroker.ts';
import { SupabaseLiveStore, controlPort } from './store.ts';

export interface LiveCtx {
  broker: BrokerPort & Pick<KiteBroker, 'availableCash' | 'orderMargin'>;
  store: LiveStorePort & { recent(s: Strategy, limit: number): Promise<LivePosition[]>; migration: boolean | null };
  control: LiveControlPort;
  runner(s: Strategy): LiveOrderRunner;
  /** Cached control (refreshed in the background every 15 s); defaults to disarmed. */
  cached(s: Strategy): LiveControlState;
  refresh(s: Strategy): Promise<LiveControlState>;
}

let ctx: LiveCtx | null | undefined;
const log = (m: string) => console.log(m);

export function getLive(): LiveCtx | null {
  if (ctx !== undefined) return ctx;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY, apiKey = process.env.KITE_API_KEY;
  if (!url || !key || !apiKey) { ctx = null; return ctx; }
  const sb = createClient(url, key, { auth: { persistSession: false }, global: { fetch: (i: any, init?: any) => fetch(i, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }) } });
  let tok: { v: string | null; at: number } = { v: null, at: 0 };
  const token = async () => {
    if (Date.now() - tok.at < 15_000 && tok.v) return tok.v;
    const { data } = await sb.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
    tok = { v: (data as { access_token?: string } | null)?.access_token ?? null, at: Date.now() };
    return tok.v;
  };
  const broker = new KiteBroker(apiKey, token);
  const store = new SupabaseLiveStore(sb);
  const control = controlPort(store);
  const runners = new Map<Strategy, LiveOrderRunner>();
  const cache = new Map<Strategy, { v: LiveControlState; at: number; busy: boolean }>();
  const refresh = async (s: Strategy) => {
    const v = await control.load(s);
    cache.set(s, { v, at: Date.now(), busy: false });
    return v;
  };
  ctx = {
    broker, store, control,
    runner(s) {
      let r = runners.get(s);
      if (!r) { r = new LiveOrderRunner(s, { broker, store, log }); runners.set(s, r); }
      return r;
    },
    cached(s) {
      const c = cache.get(s);
      if (!c || (Date.now() - c.at > 15_000 && !c.busy)) {
        if (c) c.busy = true; else cache.set(s, { v: defaultControl(s), at: 0, busy: true });
        refresh(s).catch(() => { const x = cache.get(s); if (x) { x.busy = false; x.at = Date.now(); } });
      }
      return cache.get(s)!.v;
    },
    refresh,
  };
  return ctx;
}

/** Tests only: replace the context (fake broker + memory store). */
export function __setLiveForTests(c: LiveCtx | null | undefined) { ctx = c; }

/** Server switch for real orders: LIVE_ORDERS=on and the broker is configured. */
export function liveEnabled(): boolean { return liveOrdersOn() && !!getLive(); }
