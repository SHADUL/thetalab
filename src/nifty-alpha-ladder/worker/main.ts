/**
 * Nifty Alpha Ladder market-stream worker — host-agnostic entrypoint.
 * `npm run alpha-ladder:worker`. Every configuration value comes from
 * environment variables; nothing here assumes Railway, Vercel, or any
 * other specific host — ready for immediate Railway deployment the moment
 * hosting is resolved (Railway is PENDING_HOSTING_DECISION as of this
 * writing). Has NOT been run end-to-end against a live Kite session in
 * this session — see NIFTY_ALPHA_LADDER_MILESTONE3_SHADOW_REPORT.md's
 * "BUILT + NOT LIVE-VERIFIED" section; this file's own logic is real, its
 * live connectivity is not yet observed.
 *
 * Required environment variables:
 *   KITE_API_KEY, KITE_ACCESS_TOKEN — same Kite credentials Options
 *     Auto-Trader already uses. This worker is a separate process with no
 *     access to Vercel's own env, so the access token must be supplied to
 *     it independently.
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — the same Supabase project,
 *     writing only to alpha_ladder_* tables.
 * Optional:
 *   WORKER_INSTANCE — a stable identifier for this process (defaults to a
 *     timestamp-based one).
 *
 * Never prints any of the above — only their presence/absence, never
 * their values.
 *
 * SHADOW ONLY, always. Zero broker-order capability: the static
 * mode-safety test proves no order-mutation reference exists anywhere in
 * this module tree; `execution/shadowSafetyGuard.ts`'s runtime guard is
 * the second, independent layer, ready for any future code path that
 * would ever attempt one.
 */
import { createClient } from '@supabase/supabase-js';
import { KiteAlphaLadderDepthSource } from '../live/kiteDepthSource.ts';
import { toDepthLevelObservation, type NormalizedDepthTick } from '../live/depthSource.ts';
import { createSessionAccumulator, ingest, evaluateCurrentSignal, serializeCheckpoint, restoreOrStartFresh, type SessionAccumulatorState } from '../live/sessionAccumulator.ts';
import { deriveHealthStatus, deriveSessionQuality, canFireNewSignal } from '../live/connectionSupervisor.ts';
import { createSupabaseAlphaLadderStore } from '../persistence/store.ts';
import { isTradingDay, isSignalWeekday } from '../calendar/signalCalendar.ts';
import { nowIST, isWithinSignalWindow, isMarketOpen, MARKET_OPEN_MIN, SIGNAL_CUTOFF_MIN } from '../calendar/istClock.ts';
import { fetchNfoInstrumentsCsv, parseNfoFutures, resolveNearestFuture } from '../live/futuresResolver.ts';

/** Seconds from session origin (09:15 IST) to the 14:30 IST cutoff — a fixed constant every day, since both are IST clock times measured from the same origin. */
const CUTOFF_SEC_FROM_ORIGIN = (SIGNAL_CUTOFF_MIN - MARKET_OPEN_MIN) * 60;

const WORKER_INSTANCE = process.env.WORKER_INSTANCE ?? `alpha-ladder-worker-${Date.now()}`;
const EVALUATION_POLL_MS = 60_000; // once per signal-lattice minute — the lattice itself is minute-granular (spec Definition 2.1), polling faster would not change the answer
const CHECKPOINT_SAVE_MS = 30_000; // frequent enough that a restart never loses more than ~30s of the current bucket
const MAX_RECOVERABLE_GAP_MS = 5 * 60_000; // a downtime longer than this is a genuine feed gap, not a clean resume — see restoreOrStartFresh

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

/** 09:15 IST of `dateISO` ("YYYY-MM-DD"), in epoch ms — the shared t=0 for both G1's and G2's grids. */
function sessionOriginMsFor(dateISO: string): number {
  const [y, m, d] = dateISO.split('-').map(Number);
  const IST_OFFSET_MIN = 5 * 60 + 30;
  const marketOpenMinutesUTC = MARKET_OPEN_MIN - IST_OFFSET_MIN;
  return Date.UTC(y, m - 1, d, 0, marketOpenMinutesUTC);
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

  const todayIST = nowIST().dateISO;
  const sessionOriginMs = sessionOriginMsFor(todayIST);

  // Partial-bucket recovery: resume from today's checkpoint if one
  // exists, rather than starting cold and silently losing the in-progress
  // theta3/theta4 windows. A downtime longer than MAX_RECOVERABLE_GAP_MS
  // is flagged as a genuine feed gap (never silently treated as clean).
  const existingCheckpoint = await store.loadAccumulatorCheckpoint(todayIST);
  const restoreDecision = restoreOrStartFresh(existingCheckpoint, sessionOriginMs, Date.now(), MAX_RECOVERABLE_GAP_MS);
  let accumulator: SessionAccumulatorState | null = restoreDecision.state;
  let hasUnrecoverableGapToday = restoreDecision.gapDetected;
  if (restoreDecision.gapDetected) {
    await store.logActivity('error', `Feed gap of ${Math.round(restoreDecision.gapDurationMs / 1000)}s detected on restart — today's session marked INVALID_FOR_NEW_SIGNAL. No observations were fabricated to fill it.`);
  } else if (existingCheckpoint) {
    await store.logActivity('info', 'Resumed from checkpoint — partial G2 bucket and reference-threshold state restored, not lost.');
  }

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

  // NIFTY_NEAREST_FUTURE resolution (spec §2's chosen provider) — resolved
  // BEFORE connecting, not after: the NFO instrument dump is a multi-
  // megabyte CSV (36k+ rows), and parsing it synchronously right after the
  // socket's 'open' event fires risked blocking the event loop long enough
  // for Kite to time out waiting for a ping/pong and close the connection
  // — a plausible explanation for the repeated near-immediate disconnects
  // seen on this milestone's first real Railway deployment. Resolving
  // first means connect() has nothing heavy to do once the socket is open
  // except send the two short subscribe/mode frames.
  const nfoCsv = await fetchNfoInstrumentsCsv(apiKey, accessToken);
  const resolvedFuture = resolveNearestFuture(parseNfoFutures(nfoCsv), 'NIFTY', todayIST);
  if (!resolvedFuture) {
    throw new Error(`No non-expired NIFTY future found in Kite's instrument dump as of ${todayIST} — refusing to start with no instrument to subscribe.`);
  }

  await depthSource.connect();
  await depthSource.subscribe({
    tradingsymbol: resolvedFuture.tradingsymbol, instrumentToken: resolvedFuture.instrumentToken, expiry: resolvedFuture.expiry,
  });
  await store.logActivity('info', `Resolved and subscribed to nearest NIFTY future: ${resolvedFuture.tradingsymbol} (token ${resolvedFuture.instrumentToken}, expiry ${resolvedFuture.expiry}).`);

  await store.insertWorkerHealth({
    workerInstance: WORKER_INSTANCE, connectionGeneration: depthSource.getHealth().connectionGeneration,
    status: 'STARTING', workerStartedAt: new Date().toISOString(), reconnectCount: 0,
    currentInstrumentToken: resolvedFuture.instrumentToken, currentFutureSymbol: resolvedFuture.tradingsymbol,
  });

  // Persist the checkpoint on a fixed cadence — never only on clean
  // shutdown, since a real restart is by definition NOT a clean shutdown.
  setInterval(() => {
    if (accumulator) store.saveAccumulatorCheckpoint(todayIST, serializeCheckpoint(accumulator));
  }, CHECKPOINT_SAVE_MS);

  setInterval(async () => {
    const ist = nowIST();
    // The IST CALENDAR DATE (never a raw `new Date()` instant) — near
    // midnight UTC, the UTC weekday and the IST weekday can genuinely
    // differ (e.g. 19:00 UTC Tuesday = 00:30 IST Wednesday), so weekday/
    // holiday checks must be anchored to the already-correct ist.dateISO,
    // not re-derived from a UTC instant.
    const istCalendarDate = new Date(`${ist.dateISO}T00:00:00Z`);
    const isHolidayOrWeekend = !isTradingDay(istCalendarDate);
    // A trading DAY is necessary but not sufficient — deriveHealthStatus's
    // MARKET_CLOSED branch never fired outside a holiday/weekend even at
    // 8pm IST on an ordinary Wednesday, because this previously checked
    // only the day, never the clock. Real deploy caught this: the worker
    // sat reporting CONNECTING all evening instead of MARKET_CLOSED.
    const isMarketHours = !isHolidayOrWeekend && isMarketOpen(ist.minutesSinceMidnight);
    const health = deriveHealthStatus({
      nowMs: Date.now(), lastSocketMessageAtMs, isMarketHours,
      isWarmedUp: depthSource.getHealth().status === 'HEALTHY', hasUnrecoverableGapThisWeek: hasUnrecoverableGapToday,
    });
    const quality = deriveSessionQuality(health, hasUnrecoverableGapToday);

    await store.insertWorkerHealth({
      workerInstance: WORKER_INSTANCE, connectionGeneration: depthSource.getHealth().connectionGeneration,
      status: health, workerStartedAt: new Date().toISOString(), reconnectCount: depthSource.getHealth().reconnectCount,
      currentInstrumentToken: resolvedFuture.instrumentToken, currentFutureSymbol: resolvedFuture.tradingsymbol,
    });

    const isSignalDay = isSignalWeekday(istCalendarDate, false); // TODO: real "did the preceding Wednesday have data" tracking — Gate 5.2's own fallback logic, not yet wired to a real prior-day check
    if (!isSignalDay || !isWithinSignalWindow(ist.minutesSinceMidnight) || !canFireNewSignal(quality) || !accumulator) return;

    const nowSec = (Date.now() - accumulator.sessionOriginMs) / 1000;
    const decision = evaluateCurrentSignal(accumulator, nowSec, CUTOFF_SEC_FROM_ORIGIN, { value: null, available: false });
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
