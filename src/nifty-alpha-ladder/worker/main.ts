/**
 * Nifty Alpha Ladder market-stream worker — host-agnostic entrypoint.
 * `npm run alpha-ladder:worker`. Every configuration value comes from
 * environment variables; nothing here assumes Railway, Vercel, or any
 * other specific host. Per the Milestone 3 instructions, this file is NOT
 * deployed anywhere yet (Railway provisioning is PENDING_HOSTING_DECISION)
 * and has NOT been run end-to-end against a live Kite session in this
 * session — see NIFTY_ALPHA_LADDER_MILESTONE3_SHADOW_REPORT.md's "BUILT +
 * NOT LIVE-VERIFIED" section.
 *
 * Required environment variables:
 *   KITE_API_KEY, KITE_ACCESS_TOKEN  — same Kite credentials Options
 *     Auto-Trader already uses, read here directly from env (this worker
 *     is a separate process with no access to Vercel's own env, so the
 *     access token must be supplied to it independently — e.g. synced
 *     from the same kite_session table Options Auto-Trader already
 *     maintains, by whatever process ends up owning that sync; not
 *     decided in this milestone).
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — the same Supabase project,
 *     writing only to alpha_ladder_* tables.
 *
 * Zero broker-order capability — see mode-safety test, which statically
 * proves no order-mutation reference exists anywhere in this module tree.
 */
import { createClient } from '@supabase/supabase-js';
import { KiteAlphaLadderDepthSource } from '../live/kiteDepthSource.ts';
import { toDepthLevelObservation, type NormalizedDepthTick } from '../live/depthSource.ts';
import { createSessionAccumulator, ingest, evaluateCurrentSignal, type SessionAccumulatorState } from '../live/sessionAccumulator.ts';
import { deriveHealthStatus, deriveSessionQuality, canFireNewSignal } from '../live/connectionSupervisor.ts';
import { createSupabaseAlphaLadderStore } from '../persistence/store.ts';
import { isTradingDay, isSignalWeekday, isWithinSignalWindow, SIGNAL_CUTOFF_MIN } from '../calendar/signalCalendar.ts';

const WORKER_INSTANCE = process.env.WORKER_INSTANCE ?? `alpha-ladder-worker-${Date.now()}`;
const EVALUATION_POLL_MS = 60_000; // once per signal-lattice minute — the lattice itself is minute-granular (spec Definition 2.1), polling faster would not change the answer

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

async function main() {
  const apiKey = requiredEnv('KITE_API_KEY');
  const accessToken = requiredEnv('KITE_ACCESS_TOKEN');
  const supabaseUrl = requiredEnv('SUPABASE_URL');
  const supabaseKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

  const supabase = createClient(supabaseUrl, supabaseKey);
  const store = createSupabaseAlphaLadderStore(supabase);

  // 'ws' is a worker-only dependency (never bundled into the Vite
  // frontend) — dynamically imported so this file can still be
  // typechecked/imported by tests without it being resolvable there.
  const { default: WebSocket } = await import('ws');

  const depthSource = new KiteAlphaLadderDepthSource({
    apiKey,
    accessToken,
    wsFactory: (url) => new WebSocket(url) as any,
  });

  // Session origin: 09:15 IST today, in epoch ms — the same t=0 both G1's
  // minute grid and G2's aggregation grid are measured against (see
  // signal/signedArea.ts's own comment on the two grids being otherwise
  // unrelated). Real IST-vs-server-local-timezone handling is a known
  // open item — see the Milestone 3 report's timezone caveat.
  const today = new Date();
  const IST_OFFSET_MIN = 5 * 60 + 30;
  const marketOpenMinutesIST = 9 * 60 + 15;
  const marketOpenMinutesUTC = marketOpenMinutesIST - IST_OFFSET_MIN; // 09:15 IST = 03:45 UTC
  const sessionOriginMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, marketOpenMinutesUTC);
  let accumulator: SessionAccumulatorState | null = createSessionAccumulator(sessionOriginMs);
  let lastSocketMessageAtMs: number | null = null;

  depthSource.onDepthSnapshot((ticks: NormalizedDepthTick[]) => {
    lastSocketMessageAtMs = Date.now();
    if (!accumulator) return; // not yet resolved/subscribed for today's session
    const observations = [];
    for (const t of ticks) {
      try {
        observations.push(toDepthLevelObservation(t));
      } catch (err: any) {
        // Capability mismatch (no order-count field) — logged, never
        // silently defaulted (see depthSource.ts's own header).
        store.logActivity('error', 'Depth tick capability mismatch — order count unavailable, skipping level.', { message: err.message });
      }
    }
    ingest(accumulator, observations, Date.now());
  });

  await depthSource.connect();
  await store.insertWorkerHealth({
    workerInstance: WORKER_INSTANCE, connectionGeneration: depthSource.getHealth().connectionGeneration,
    status: 'STARTING', workerStartedAt: new Date().toISOString(), reconnectCount: 0,
  });

  setInterval(async () => {
    const now = new Date();
    const isMarketHours = isTradingDay(now, () => false); // TODO: real NSE holiday calendar — see capability report's own open item
    const health = deriveHealthStatus({
      nowMs: Date.now(), lastSocketMessageAtMs, isMarketHours,
      isWarmedUp: depthSource.getHealth().status === 'HEALTHY', hasUnrecoverableGapThisWeek: false, // TODO: real gap tracking
    });
    const quality = deriveSessionQuality(health, false);

    await store.insertWorkerHealth({
      workerInstance: WORKER_INSTANCE, connectionGeneration: depthSource.getHealth().connectionGeneration,
      status: health, workerStartedAt: new Date().toISOString(), reconnectCount: depthSource.getHealth().reconnectCount,
    });

    const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes(); // NOTE: IST conversion not yet wired in — see report's timezone caveat
    if (!isWithinSignalWindow(nowMinutes) || !canFireNewSignal(quality) || !accumulator) return;

    const decision = evaluateCurrentSignal(accumulator, (Date.now() - accumulator.sessionOriginMs) / 1000, SIGNAL_CUTOFF_MIN * 60, { value: null, available: false });
    if (decision.fired) {
      await store.logActivity('info', `Signal fired: direction=${decision.finalDirection}, path=${decision.path}`, decision);
      // Structure resolution / call publication / entry simulation wiring
      // is NOT yet connected to this loop — see the Milestone 3 report's
      // "BUILT + NOT LIVE-VERIFIED" section.
    }
  }, EVALUATION_POLL_MS);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('alpha-ladder worker failed to start:', err.message);
  process.exit(1);
});
