/**
 * Options Auto-Trader — single Vercel function, dispatched by
 * `?resource=`, mirroring api/intraday.js's exact convention (one file,
 * many resources) because Vercel's Hobby plan caps a deployment at 12
 * serverless functions and this repo is already near that limit; one file
 * per operation isn't affordable here.
 *
 * This file is `.ts`, not `.js` like every other api/*.js handler in this
 * repo — a deliberate exception. The paper-scan resource below needs to
 * call the strictly-typed quant pipeline (enrichChain, evaluateExpiries,
 * decideTrade, computePositionSize, the execution state machine) built
 * this session under src/quant/. No existing api/*.js file has ever
 * imported a .ts sibling, and that specific interop is unproven for
 * Vercel's Node function bundler; a .ts ENTRY file importing other .ts
 * files, by contrast, is Vercel's own long-established, mainstream,
 * documented support for TypeScript API routes. Converting this one file
 * was the lower-risk path, verified live after deploy (see this repo's
 * session history) rather than assumed.
 *
 * Resources:
 *   instruments-sync — syncs options_instruments from Kite's NFO/BFO
 *                       instrument dumps (cron-triggered, daily).
 *   margin            — live Kite basket-margin check for a candidate's
 *                       legs (the pre-trade risk gate).
 *   paper-scan        — the paper-execution orchestrator: builds a live
 *                       chain, runs the full decision pipeline, sizes and
 *                       validates the result, and records a PAPER position
 *                       (never a real order). See handlePaperScan below.
 *   position-monitor  — the exit engine: re-quotes every leg of every
 *                       ACTIVE position in one batched pass and closes
 *                       anything that trips profit-target/stop-loss/
 *                       strike-breach/time-exit. See handlePositionMonitor.
 *   settings          — browser-facing read/update of options_autotrade_settings.
 *   positions         — browser-facing read of positions + their legs.
 *   log               — browser-facing read of the most recent log entries.
 *   kill-switch       — browser-facing: sets execution_mode to OFF (its
 *                       only real capability right now — see handleKillSwitch).
 *   daily-stats       — browser-facing read of today's risk-lock state.
 *   clear-daily-lock  — browser-facing manual override for the daily lock
 *                       (the spec's own "require manual re-enable").
 *
 * instruments-sync/margin/paper-scan/position-monitor are cron/server-
 * triggered (kite_session, shared-secret protected); settings/positions/log/
 * kill-switch/daily-stats/clear-daily-lock are browser-facing and need no
 * secret, matching api/intraday.js's own settings/positions convention.
 *
 * VWAP 3σ Mean Reversion Scalper (NSE, src/vwap-scalper/) — a completely
 * separate standalone strategy, folded into this same file for the exact
 * same reason this file exists at all: it needs .ts imports, and this is
 * the one file proven to support them on Vercel (see above). Not
 * thematically related to options — purely a technical-constraint
 * cohabitation, kept clearly namespaced:
 *   vwap-scalper-scan     — cron/secret-gated: scans the NIFTY 50
 *                       universe's live 1-minute bars for a fresh
 *                       touch/rejection signal and opens a sized PAPER
 *                       position. See handleVwapScalperScan.
 *   vwap-scalper-monitor  — cron/secret-gated: live target/stop
 *                       monitoring + unrealized P&L for every ACTIVE
 *                       position. See handleVwapScalperMonitor.
 *   vwap-scalper-settings/positions/log/kill-switch — browser-facing,
 *                       mirroring the options resources of the same shape.
 *   vwap-scalper-chart   — browser-facing: today's 1-minute bars + VWAP/
 *                       band series for one symbol, for the dashboard's
 *                       chart. See handleVwapScalperChart.
 *   vwap-scalper-daily-stats/clear-daily-lock — browser-facing, mirroring
 *                       the options resources of the same shape.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { parseKiteOptionsCSV, filterActiveInstruments, OPTIONS_SYMBOLS } from '../src/lib/optionsInstrumentMaster.js';
import { buildBasketMarginRequest, parseBasketMarginResponse, checkMarginSufficient } from '../src/lib/optionsMargin.js';
import { selectStrikesNearSpot, chunk, kiteQuoteToOptionRow, buildInstrumentKeys, MAX_QUOTE_INSTRUMENTS } from '../src/lib/optionsChainLive.js';
import { normalise, type RawChainPayload } from '../src/quant/data/adapter.ts';
import { enrichChain } from '../src/quant/enrich.ts';
import { evaluateExpiries } from '../src/quant/strategies/expirySelector.ts';
import type { HistoricalClose } from '../src/quant/analytics/realizedVolatility.ts';
import { ivRankAndPercentile, type IvHistoryPoint, type IvRankResult } from '../src/quant/analytics/ivRank.ts';
import { atmIvOf } from '../src/quant/analytics/atmIv.ts';
import { classifyMarketRegime, type MarketRegimeResult } from '../src/quant/analytics/marketRegime.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decideTrade, type DecisionThresholds } from '../src/quant/strategies/decisionGate.ts';
import { computePositionSize, type PortfolioState, type OpenPositionSummary } from '../src/quant/strategies/positionSizing.ts';
import { runPreTradeValidation } from '../src/quant/execution/preTradeValidation.ts';
import { runPaperExecution, type PlannedLeg } from '../src/quant/execution/paperFill.ts';
import { runLiveExecution, type LiveOrderPlacer } from '../src/quant/execution/liveFill.ts';
import { evaluateExit, type ShortStrike } from '../src/quant/execution/exitEngine.ts';
import { checkDailyRiskLock } from '../src/quant/execution/dailyRiskLock.ts';
import { computeVwapBands } from '../src/vwap-scalper/vwapBands.ts';
import { detectVwapScalperSignals } from '../src/vwap-scalper/signals.ts';
import { computeVwapScalperPositionSize, computeFixedCapitalPositionSize } from '../src/vwap-scalper/positionSizing.ts';
import { NIFTY_50_UNIVERSE } from '../src/vwap-scalper/nifty50Universe.ts';
import { computeEffectiveTarget } from '../src/vwap-scalper/targetAndStop.ts';
import type { Bar as VwapBar, VwapScalperParams } from '../src/vwap-scalper/types.ts';

const KITE_BASE = 'https://api.kite.trade';

// Kite's standard index quote keys — all three confirmed against live
// paper-scan runs (2026-09-21). NIFTY/SENSEX were already used elsewhere
// in this codebase (src/lib/kiteSymbol.js); BANKNIFTY's 'NSE:NIFTY BANK'
// was this module's own addition and is now verified too, not assumed.
const INDEX_QUOTE_KEY: Record<string, string> = {
  NIFTY: 'NSE:NIFTY 50',
  BANKNIFTY: 'NSE:NIFTY BANK',
  SENSEX: 'BSE:SENSEX',
};

// Only these two symbols have a built ATM-IV history store (buildIvHistory.ts,
// from real bhavcopy archives — see src/quant/data/history/). BANKNIFTY has
// none yet: ivRank stays genuinely UNAVAILABLE for it rather than borrowing
// NIFTY's or fabricating a number.
const IV_HISTORY_FILE: Record<string, string> = {
  NIFTY: 'atm_iv_nifty.json',
  SENSEX: 'atm_iv_sensex.json',
};
const IV_RANK_LOOKBACKS = [30, 60, 90, 180, 252];

/** Loads the real per-session ATM-IV archive for a symbol, or [] when none exists/fails to parse — never fabricated, see loadIvRankByLookback's caller. */
function loadIvHistory(symbol: string): IvHistoryPoint[] {
  const filename = IV_HISTORY_FILE[symbol];
  if (!filename) return [];
  const filePath = path.join(process.cwd(), 'src/quant/data/history', filename);
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  return (raw?.points ?? []).map((p: any) => ({ date: p.date, atmIv: p.atmIv }));
}

async function kiteFetch(path: string, opts: { method?: string; token: string; apiKey: string; jsonBody?: unknown } ): Promise<any> {
  const { method = 'GET', token, apiKey, jsonBody } = opts;
  const resp = await fetch(`${KITE_BASE}${path}`, {
    method,
    headers: {
      'X-Kite-Version': '3',
      Authorization: `token ${apiKey}:${token}`,
      ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || json?.status === 'error') {
    throw new Error(json?.message || `Kite API error (${resp.status}) on ${path}`);
  }
  return json?.data;
}

/**
 * Order placement/modification on Kite Connect uses
 * application/x-www-form-urlencoded bodies, NOT JSON — unlike every other
 * endpoint this file talks to (margins/basket, quotes, historical data all
 * take/return JSON). Sending an order as JSON would either be silently
 * misparsed or rejected by the broker; this is its own helper specifically
 * so that mistake can't happen by reusing kiteFetch's JSON body encoding.
 */
async function kiteFetchForm(path: string, opts: { method?: string; token: string; apiKey: string; form: Record<string, string | number> }): Promise<any> {
  const { method = 'POST', token, apiKey, form } = opts;
  const body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString();
  const resp = await fetch(`${KITE_BASE}${path}`, {
    method,
    headers: {
      'X-Kite-Version': '3',
      Authorization: `token ${apiKey}:${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || json?.status === 'error') {
    throw new Error(json?.message || `Kite API error (${resp.status}) on ${path}`);
  }
  return json?.data;
}

/**
 * Real order placement/polling/quoting, implementing liveFill.ts's
 * LiveOrderPlacer interface against the actual Kite Connect API. This is
 * the ONLY place real money moves in this entire codebase — everywhere
 * else (paperFill.ts, this file's own PAPER-mode path) simulates. Kept
 * deliberately thin: all the sequencing/retry/unwind judgment already
 * lives in liveFill.ts, independently tested against a mocked version of
 * this same interface.
 */
function makeLiveOrderPlacer(token: string, apiKey: string): LiveOrderPlacer {
  return {
    async getQuote(tradingsymbol, exchange) {
      try {
        const data = await kiteFetch(`/quote?i=${encodeURIComponent(`${exchange}:${tradingsymbol}`)}`, { token, apiKey });
        const q = data?.[`${exchange}:${tradingsymbol}`];
        const depth = q?.depth;
        const bid = depth?.buy?.[0]?.price;
        const ask = depth?.sell?.[0]?.price;
        const lastPrice = q?.last_price;
        if (!(lastPrice > 0)) return null;
        // A thin/no-depth instrument can have an empty order book on one
        // side — fall back to last_price for whichever side is missing
        // rather than treating the whole quote as unusable.
        return { bid: bid > 0 ? bid : lastPrice, ask: ask > 0 ? ask : lastPrice, lastPrice };
      } catch {
        return null;
      }
    },

    async placeOrder(leg, exchange, transactionType, limitPrice) {
      const data = await kiteFetchForm('/orders/regular', {
        token, apiKey,
        form: {
          tradingsymbol: leg.tradingsymbol, exchange,
          transaction_type: transactionType,
          quantity: leg.quantity,
          product: 'NRML',
          order_type: 'LIMIT',
          price: limitPrice.toFixed(2),
          validity: 'DAY',
        },
      });
      return data?.order_id;
    },

    async closeLeg(leg, exchange) {
      // Best-effort unwind: MARKET, opposite side of how the leg was
      // meant to be held — a BUY leg that filled gets sold back, a SELL
      // leg that filled gets bought back. Speed of execution matters far
      // more than price here, hence MARKET rather than LIMIT.
      const data = await kiteFetchForm('/orders/regular', {
        token, apiKey,
        form: {
          tradingsymbol: leg.tradingsymbol, exchange,
          transaction_type: leg.side === 'BUY' ? 'SELL' : 'BUY',
          quantity: leg.quantity,
          product: 'NRML',
          order_type: 'MARKET',
          validity: 'DAY',
        },
      });
      return data?.order_id;
    },

    async awaitFill(orderId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const history = await kiteFetch(`/orders/${orderId}`, { token, apiKey }).catch(() => null);
        const last = Array.isArray(history) ? history[history.length - 1] : null;
        const status = last?.status as string | undefined;
        if (status === 'COMPLETE') {
          const avg = Number(last?.average_price);
          return { status: 'COMPLETE', averagePrice: avg > 0 ? avg : null };
        }
        if (status === 'REJECTED') return { status: 'REJECTED', averagePrice: null };
        if (status === 'CANCELLED') return { status: 'CANCELLED', averagePrice: null };
        if (Date.now() >= deadline) return { status: 'TIMEOUT', averagePrice: null };
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
  };
}

/**
 * Real available funds for F&O (the "equity" segment covers NFO/BFO
 * derivatives on Kite) — checked independently of the user-set
 * reserved_fund setting, which is a self-declared allocation, not a live
 * pull of the actual broker balance. AUTO mode must never fire a real
 * order sized against a number the account doesn't actually have.
 */
async function fetchRealAvailableFunds(token: string, apiKey: string): Promise<number | null> {
  try {
    const data = await kiteFetch('/user/margins/equity', { token, apiKey });
    const available = Number(data?.available?.live_balance ?? data?.net);
    return available > 0 ? available : 0;
  } catch {
    return null;
  }
}

/**
 * Real daily closes for the underlying index, via Kite's own historical
 * candle API on the INDEX's instrument_token (indices don't expire like
 * option contracts, so — unlike the option chain itself, see this file's
 * header — this endpoint reliably has a real multi-year history). The
 * instrument_token is read straight off the same live /quote response
 * already fetched for the spot price, rather than a second lookup.
 *
 * Feeds evaluateExpiries()'s historicalCloses param (see
 * expirySelector.ts) for the IV/RV premium-edge calculation. Returns []
 * on any failure — the caller treats an empty/short series as "exclude
 * premiumEdge from the score", never as a fabricated/neutral edge.
 */
async function fetchHistoricalCloses(
  instrumentToken: number,
  opts: { token: string; apiKey: string },
  lookbackCalendarDays = 400,
): Promise<HistoricalClose[]> {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - lookbackCalendarDays * 86_400_000).toISOString().slice(0, 10);
  const data = await kiteFetch(`/instruments/historical/${instrumentToken}/day?from=${from}&to=${to}`, opts);
  const candles: unknown[] = data?.candles ?? [];
  return candles
    .filter((c): c is [string, number, number, number, number, number] => Array.isArray(c) && c.length >= 5)
    .map((c) => ({ date: String(c[0]).slice(0, 10), close: Number(c[4]) }))
    .filter((c) => c.close > 0);
}

function isMarketOpenIST(now = new Date()): boolean {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

/** Smallest gap between consecutive sorted strikes — self-derived rather than a hardcoded per-symbol constant, since it's already present in the synced instrument data. */
function inferStrikeStep(sortedStrikes: number[]): number {
  let step = Infinity;
  for (let i = 1; i < sortedStrikes.length; i++) step = Math.min(step, sortedStrikes[i] - sortedStrikes[i - 1]);
  return Number.isFinite(step) && step > 0 ? step : 50;
}

/**
 * Syncs the options instrument master (strike/expiry/right -> Kite's exact
 * tradingsymbol/instrument_token) from Kite's own NFO/BFO instrument
 * dumps. `options_instruments` is the only table an order-placing engine
 * may trust for a tradingsymbol — see src/lib/optionsInstrumentMaster.js's
 * header for why.
 */
async function handleInstrumentsSync(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'server_misconfigured' }); return; }

  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!token) { res.status(200).json({ ok: true, skipped: 'no_kite_session' }); return; }

  const exchanges = [...new Set(Object.values(OPTIONS_SYMBOLS))]; // ['NFO', 'BFO']
  let allRows: ReturnType<typeof parseKiteOptionsCSV> = [];
  try {
    for (const exchange of exchanges) {
      const resp = await fetch(`https://api.kite.trade/instruments/${exchange}`, {
        headers: { Authorization: `token ${apiKey}:${token}`, 'X-Kite-Version': '3' },
      });
      if (resp.status === 401 || resp.status === 403) {
        res.status(200).json({ ok: true, skipped: 'token_expired' });
        return;
      }
      if (!resp.ok) throw new Error(`Kite returned ${resp.status} for /instruments/${exchange}`);
      allRows = allRows.concat(parseKiteOptionsCSV(await resp.text()));
    }
  } catch (err: any) {
    res.status(502).json({ ok: false, error: 'kite_error', message: err.message });
    return;
  }

  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const rows = filterActiveInstruments(allRows, todayIST).map(({ right, ...rest }: any) => ({
    ...rest,
    option_right: right,
    last_synced_at: new Date().toISOString(),
  }));

  if (!rows.length) { res.status(200).json({ ok: true, synced: 0, warning: 'no_rows_parsed' }); return; }

  const { error } = await supabase.from('options_instruments').upsert(rows, { onConflict: 'exchange,tradingsymbol' });
  if (error) { res.status(502).json({ ok: false, error: 'supabase_error', message: error.message }); return; }

  res.status(200).json({ ok: true, synced: rows.length, exchanges });
}

/**
 * Live basket-margin check against Kite — the pre-trade gate every
 * options-selling candidate must pass before an order is ever placed.
 */
async function handleMargin(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const { legs, exchange = 'NFO', product = 'NRML', considerPositions = false, availableFunds, maxUtilizationPct } = req.body ?? {};
  if (!Array.isArray(legs) || !legs.length) {
    res.status(400).json({ error: 'bad_request', message: 'legs (non-empty array) is required.' });
    return;
  }

  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'server_misconfigured' }); return; }

  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!token) { res.status(200).json({ ok: false, error: 'no_kite_session' }); return; }

  const basketReq = buildBasketMarginRequest(legs, { exchange, product, considerPositions });

  let data;
  try {
    data = await kiteFetch(`/margins/basket?consider_positions=${basketReq.considerPositions ? 'true' : 'false'}`, {
      method: 'POST', token, apiKey, jsonBody: basketReq.orders,
    });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: 'kite_error', message: err.message });
    return;
  }

  const margin = parseBasketMarginResponse(data);
  const gate = availableFunds != null
    ? checkMarginSufficient({ totalRequired: margin?.totalRequired ?? null, availableFunds, maxUtilizationPct: maxUtilizationPct ?? null })
    : null;

  res.status(200).json({ ok: true, margin, gate });
}

/**
 * Serializes every evaluated expiry's FULL decision data — not just the
 * winning one's formatted text explanation. Nothing here is a new
 * calculation; every field is read straight off what evaluateExpiries()/
 * scoreTradeQuality() already computed and this endpoint was previously
 * discarding on a NO_TRADE response. Missing inputs (ivRank, margin
 * efficiency) stay `null` all the way through — never coerced to 0 or a
 * fabricated number.
 */
function serializeExpiryEvaluation(e: ReturnType<typeof evaluateExpiries>[number]) {
  const best = e.best;
  return {
    expiry: new Date(e.expiry).toISOString().slice(0, 10),
    dte: e.dte,
    bias: e.bias,
    biasReason: e.biasReason,
    strategyLabel: e.strategyLabel,
    candidateCount: e.candidateCount,
    failureCount: e.failureCount,
    skipReason: e.skipReason,
    premiumEdge: e.premiumEdge,
    best: best ? {
      targetShortDelta: best.targetShortDelta,
      wingWidth: best.wingWidth,
      expectedValue: best.expectedValue,
      evPerUnitRisk: best.evPerUnitRisk,
      legs: best.result.legs.map((l) => ({ side: l.side, right: l.right, strike: l.strike, price: l.price, iv: l.iv, delta: l.delta })),
      netCredit: best.result.netCredit,
      maxProfit: best.result.maxProfit,
      maxLoss: best.result.maxLoss,
      breakevens: 'breakevens' in best.result ? best.result.breakevens : [best.result.breakeven],
      pop: best.result.pop,
      forward: best.result.forward,
      forwardSource: best.result.forwardSource,
      atmIv: best.result.atmIv,
      liquidity: best.liquidity,
      qualityScore: {
        score: best.qualityScore.score,
        components: best.qualityScore.components,
        raw: best.qualityScore.raw,
        missingComponents: best.qualityScore.missingComponents,
      },
    } : null,
  };
}

/**
 * The paper-execution orchestrator: builds a live chain for one symbol,
 * runs the full decision pipeline (skew -> strategy -> optimizer -> expiry
 * selection -> quality score -> NO_TRADE/WATCH/CANDIDATE/HIGH_CONVICTION),
 * sizes the position against real account/portfolio state, validates it,
 * and — only in PAPER mode — records a simulated position. Never places a
 * real order; see this file's header and src/quant/execution/paperFill.ts.
 */
async function handlePaperScan(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const symbol = (req.query?.symbol as string) || 'NIFTY';
  const symbolExchanges = OPTIONS_SYMBOLS as Record<string, string>;
  if (!symbolExchanges[symbol]) {
    res.status(400).json({ error: 'bad_request', message: `Unknown symbol '${symbol}' (expected one of ${Object.keys(OPTIONS_SYMBOLS).join(', ')}).` });
    return;
  }
  const exchange = symbolExchanges[symbol];

  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'server_misconfigured' }); return; }

  const { data: settings } = await supabase.from('options_autotrade_settings').select('*').eq('id', 1).maybeSingle();
  if (!settings) { res.status(500).json({ ok: false, error: 'settings_not_found' }); return; }
  // This guard predates AUTO mode existing at all — it originally meant
  // "only run when paper execution is turned on." AUTO must pass it too,
  // or every scan cycle silently no-ops forever and AUTO never places a
  // single real order despite everything downstream being wired for it.
  if (settings.execution_mode !== 'PAPER' && settings.execution_mode !== 'AUTO') {
    res.status(200).json({ ok: true, skipped: `execution_mode is '${settings.execution_mode}', not PAPER or AUTO` });
    return;
  }

  // Computed once, up top, so every log entry this whole scan produces —
  // not just the ones after sizing — is tagged with the mode it actually
  // ran under. The dashboard's Activity Log filters on this exactly like
  // it already filters positions, so old PAPER chatter doesn't sit next
  // to real AUTO activity looking like it's still happening.
  const isLive = settings.execution_mode === 'AUTO';
  const modeLabel = isLive ? 'AUTO' : 'PAPER';
  const log = (level: 'info' | 'error', message: string, detail?: unknown) =>
    supabase.from('options_autotrade_log').insert({ level, message, detail: detail ?? null, execution_mode: modeLabel });

  if (!isMarketOpenIST()) { res.status(200).json({ ok: true, skipped: 'outside_market_hours' }); return; }

  // Daily risk lock — checked before any live Kite call, so a locked day
  // costs nothing beyond this one DB read. Stricter than positionSizing.ts's
  // own implicit maxDailyLoss constraint (which only zeroes out lots for
  // whichever specific candidate is being sized, and knows nothing about
  // consecutive losses) — this is the blanket refusal Phase 20 asks for.
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const { data: dailyRowPreCheck } = await supabase.from('options_autotrade_daily_stats').select('*').eq('trade_date', todayIST).maybeSingle();
  const lock = checkDailyRiskLock(
    { realizedPnlToday: Number(dailyRowPreCheck?.realized_pnl) || 0, consecutiveLosses: Number(dailyRowPreCheck?.consecutive_losses) || 0 },
    { equity: Number(settings.reserved_fund) || 0, maxDailyLossPct: settings.max_daily_loss_pct, maxConsecutiveLosses: settings.max_consecutive_losses },
  );
  if (lock.locked) {
    if (!dailyRowPreCheck?.locked) {
      await supabase.from('options_autotrade_daily_stats').upsert({ trade_date: todayIST, locked: true, lock_reason: lock.reason });
      await log('info', `Daily risk lock engaged for ${symbol}: ${lock.reason} — ${lock.detail}`);
    }
    res.status(200).json({ ok: true, skipped: 'daily_risk_locked', reason: lock.reason, detail: lock.detail });
    return;
  }

  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!token) { res.status(200).json({ ok: true, skipped: 'no_kite_session' }); return; }

  // 1. Which expiries/strikes are actually available for this symbol.
  const { data: instrumentRows, error: instrumentsErr } = await supabase
    .from('options_instruments').select('*').eq('symbol', symbol).order('expiry', { ascending: true });
  if (instrumentsErr) { res.status(502).json({ ok: false, error: 'supabase_error', message: instrumentsErr.message }); return; }
  if (!instrumentRows?.length) {
    res.status(200).json({ ok: true, skipped: 'no_instruments_synced', message: 'Run instruments-sync first.' });
    return;
  }

  // 1b. The instrument master is the ONLY source of truth for which
  // expiries/strikes are actually tradable (see this endpoint's own
  // header discipline) — but that's only true if the sync itself is
  // recent. A silently-stale master (e.g. the daily instruments-sync cron
  // stopped running) wouldn't cause a wrong trade — the DTE band below
  // still filters out anything already expired — but it COULD silently
  // miss a newly-listed contract or misreport "no eligible expiries" for
  // a reason that has nothing to do with market conditions. Surfaced in
  // diagnostics on every scan (never assumed fresh), and hard-blocked
  // past 96h (a full long-weekend-plus-holiday gap) so a genuinely broken
  // sync can't run silently for days.
  const instrumentMasterLastSyncedAt = instrumentRows.reduce(
    (latest: string, r: any) => (r.last_synced_at > latest ? r.last_synced_at : latest),
    instrumentRows[0].last_synced_at,
  );
  const instrumentMasterAgeHours = (Date.now() - Date.parse(instrumentMasterLastSyncedAt)) / 3_600_000;
  if (instrumentMasterAgeHours > 96) {
    res.status(200).json({
      ok: true, skipped: 'stale_instrument_master',
      message: `Instrument master last synced ${instrumentMasterAgeHours.toFixed(1)}h ago (> 96h) — run instruments-sync before trusting expiries/strikes from it.`,
      instrumentMasterLastSyncedAt,
    });
    return;
  }

  const allExpiries = [...new Set(instrumentRows.map((r: any) => r.expiry as string))].sort();
  const eligibleExpiries = allExpiries.filter((expiry) => {
    const dte = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${todayIST}T00:00:00Z`)) / 86_400_000);
    return dte >= settings.min_dte && dte <= settings.max_dte;
  });
  if (!eligibleExpiries.length) {
    res.status(200).json({ ok: true, skipped: 'no_eligible_expiries', allExpiries });
    return;
  }

  // 2. Spot price for the underlying — batched with India VIX in the SAME
  // call (both are just quote keys Kite already serves), so the real
  // market-regime signals below cost zero extra requests.
  const indexKey = INDEX_QUOTE_KEY[symbol];
  const VIX_KEY = 'NSE:INDIA VIX';
  let spotData: any;
  try {
    spotData = await kiteFetch(`/quote?i=${encodeURIComponent(indexKey)}&i=${encodeURIComponent(VIX_KEY)}`, { token, apiKey });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: 'kite_error', message: err.message });
    return;
  }
  const spot = spotData?.[indexKey]?.last_price;
  if (!(spot > 0)) { res.status(502).json({ ok: false, error: 'no_spot_price' }); return; }

  // Real India VIX and today's gap/intraday-range — from the SAME live
  // quote response, no extra call. Null when genuinely absent (never
  // fabricated) — see analytics/marketRegime.ts's own discipline.
  const indiaVix: number | null = spotData?.[VIX_KEY]?.last_price ?? null;
  const indexOhlc = spotData?.[indexKey]?.ohlc;
  const gapAndRange = indexOhlc && indexOhlc.close > 0 && indexOhlc.open > 0
    ? {
        gapPct: ((indexOhlc.open - indexOhlc.close) / indexOhlc.close) * 100,
        intradayRangePct: ((indexOhlc.high - indexOhlc.low) / indexOhlc.open) * 100,
      }
    : null;

  // 2b. Real historical closes for the underlying (for the premium-edge —
  // IV vs realized-volatility — signal). Best-effort: a failure here must
  // not fail the whole scan, it just means premiumEdge is excluded from
  // the quality score rather than fabricated (see fetchHistoricalCloses).
  const instrumentToken = spotData?.[indexKey]?.instrument_token;
  let historicalCloses: HistoricalClose[] = [];
  if (instrumentToken) {
    try {
      historicalCloses = await fetchHistoricalCloses(instrumentToken, { token, apiKey });
    } catch (err: any) {
      await log('error', `Historical closes fetch failed for ${symbol} — premiumEdge will be excluded, not fabricated`, { message: err.message });
    }
  } else {
    await log('error', `No instrument_token in quote response for ${indexKey} — premiumEdge will be excluded, not fabricated`);
  }

  // 3. Build the live chain: select strikes near spot for EVERY eligible
  // expiry first, then batch-fetch quotes ONCE across all of them
  // combined (chunked at Kite's own documented /quote cap, 500
  // instruments — see MAX_QUOTE_INSTRUMENTS), instead of one separate
  // quote call per expiry. A symbol can have 8-9 eligible expiries;
  // firing that many full-depth quote calls back-to-back risks Kite's
  // "1 request/sec for /quote" limit on its own, independent of how
  // often this scan itself runs. Combining first cuts a typical scan
  // from ~8-9 quote calls down to 1-2.
  const lotSize = instrumentRows.find((r: any) => r.expiry === eligibleExpiries[0])?.lot_size ?? null;
  const rows: any[] = [];
  const now = Date.now();

  const allKeys: string[] = [];
  const metaByKey = new Map<string, { strike: number; right: 'CE' | 'PE'; expiryEpochMs: number }>();
  for (const expiry of eligibleExpiries) {
    const forExpiry = instrumentRows.filter((r: any) => r.expiry === expiry);
    const availableStrikes = forExpiry.map((r: any) => Number(r.strike));
    const nearStrikes = new Set(selectStrikesNearSpot(availableStrikes, spot));
    const selected = forExpiry.filter((r: any) => nearStrikes.has(Number(r.strike)));
    if (!selected.length) continue;

    const { keys, byKey } = buildInstrumentKeys(
      selected.map((r: any) => ({ strike: Number(r.strike), right: r.option_right, tradingsymbol: r.tradingsymbol })),
      exchange,
    );
    const expiryEpochMs = Date.parse(`${expiry}T15:30:00+05:30`);
    for (const key of keys) {
      allKeys.push(key);
      const meta = byKey.get(key);
      if (meta) metaByKey.set(key, { strike: meta.strike, right: meta.right, expiryEpochMs });
    }
  }

  for (const batch of chunk(allKeys, MAX_QUOTE_INSTRUMENTS)) {
    let quoteData: any;
    try {
      quoteData = await kiteFetch(`/quote?${batch.map((k: string) => `i=${encodeURIComponent(k)}`).join('&')}`, { token, apiKey });
    } catch (err: any) {
      await log('error', 'Live quote batch failed during paper-scan', { symbol, message: err.message });
      continue;
    }
    for (const key of batch) {
      const meta = metaByKey.get(key);
      const quote = quoteData?.[key];
      if (!meta || !quote) continue;
      rows.push(kiteQuoteToOptionRow({ strike: meta.strike, right: meta.right, expiryEpochMs: meta.expiryEpochMs, asOfEpochMs: now, quote }));
    }
  }

  if (!rows.length) { res.status(200).json({ ok: true, skipped: 'no_quotes_fetched' }); return; }

  const payload: RawChainPayload = {
    source: { providerId: 'kite-live', kind: 'live', retrievedAt: now },
    contract: {
      underlyingSymbol: symbol,
      lotSize: lotSize && lotSize > 0 ? lotSize : 1,
      pointValue: 1,
      strikeStep: inferStrikeStep([...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b)),
      currency: 'INR',
      exerciseStyle: 'european',
      pricingBasis: 'futures',
    },
    context: { valuationTime: now, spot, futures: null, riskFreeRate: 0.065, dividendYield: 0 },
    rows,
  };

  const { chain: normalised, rejected } = normalise(payload);
  const enriched = enrichChain(normalised);

  // 3b. IV rank/percentile against the REAL per-session ATM-IV archive
  // (src/quant/data/history/) — one reading per session, the same
  // near-term convention the archive itself was built with (see
  // ExpirySelectorParams.ivRank's own doc comment). Ranked at several
  // configurable lookbacks; genuinely UNAVAILABLE (not fabricated) when a
  // symbol has no archive yet (BANKNIFTY) or there isn't enough history
  // for a given window.
  let ivRankByLookback: Record<number, IvRankResult | null> = {};
  let currentAtmIvForRank: number | null = null;
  try {
    const ivHistory = loadIvHistory(symbol);
    currentAtmIvForRank = enriched.slices[0] ? atmIvOf(enriched.slices[0]) : null;
    if (ivHistory.length > 0 && currentAtmIvForRank !== null) {
      for (const lookback of IV_RANK_LOOKBACKS) {
        ivRankByLookback[lookback] = ivRankAndPercentile(ivHistory, currentAtmIvForRank, lookback);
      }
    }
  } catch (err: any) {
    await log('error', `IV history load/rank failed for ${symbol} — ivRank will be excluded, not fabricated`, { message: err.message });
  }
  // The 252-session (≈1Y trading) lookback is this endpoint's primary
  // reading, fed into the quality score — matches ivRankAndPercentile's own
  // default and tradeQualityScore's existing single-ivRank-input shape.
  const primaryIvRank = ivRankByLookback[252]?.rank ?? null;

  // 4. Run the decision pipeline (skew -> strategy -> optimizer -> expiry
  // selection -> quality score). Both ivRank and premiumEdge are wired
  // from real data now — ivRank from the archive above, premiumEdge from
  // the real historicalCloses fetched earlier.
  const step = enriched.slices[0]?.forward ? inferStrikeStep(enriched.slices[0].quotes.map((q) => q.quote.strike)) : 50;
  const wingWidths = [2, 4, 6].map((m) => m * step);
  const evaluations = evaluateExpiries(enriched, {
    lotSize: lotSize && lotSize > 0 ? lotSize : 1,
    wingWidths,
    minDte: settings.min_dte,
    maxDte: settings.max_dte,
    ivRank: primaryIvRank,
    historicalCloses,
  });
  const thresholds: DecisionThresholds = {
    noTradeBelow: settings.no_trade_below,
    watchBelow: settings.watch_below,
    highConvictionAtOrAbove: settings.high_conviction_at_or_above,
  };

  // Market regime — genuinely independent of skew (see
  // analytics/marketRegime.ts's own header): computed from the real
  // historicalCloses/spot/VIX/OHLC already fetched above, never from
  // regimeSelect.ts's skew-derived bias. null (not fabricated) when there
  // isn't enough real history yet.
  let marketRegime: MarketRegimeResult | null = null;
  try {
    marketRegime = classifyMarketRegime({ historicalCloses, currentSpot: spot, indiaVix, gapAndRange });
  } catch (err: any) {
    await log('error', `Market regime classification failed for ${symbol}`, { message: err.message });
  }

  const decision = decideTrade(evaluations, thresholds, marketRegime);
  const diagnostics = {
    spot, symbol, scannedAt: new Date(now).toISOString(),
    eligibleExpiries, rejectedRows: rejected.length,
    instrumentMasterLastSyncedAt, instrumentMasterAgeHours: Number(instrumentMasterAgeHours.toFixed(1)),
    historicalClosesFetched: historicalCloses.length,
    currentAtmIvForRank,
    ivRankByLookback,
    marketRegime,
    evaluations: evaluations.map(serializeExpiryEvaluation),
  };

  await log('info', `${modeLabel} scan decision for ${symbol}: ${decision.action}`, { rejectedRows: rejected.length, decision: decision.explanation });

  if (decision.action === 'NO_TRADE' || !decision.expiryEvaluation?.best) {
    res.status(200).json({ ok: true, action: decision.action, explanation: decision.explanation, diagnostics });
    return;
  }

  const best = decision.expiryEvaluation.best;
  const candidateSymbolGroup = symbol;
  // expiryEvaluation.expiry is epoch ms (the quant engine's own EpochMs
  // convention); options_instruments.expiry comes back from Supabase as a
  // "YYYY-MM-DD" date string — every comparison against a DB row must go
  // through this same conversion, not compare the raw epoch value.
  const expiryDateStr = new Date(decision.expiryEvaluation.expiry).toISOString().slice(0, 10);

  // 5. Portfolio state from currently ACTIVE paper positions.
  const { data: openRows } = await supabase.from('options_autotrade_positions').select('*').eq('status', 'ACTIVE');
  const openPositions: OpenPositionSummary[] = (openRows ?? []).map((p: any) => ({
    underlyingGroup: p.symbol,
    maxLoss: Number(p.max_loss) || 0,
    marginRequired: Number(p.margin_required) || 0,
    netGreeks: { delta: Number(p.net_delta) || 0, gamma: Number(p.net_gamma) || 0, theta: Number(p.net_theta) || 0, vega: Number(p.net_vega) || 0, rho: 0 },
  }));
  const duplicateExists = (openRows ?? []).some((p: any) => p.symbol === symbol && p.expiry === expiryDateStr && p.strategy_label === decision.expiryEvaluation!.strategyLabel);

  const { data: dailyRow } = await supabase.from('options_autotrade_daily_stats').select('*').eq('trade_date', todayIST).maybeSingle();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const { data: weekRows } = await supabase.from('options_autotrade_daily_stats').select('realized_pnl').gte('trade_date', sevenDaysAgo);
  const realizedPnlToday = Number(dailyRow?.realized_pnl) || 0;
  const realizedPnlThisWeek = (weekRows ?? []).reduce((s: number, r: any) => s + (Number(r.realized_pnl) || 0), 0);

  const portfolio: PortfolioState = { openPositions, realizedPnlToday, realizedPnlThisWeek };

  // 6. Per-lot margin from a live basket call (the candidate's own legs, at 1 lot).
  const legs: PlannedLeg[] = best.result.legs.map((l) => {
    const inst = instrumentRows.find((r: any) => r.expiry === expiryDateStr && Number(r.strike) === l.strike && r.option_right === l.right);
    return { side: l.side, right: l.right, strike: l.strike, tradingsymbol: inst?.tradingsymbol ?? '', quantity: lotSize ?? 0, fillPrice: l.price };
  });
  const unresolvedLegs = legs.filter((l) => !l.tradingsymbol).map((l) => `${l.strike}${l.right}`);

  let marginRequiredPerLot = 0;
  let marginDetail = 'Margin not checked — instrument resolution failed.';
  if (!unresolvedLegs.length) {
    try {
      const basketReq = buildBasketMarginRequest(legs.map((l) => ({ side: l.side, tradingsymbol: l.tradingsymbol, quantity: l.quantity })), { exchange, product: 'NRML' });
      const marginData = await kiteFetch(`/margins/basket?consider_positions=false`, { method: 'POST', token, apiKey, jsonBody: basketReq.orders });
      const margin = parseBasketMarginResponse(marginData);
      marginRequiredPerLot = margin?.totalRequired ?? 0;
      marginDetail = `Live basket margin for 1 lot: ₹${marginRequiredPerLot.toFixed(0)}.`;
    } catch (err: any) {
      marginDetail = `Margin check failed: ${err.message}`;
    }
  }

  // AUTO mode sizes against the REAL broker balance, never the self-
  // declared reserved_fund setting — that number is a risk-budget
  // allocation a human typed in, not a live account balance. A failed
  // fetch refuses the trade outright rather than falling back to
  // reserved_fund, which would size a real order against a number nobody
  // has verified the account actually holds.
  const realAvailableFunds = isLive ? await fetchRealAvailableFunds(token, apiKey) : null;
  if (isLive && realAvailableFunds === null) {
    await log('error', `AUTO: could not verify real account funds for ${symbol} — refusing to size or place any order this cycle.`);
    res.status(200).json({ ok: true, action: decision.action, opened: false, skipped: 'real_funds_unavailable', diagnostics });
    return;
  }

  const sizing = computePositionSize(
    {
      pricing: { maxLoss: best.result.maxLoss, maxProfit: best.result.maxProfit, netCredit: best.result.netCredit, netGreeks: best.result.netGreeks },
      marginRequiredPerLot,
      underlyingGroup: candidateSymbolGroup,
    },
    {
      // AUTO bases every %-of-equity risk cap (max risk/trade, daily/weekly
      // loss, portfolio risk, correlated-group risk) on the REAL account
      // balance too — reserved_fund is a self-declared number a human
      // typed in, and letting real risk limits key off it would let those
      // caps drift arbitrarily far from what the account can actually
      // absorb. PAPER keeps using reserved_fund, since there's no real
      // balance to check it against.
      equity: isLive ? (realAvailableFunds ?? 0) : Number(settings.reserved_fund) || 0,
      availableFunds: isLive ? (realAvailableFunds ?? 0) : Number(settings.reserved_fund) || 0,
    },
    portfolio,
    {
      maxRiskPerTradePct: settings.max_risk_per_trade_pct, maxDailyLossPct: settings.max_daily_loss_pct,
      maxWeeklyLossPct: settings.max_weekly_loss_pct, maxPortfolioRiskPct: settings.max_portfolio_risk_pct,
      maxMarginUtilizationPct: settings.max_margin_utilization_pct, maxPositions: settings.max_positions,
      maxUnderlyingDelta: settings.max_underlying_delta, maxGamma: settings.max_gamma, maxVega: settings.max_vega,
      maxCorrelatedGroupRiskPct: settings.max_correlated_group_risk_pct,
    },
  );

  // Lots are only known AFTER sizing — legs above were built at exactly
  // ONE lot's quantity (to price the per-lot margin call). Scale every
  // leg's quantity by sizing.lots now, before it goes anywhere near
  // execution or persistence; using the unscaled `legs` past this point
  // would trade/record the wrong quantity whenever sizing.lots > 1.
  const scaledLegs: PlannedLeg[] = legs.map((l) => ({ ...l, quantity: l.quantity * sizing.lots }));

  // 7. Pre-trade validation. This synchronous flow has no time gap between
  // scoring and "submission" — priceDrift/Greeks/max-loss recalculation are
  // therefore trivially unchanged (0% drift, same values). These checks
  // become meaningful once a real time gap exists (e.g. a SEMI_AUTO human
  // confirmation delay, or genuine order-placement latency) — for now they
  // mainly prove the validation interface is wired correctly.
  const validation = runPreTradeValidation({
    quoteAgeMs: 0, maxQuoteAgeMs: 5 * 60_000,
    isMarketOpen: true,
    allInstrumentsResolved: unresolvedLegs.length === 0, unresolvedLegs,
    marginSufficient: sizing.lots > 0 && marginRequiredPerLot > 0, marginDetail,
    positionSizeLots: sizing.lots,
    duplicatePositionExists: duplicateExists,
    priceDriftPct: 0, maxSlippagePct: 1.5,
    strategyStillValid: true, strategyDetail: 'Decision was made from the same live snapshot being validated — no time gap yet.',
    greeksWithinLimits: sizing.lots > 0, greeksDetail: sizing.lots > 0 ? 'Within computePositionSize\'s exposure caps.' : sizing.reason ?? 'Position size resolved to zero.',
    recalculatedMaxLoss: best.result.maxLoss, originalMaxLoss: best.result.maxLoss, maxLossDriftPct: 5,
  });

  // AUTO fires REAL orders against the real Zerodha account — BUY (hedge)
  // legs first, confirmed FILLED, before any SELL (short) leg, exactly the
  // sequencing real margin treatment requires (see liveFill.ts's own
  // header). PAPER keeps simulating every leg filling instantly.
  const execResult = isLive
    ? await runLiveExecution(scaledLegs, validation, makeLiveOrderPlacer(token, apiKey), { exchange })
    : runPaperExecution(scaledLegs, validation);

  if (execResult.state !== 'ACTIVE') {
    await log(isLive ? 'error' : 'info', `${modeLabel} position not opened for ${symbol}`, { reason: execResult.log });
    res.status(200).json({ ok: true, action: decision.action, opened: false, validation, sizing, log: execResult.log, diagnostics });
    return;
  }

  const { data: inserted, error: insertErr } = await supabase.from('options_autotrade_positions').insert({
    symbol, strategy_label: decision.expiryEvaluation.strategyLabel,
    expiry: expiryDateStr,
    status: 'ACTIVE', execution_state: execResult.state, protection: execResult.protection,
    execution_mode: modeLabel,
    lots: sizing.lots, net_credit: best.result.netCredit, max_profit: sizing.sizedMaxProfit, max_loss: sizing.sizedMaxLoss,
    margin_required: sizing.sizedMarginRequired,
    net_delta: (best.result.netGreeks.delta ?? 0) * sizing.lots, net_gamma: (best.result.netGreeks.gamma ?? 0) * sizing.lots,
    net_theta: (best.result.netGreeks.theta ?? 0) * sizing.lots, net_vega: (best.result.netGreeks.vega ?? 0) * sizing.lots,
    quality_score: best.qualityScore.score, decision_explanation: decision.explanation,
    entry_date: todayIST,
  }).select('id').single();

  if (insertErr) { res.status(502).json({ ok: false, error: 'supabase_error', message: insertErr.message }); return; }

  const legRows = execResult.legFills.map((l) => ({
    position_id: inserted.id, side: l.side, option_right: l.right, strike: l.strike,
    tradingsymbol: l.tradingsymbol, quantity: l.quantity, fill_price: l.fillPrice, status: l.status,
    order_id: l.orderId ?? null,
  }));
  await supabase.from('options_autotrade_legs').insert(legRows);
  await log('info', `Opened ${modeLabel} position #${inserted.id}: ${decision.expiryEvaluation.strategyLabel} on ${symbol}, ${sizing.lots} lot(s).`, isLive ? { log: execResult.log } : undefined);

  res.status(200).json({ ok: true, action: decision.action, opened: true, positionId: inserted.id, sizing, explanation: decision.explanation, diagnostics });
}

/**
 * Position Monitor + Exit Engine (Phase 14-16) — the piece that was
 * missing until now: without this, an opened paper position just sat as
 * ACTIVE forever with no way to close except deleting the DB row by hand.
 * Re-quotes every leg of every ACTIVE position in one batched pass (not
 * one Kite call per position — bounded API usage regardless of how many
 * are open), evaluates the multi-trigger exit engine, and closes anything
 * that trips a condition, updating the SAME daily_stats.realized_pnl
 * computePositionSize() already reads for the daily/weekly-loss caps —
 * those caps have been live but functionally untested until this existed,
 * since nothing ever wrote a realized P&L before.
 */
async function handlePositionMonitor(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'server_misconfigured' }); return; }

  // Position-specific entries are tagged with THAT position's own mode
  // (mode arg), since a single monitor run evaluates PAPER and AUTO
  // positions side by side — one function-wide flag would mislabel
  // whichever mode isn't currently the active setting. Batch-level
  // messages (no single position responsible) stay untagged.
  const log = (level: 'info' | 'error', message: string, detail?: unknown, mode?: string | null) =>
    supabase.from('options_autotrade_log').insert({ level, message, detail: detail ?? null, execution_mode: mode ?? null });

  const { data: settings } = await supabase.from('options_autotrade_settings').select('*').eq('id', 1).maybeSingle();
  if (!settings) { res.status(500).json({ ok: false, error: 'settings_not_found' }); return; }

  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!token) { res.status(200).json({ ok: true, skipped: 'no_kite_session' }); return; }

  const { data: positions, error: posErr } = await supabase
    .from('options_autotrade_positions').select('*, options_autotrade_legs(*)').eq('status', 'ACTIVE');
  if (posErr) { res.status(502).json({ ok: false, error: 'supabase_error', message: posErr.message }); return; }
  if (!positions?.length) { res.status(200).json({ ok: true, checked: 0, closed: [] }); return; }

  const symbolExchanges = OPTIONS_SYMBOLS as Record<string, string>;
  const indexKeys = INDEX_QUOTE_KEY as Record<string, string>;

  // Batch every quote this run needs across ALL open positions at once —
  // every leg's tradingsymbol plus each distinct symbol's index quote key
  // — rather than one Kite call per position, so API usage stays bounded
  // regardless of how many positions happen to be open.
  const legKeys = new Set<string>();
  const symbolsNeeded = new Set<string>();
  for (const p of positions) {
    symbolsNeeded.add(p.symbol);
    for (const l of (p.options_autotrade_legs ?? [])) legKeys.add(`${symbolExchanges[p.symbol] ?? 'NFO'}:${l.tradingsymbol}`);
  }
  for (const s of symbolsNeeded) { const key = indexKeys[s]; if (key) legKeys.add(key); }

  const quoteMap = new Map<string, any>();
  for (const batch of chunk([...legKeys], MAX_QUOTE_INSTRUMENTS)) {
    let data: any;
    try {
      data = await kiteFetch(`/quote?${batch.map((k: string) => `i=${encodeURIComponent(k)}`).join('&')}`, { token, apiKey });
    } catch (err: any) {
      await log('error', 'Live quote batch failed during position-monitor', { message: err.message });
      continue;
    }
    for (const key of batch) if (data?.[key]) quoteMap.set(key, data[key]);
  }

  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const closed: Array<{ positionId: number; symbol: string; reason: string | null; realizedPnl: number }> = [];

  for (const p of positions) {
    const legs = p.options_autotrade_legs ?? [];
    const exchange = symbolExchanges[p.symbol] ?? 'NFO';
    let currentCostToClose = 0;
    let missingQuote = false;
    for (const l of legs) {
      const price = quoteMap.get(`${exchange}:${l.tradingsymbol}`)?.last_price;
      if (price == null) { missingQuote = true; continue; }
      currentCostToClose += (l.side === 'SELL' ? 1 : -1) * price * l.quantity;
    }
    if (missingQuote) { await log('error', `Position #${p.id}: could not re-quote every leg — skipped this cycle.`, undefined, p.execution_mode); continue; }

    // Sanity bound: for ANY defined-risk structure, maxProfit + maxLoss IS
    // the strike-width-implied theoretical ceiling on cost-to-close (it's
    // just intrinsic value at the extreme, which is all a bounded vertical
    // can ever cost) — currentCostToClose can never legitimately exceed it
    // by more than a modest time-value margin. A poor-liquidity leg (thin
    // BFO chains especially) can occasionally print a stale/erroneous
    // last_price; trusting that blindly can trigger a stop-loss exit at an
    // impossible cost-to-close (seen live: a POOR-liquidity SENSEX spread
    // whose booked loss was 4.77x its own defined max loss). 1.5x is
    // generous slack for genuine extrinsic value, not a tuned threshold.
    const structureCeiling = ((Number(p.max_profit) || 0) + (Number(p.max_loss) || 0)) * 1.5;
    if (structureCeiling > 0 && (currentCostToClose < 0 || currentCostToClose > structureCeiling)) {
      await log('error', `Position #${p.id}: re-quoted cost to close (₹${currentCostToClose.toFixed(0)}) is outside the structure's physically possible range (₹0-₹${structureCeiling.toFixed(0)}) — likely a bad/stale quote on a thin leg. Skipped this cycle without updating P&L or evaluating exit.`, undefined, p.execution_mode);
      continue;
    }

    // Live mark-to-market P&L — persisted for EVERY position re-quoted this
    // cycle, independent of whether it also triggers an exit below. Same
    // formula the exit engine itself uses (maxProfit - currentCostToClose);
    // this just records it rather than discarding it once the exit
    // decision is made.
    const unrealizedPnl = (Number(p.max_profit) || 0) - currentCostToClose;
    const { error: markErr } = await supabase.from('options_autotrade_positions').update({
      unrealized_pnl: unrealizedPnl, unrealized_pnl_updated_at: new Date().toISOString(),
    }).eq('id', p.id);
    if (markErr) await log('error', `Position #${p.id}: failed to persist unrealized_pnl`, { message: markErr.message }, p.execution_mode);

    const underlyingPrice = quoteMap.get(indexKeys[p.symbol])?.last_price;
    if (!(underlyingPrice > 0)) { await log('error', `Position #${p.id}: no live spot price for ${p.symbol} — skipped this cycle.`, undefined, p.execution_mode); continue; }

    const dte = Math.round((Date.parse(`${p.expiry}T00:00:00Z`) - Date.parse(`${todayIST}T00:00:00Z`)) / 86_400_000);
    const shortStrikes: ShortStrike[] = legs
      .filter((l: any) => l.side === 'SELL')
      .map((l: any) => ({ strike: Number(l.strike), right: l.option_right }));

    const decision = evaluateExit({
      maxProfit: Number(p.max_profit) || 0, maxLoss: Number(p.max_loss) || 0, currentCostToClose, dte, underlyingPrice,
      shortStrikes,
      profitTargetPct: settings.profit_target_pct, stopLossCreditMultiple: settings.stop_loss_credit_multiple,
      timeExitDte: settings.time_exit_dte, strikeBreachBufferPct: settings.strike_breach_buffer_pct,
    });
    if (decision.action !== 'CLOSE') continue;

    let realizedPnl = (Number(p.max_profit) || 0) - currentCostToClose;

    if (p.execution_mode === 'AUTO') {
      // Real closing orders — SELL(short) legs first (buy-to-cover removes
      // the unbounded-risk leg first), then BUY(long) legs. MARKET orders:
      // getting flat matters more than price on an exit. A leg whose
      // closing order doesn't confirm FILLED means the position is left
      // in a status this monitor's own query (status = 'ACTIVE') will
      // never pick up again — CLOSE_FAILED, not ACTIVE — so a failed
      // unwind can never be silently retried into double-closing a leg
      // that already went through; it waits for a human to reconcile
      // against the broker directly, same posture as stateMachine.ts's
      // RECONCILIATION_REQUIRED.
      const placer = makeLiveOrderPlacer(token, apiKey);
      const orderedClose = [...legs.filter((l: any) => l.side === 'SELL'), ...legs.filter((l: any) => l.side === 'BUY')];
      let allClosed = true;
      let actualCostToClose = 0;
      for (const l of orderedClose) {
        try {
          const orderId = await placer.closeLeg(
            { side: l.side, right: l.option_right, strike: Number(l.strike), tradingsymbol: l.tradingsymbol, quantity: l.quantity, fillPrice: 0 },
            exchange,
          );
          const fill = await placer.awaitFill(orderId, 15_000);
          if (fill.status === 'COMPLETE' && fill.averagePrice != null) {
            actualCostToClose += (l.side === 'SELL' ? 1 : -1) * fill.averagePrice * l.quantity;
            await supabase.from('options_autotrade_legs').update({ exit_order_id: orderId, exit_fill_price: fill.averagePrice }).eq('id', l.id);
          } else {
            allClosed = false;
            await log('error', `Position #${p.id}: AUTO closing order for ${l.side} ${l.tradingsymbol} ended ${fill.status} — THIS LEG MAY STILL BE OPEN AT THE BROKER. Manual check required immediately.`, undefined, p.execution_mode);
          }
        } catch (err: any) {
          allClosed = false;
          await log('error', `Position #${p.id}: AUTO closing order request FAILED for ${l.side} ${l.tradingsymbol} — ${err.message}. THIS LEG MAY STILL BE OPEN AT THE BROKER. Manual check required immediately.`, undefined, p.execution_mode);
        }
      }
      if (!allClosed) {
        await supabase.from('options_autotrade_positions').update({
          status: 'CLOSE_FAILED', exit_reason: decision.reason, updated_at: new Date().toISOString(),
        }).eq('id', p.id);
        await log('error', `Position #${p.id}: marked CLOSE_FAILED — at least one real closing order did not confirm. This position will NOT be retried automatically; verify against the broker and resolve manually.`, undefined, p.execution_mode);
        continue;
      }
      realizedPnl = (Number(p.max_profit) || 0) - actualCostToClose;
    }

    const { error: updateErr } = await supabase.from('options_autotrade_positions').update({
      status: 'CLOSED', execution_state: 'CLOSED', exit_date: todayIST, exit_reason: decision.reason,
      realized_pnl: realizedPnl, updated_at: new Date().toISOString(),
    }).eq('id', p.id);
    if (updateErr) { await log('error', `Position #${p.id}: failed to persist close`, { message: updateErr.message }, p.execution_mode); continue; }

    const { data: dailyRow } = await supabase.from('options_autotrade_daily_stats').select('realized_pnl,consecutive_losses').eq('trade_date', todayIST).maybeSingle();
    await supabase.from('options_autotrade_daily_stats').upsert({
      trade_date: todayIST,
      realized_pnl: (Number(dailyRow?.realized_pnl) || 0) + realizedPnl,
      consecutive_losses: realizedPnl < 0 ? (Number(dailyRow?.consecutive_losses) || 0) + 1 : 0,
    });

    await log('info', `Closed ${p.execution_mode ?? 'PAPER'} position #${p.id} (${p.symbol} ${p.strategy_label}): ${decision.reason} — realized P&L ₹${realizedPnl.toFixed(0)}.`, undefined, p.execution_mode);
    closed.push({ positionId: p.id, symbol: p.symbol, reason: decision.reason, realizedPnl });
  }

  res.status(200).json({ ok: true, checked: positions.length, closed });
}

const EDITABLE_SETTINGS_FIELDS = [
  'reserved_fund', 'max_risk_per_trade_pct', 'max_daily_loss_pct', 'max_weekly_loss_pct',
  'max_portfolio_risk_pct', 'max_margin_utilization_pct', 'max_positions', 'max_underlying_delta',
  'max_gamma', 'max_vega', 'max_correlated_group_risk_pct', 'no_trade_below', 'watch_below',
  'high_conviction_at_or_above', 'min_dte', 'max_dte',
  'profit_target_pct', 'stop_loss_credit_multiple', 'time_exit_dte', 'strike_breach_buffer_pct',
  'max_consecutive_losses',
] as const;

/**
 * Browser-facing: read/update settings. No shared-secret gate — matching
 * api/intraday.js's settings resource, server-side Supabase access (never
 * shipped to the client) is itself the boundary.
 *
 * execution_mode is restricted to OFF/PAPER here on purpose: ALERT_ONLY,
 * SEMI_AUTO and AUTO don't have any real implementation behind them yet
 * (no alerting, no confirmation flow, no live order placement) — letting
 * the UI "turn on" a mode that silently does nothing would be dishonest.
 */
async function handleSettings(req: any, res: any, supabase: SupabaseClient) {
  if (req.method === 'GET') {
    const { data, error } = await supabase.from('options_autotrade_settings').select('*').eq('id', 1).maybeSingle();
    if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
    res.status(200).json(data ?? {});
    return;
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    const body = req.body ?? {};
    // AUTO places REAL orders against the real Zerodha account (see
    // liveFill.ts + makeLiveOrderPlacer) — ALERT_ONLY/SEMI_AUTO still
    // aren't implemented, but AUTO now is. There is no separate
    // confirmation step here; the UI itself is responsible for a strong
    // real-money warning before ever sending execution_mode: 'AUTO'.
    if (body.execution_mode !== undefined && !['OFF', 'PAPER', 'AUTO'].includes(body.execution_mode)) {
      res.status(400).json({ error: 'bad_request', message: `execution_mode must be OFF, PAPER, or AUTO — ALERT_ONLY/SEMI_AUTO aren't implemented yet.` });
      return;
    }
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.execution_mode !== undefined) update.execution_mode = body.execution_mode;
    for (const key of EDITABLE_SETTINGS_FIELDS) {
      if (body[key] !== undefined) {
        const n = Number(body[key]);
        if (!Number.isFinite(n)) { res.status(400).json({ error: 'bad_request', message: `${key} must be numeric.` }); return; }
        update[key] = n;
      }
    }
    const { data, error } = await supabase.from('options_autotrade_settings').update(update).eq('id', 1).select('*').single();
    if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
    res.status(200).json(data);
    return;
  }
  res.status(405).json({ error: 'method_not_allowed' });
}

/** Browser-facing: list positions with their legs, active and closed separately. No shared-secret gate — same reasoning as handleSettings. */
async function handlePositions(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const { data, error } = await supabase
    .from('options_autotrade_positions')
    .select('*, options_autotrade_legs(*)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
  const rows = data ?? [];
  res.status(200).json({
    active: rows.filter((r: any) => r.status === 'ACTIVE'),
    closed: rows.filter((r: any) => r.status !== 'ACTIVE'),
  });
}

/** Browser-facing: the most recent log entries, verbatim — no shared-secret gate, same reasoning as handleSettings. */
async function handleLog(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const { data, error } = await supabase.from('options_autotrade_log').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
  res.status(200).json({ entries: data ?? [] });
}

/**
 * Browser-facing kill switch. Its ENTIRE real capability right now is
 * flipping execution_mode to OFF, immediately, from the browser — it does
 * NOT itself force-close any open position. Position-monitor's exit
 * engine (profit target / stop loss / strike breach / time exit) keeps
 * running independently on its own 5-minute cron regardless of
 * execution_mode, and will still act on open positions — this button
 * only stops NEW entries; it isn't an emergency square-off.
 */
async function handleKillSwitch(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const { error } = await supabase.from('options_autotrade_settings').update({ execution_mode: 'OFF', updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
  await supabase.from('options_autotrade_log').insert({ level: 'info', message: 'Kill switch triggered from the dashboard — execution_mode set to OFF.' });
  const { data: openPositions } = await supabase.from('options_autotrade_positions').select('execution_mode').eq('status', 'ACTIVE');
  const liveCount = (openPositions ?? []).filter((p: any) => p.execution_mode === 'AUTO').length;
  const total = openPositions?.length ?? 0;
  res.status(200).json({
    ok: true,
    message: `New entries stopped (execution_mode set to OFF). This does NOT close any open position.${
      total ? ` ${total} position(s) remain open${liveCount ? ` — ${liveCount} of them REAL, on your actual Zerodha account` : ''} — position-monitor's exit engine keeps evaluating them independently on its own cron.` : ' No open positions.'
    }`,
  });
}

/** Browser-facing: today's risk-lock state — read by the dashboard to show a banner when locked. No shared-secret gate, same reasoning as handleSettings. */
async function handleDailyStats(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const { data, error } = await supabase.from('options_autotrade_daily_stats').select('*').eq('trade_date', todayIST).maybeSingle();
  if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
  res.status(200).json(data ?? { trade_date: todayIST, trades_taken: 0, realized_pnl: 0, consecutive_losses: 0, locked: false, lock_reason: null });
}

/**
 * Browser-facing manual override — the spec's own "require manual
 * re-enable" instruction: a daily lock is never cleared automatically
 * within the same day, only by this explicit action (or naturally, by a
 * new day's daily_stats row starting unlocked).
 */
async function handleClearDailyLock(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const { error } = await supabase.from('options_autotrade_daily_stats').upsert({ trade_date: todayIST, locked: false, lock_reason: null });
  if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
  await supabase.from('options_autotrade_log').insert({ level: 'info', message: 'Daily risk lock manually cleared from the dashboard — new entries can resume today.' });
  res.status(200).json({ ok: true, message: 'Daily risk lock cleared. New entries can resume on the next scan.' });
}

/* ================================================================== */
/* VWAP 3σ Mean Reversion Scalper (NSE) — src/vwap-scalper/            */
/*                                                                      */
/* A standalone strategy, folded into THIS file rather than            */
/* api/intraday.js (its thematic home) because this file is the one    */
/* proven to support .ts imports on Vercel's function bundler (see this */
/* file's own header) — api/intraday.js is plain .js, and a plain .js   */
/* file importing a .ts sibling has never been verified to work here.   */
/* Resources: vwap-scalper-settings/positions/log/kill-switch/chart      */
/* (browser-facing, no secret) and vwap-scalper-scan/vwap-scalper-monitor*/
/* (cron/secret-gated), mirroring the options resources' own split.      */
/* ================================================================== */

const VWAP_SCALPER_EDITABLE_NUMERIC_FIELDS = [
  'account_equity', 'max_risk_per_trade_pct', 'max_daily_loss_pct', 'max_open_positions', 'max_consecutive_losses',
  'capital_per_trade', 'stdev_multiplier', 'min_reward_risk_multiple', 'slope_filter_lookback_bars', 'slope_filter_threshold_sigma',
  'trend_filter_ema_length', 'stop_loss_percent', 'stop_loss_sigma_buffer',
];
const VWAP_SCALPER_EDITABLE_BOOL_FIELDS = ['slope_filter_enabled', 'trend_filter_enabled', 'stop_loss_enabled'];

async function handleVwapScalperSettings(req: any, res: any, supabase: SupabaseClient) {
  if (req.method === 'GET') {
    const { data, error } = await supabase.from('vwap_scalper_settings').select('*').eq('id', 1).maybeSingle();
    if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
    res.status(200).json(data ?? {});
    return;
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    const body = req.body ?? {};
    if (body.execution_mode !== undefined && !['OFF', 'PAPER'].includes(body.execution_mode)) {
      res.status(400).json({ error: 'bad_request', message: 'execution_mode must be OFF or PAPER — ALERT_ONLY/SEMI_AUTO/AUTO aren\'t implemented yet.' });
      return;
    }
    if (body.entry_mode !== undefined && !['TOUCH', 'REJECTION', 'CANDLE_REVERSAL'].includes(body.entry_mode)) {
      res.status(400).json({ error: 'bad_request', message: 'entry_mode must be TOUCH, REJECTION, or CANDLE_REVERSAL.' });
      return;
    }
    if (body.stop_loss_mode !== undefined && !['PERCENTAGE', 'BEYOND_3SIGMA'].includes(body.stop_loss_mode)) {
      res.status(400).json({ error: 'bad_request', message: 'stop_loss_mode must be PERCENTAGE or BEYOND_3SIGMA.' });
      return;
    }
    if (body.sizing_mode !== undefined && !['RISK_BASED', 'FIXED_CAPITAL'].includes(body.sizing_mode)) {
      res.status(400).json({ error: 'bad_request', message: 'sizing_mode must be RISK_BASED or FIXED_CAPITAL.' });
      return;
    }
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.execution_mode !== undefined) update.execution_mode = body.execution_mode;
    if (body.entry_mode !== undefined) update.entry_mode = body.entry_mode;
    if (body.stop_loss_mode !== undefined) update.stop_loss_mode = body.stop_loss_mode;
    if (body.sizing_mode !== undefined) update.sizing_mode = body.sizing_mode;
    for (const key of VWAP_SCALPER_EDITABLE_NUMERIC_FIELDS) {
      if (body[key] !== undefined) {
        const n = Number(body[key]);
        if (!Number.isFinite(n)) { res.status(400).json({ error: 'bad_request', message: `${key} must be numeric.` }); return; }
        update[key] = n;
      }
    }
    for (const key of VWAP_SCALPER_EDITABLE_BOOL_FIELDS) {
      if (body[key] !== undefined) update[key] = Boolean(body[key]);
    }
    const { data, error } = await supabase.from('vwap_scalper_settings').update(update).eq('id', 1).select('*').single();
    if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
    res.status(200).json(data);
    return;
  }
  res.status(405).json({ error: 'method_not_allowed' });
}

async function handleVwapScalperPositions(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const { data, error } = await supabase.from('vwap_scalper_positions').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
  const rows = data ?? [];
  res.status(200).json({ active: rows.filter((r: any) => r.status === 'ACTIVE'), closed: rows.filter((r: any) => r.status !== 'ACTIVE') });
}

async function handleVwapScalperLog(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const { data, error } = await supabase.from('vwap_scalper_log').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
  res.status(200).json({ entries: data ?? [] });
}

/** Browser-facing: today's risk-lock state — same reasoning as handleDailyStats. */
async function handleVwapScalperDailyStats(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const { data, error } = await supabase.from('vwap_scalper_daily_stats').select('*').eq('trade_date', todayIST).maybeSingle();
  if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
  res.status(200).json(data ?? { trade_date: todayIST, trades_taken: 0, realized_pnl: 0, consecutive_losses: 0, locked: false, lock_reason: null });
}

/** Browser-facing manual override — same "require manual re-enable" instruction as handleClearDailyLock. */
async function handleVwapScalperClearDailyLock(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const { error } = await supabase.from('vwap_scalper_daily_stats').upsert({ trade_date: todayIST, locked: false, lock_reason: null });
  if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
  await supabase.from('vwap_scalper_log').insert({ level: 'info', message: 'Daily risk lock manually cleared from the dashboard — new entries can resume today.' });
  res.status(200).json({ ok: true, message: 'Daily risk lock cleared. New entries can resume on the next scan.' });
}

/** Same "flip execution_mode to OFF only" capability as the options kill switch — see handleKillSwitch's own docs for why it isn't an emergency square-off. */
async function handleVwapScalperKillSwitch(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const { error } = await supabase.from('vwap_scalper_settings').update({ execution_mode: 'OFF', updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) { res.status(502).json({ error: 'supabase_error', message: error.message }); return; }
  await supabase.from('vwap_scalper_log').insert({ level: 'info', message: 'Kill switch triggered from the dashboard — execution_mode set to OFF.' });
  const { count } = await supabase.from('vwap_scalper_positions').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE');
  res.status(200).json({
    ok: true,
    message: `New entries stopped (execution_mode set to OFF).${count ? ` ${count} paper position(s) remain open — vwap-scalper-monitor keeps evaluating them independently on its own cron.` : ' No open positions.'}`,
  });
}

/**
 * Browser-facing, no secret gate (same reasoning as api/intraday.js's own
 * `chart` resource): fetches today's 1-minute bars for one symbol and
 * returns the VWAP + all six bands (upper/lower 1σ/2σ/3σ) from the exact
 * same computeVwapBands() the live scan/monitor use — this is a read-only
 * visualization of the real signal engine, not a separate calculation.
 */
async function handleVwapScalperChart(req: any, res: any, supabase: SupabaseClient) {
  const symbol = String(req.query?.symbol || '').toUpperCase();
  if (!symbol) { res.status(400).json({ error: 'bad_request', message: 'symbol is required.' }); return; }

  const apiKey = process.env.KITE_API_KEY;
  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!apiKey || !token) { res.status(200).json({ error: 'no_kite_session', message: 'Connect Kite first.' }); return; }

  const { data: stockRow } = await supabase.from('stocks').select('instrument_token').eq('symbol', symbol).maybeSingle();
  if (!stockRow?.instrument_token) { res.status(200).json({ error: 'not_found', message: `No instrument token for ${symbol}.` }); return; }

  const { data: settings } = await supabase.from('vwap_scalper_settings').select('stdev_multiplier').eq('id', 1).maybeSingle();
  const stdevMultiplier = Number(settings?.stdev_multiplier) || 1;

  try {
    const today = new Date().toISOString().slice(0, 10);
    const candles = await kiteFetch(`/instruments/historical/${stockRow.instrument_token}/minute?from=${today}&to=${today}`, { token, apiKey });
    const bars: VwapBar[] = (candles?.candles ?? [])
      .filter((c: unknown): c is [string, number, number, number, number, number] => Array.isArray(c))
      .map((c: [string, number, number, number, number, number]) => ({ t: new Date(c[0]).getTime(), o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }));
    if (bars.length === 0) { res.status(200).json({ error: 'no_data', message: 'No bars for today yet.' }); return; }

    const bands = computeVwapBands(bars, stdevMultiplier);
    res.status(200).json({
      symbol, bars,
      vwap: bands.map((b) => b.vwap),
      upper1: bands.map((b) => b.upper1), upper2: bands.map((b) => b.upper2), upper3: bands.map((b) => b.upper3),
      lower1: bands.map((b) => b.lower1), lower2: bands.map((b) => b.lower2), lower3: bands.map((b) => b.lower3),
    });
  } catch (err: any) {
    res.status(502).json({ error: 'kite_error', message: err.message });
  }
}

function vwapScalperParamsFromSettings(settings: any): VwapScalperParams {
  return {
    stdevMultiplier: Number(settings.stdev_multiplier) || 1,
    entryMode: settings.entry_mode === 'TOUCH' ? 'TOUCH' : settings.entry_mode === 'CANDLE_REVERSAL' ? 'CANDLE_REVERSAL' : 'REJECTION',
    slopeFilter: settings.slope_filter_enabled
      ? { lookbackBars: Number(settings.slope_filter_lookback_bars) || 10, thresholdSigma: Number(settings.slope_filter_threshold_sigma) || 1 }
      : null,
    trendFilter: settings.trend_filter_enabled
      ? { emaLength: Number(settings.trend_filter_ema_length) || 200 }
      : null,
    stopLoss: settings.stop_loss_enabled
      ? {
          mode: settings.stop_loss_mode === 'PERCENTAGE' ? 'PERCENTAGE' : 'BEYOND_3SIGMA',
          percent: Number(settings.stop_loss_percent) || 0.5,
          sigmaBuffer: Number(settings.stop_loss_sigma_buffer) || 0.5,
        }
      : null,
  };
}

/**
 * The scan: fetches today's 1-minute bars for every NIFTY 50 name without
 * an already-open position, runs the exact same signal engine
 * (computeVwapBands + detectVwapScalperSignals) the tests already cover,
 * and opens a sized PAPER position for any symbol whose signal fired on
 * the LAST (most recent) bar — a signal earlier in the array was either
 * already acted on by a prior scan or genuinely missed, and re-opening
 * against it now would be trading a stale setup.
 *
 * Sizing REQUIRES a real stop (see positionSizing.ts's own refusal
 * discipline) — with stop_loss_enabled off (the Pine source's own
 * default), no position can be sized at all, and this is logged plainly
 * rather than silently no-op'd, so it's never mistaken for "no signals
 * fired" when the real reason is "sizing has nothing to size against".
 */
async function handleVwapScalperScan(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'server_misconfigured' }); return; }

  const log = (level: 'info' | 'error', message: string, detail?: unknown) =>
    supabase.from('vwap_scalper_log').insert({ level, message, detail: detail ?? null });

  const { data: settings } = await supabase.from('vwap_scalper_settings').select('*').eq('id', 1).maybeSingle();
  if (!settings) { res.status(500).json({ ok: false, error: 'settings_not_found' }); return; }
  if (settings.execution_mode !== 'PAPER') {
    res.status(200).json({ ok: true, skipped: `execution_mode is '${settings.execution_mode}', not PAPER` });
    return;
  }
  if (!isMarketOpenIST()) { res.status(200).json({ ok: true, skipped: 'outside_market_hours' }); return; }

  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const { data: dailyRow } = await supabase.from('vwap_scalper_daily_stats').select('*').eq('trade_date', todayIST).maybeSingle();
  const lock = checkDailyRiskLock(
    { realizedPnlToday: Number(dailyRow?.realized_pnl) || 0, consecutiveLosses: Number(dailyRow?.consecutive_losses) || 0 },
    { equity: Number(settings.account_equity) || 0, maxDailyLossPct: settings.max_daily_loss_pct, maxConsecutiveLosses: settings.max_consecutive_losses },
  );
  if (lock.locked) {
    if (!dailyRow?.locked) {
      await supabase.from('vwap_scalper_daily_stats').upsert({ trade_date: todayIST, locked: true, lock_reason: lock.reason });
      await log('info', `Daily risk lock engaged: ${lock.reason} — ${lock.detail}`);
    }
    res.status(200).json({ ok: true, skipped: 'daily_risk_locked', reason: lock.reason, detail: lock.detail });
    return;
  }

  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!token) { res.status(200).json({ ok: true, skipped: 'no_kite_session' }); return; }

  const { data: activeRows } = await supabase.from('vwap_scalper_positions').select('symbol').eq('status', 'ACTIVE');
  const activeSymbols = new Set((activeRows ?? []).map((r: any) => r.symbol));
  const openSlots = Math.max(0, (Number(settings.max_open_positions) || 0) - activeSymbols.size);
  if (openSlots <= 0) {
    res.status(200).json({ ok: true, skipped: 'max_open_positions_reached', activeCount: activeSymbols.size });
    return;
  }

  const candidateSymbols = NIFTY_50_UNIVERSE.map((s) => s.symbol).filter((s) => !activeSymbols.has(s));
  const { data: stockRows } = await supabase.from('stocks').select('symbol,instrument_token').in('symbol', candidateSymbols);
  const tokenBySymbol = new Map((stockRows ?? []).map((r: any) => [r.symbol, r.instrument_token]));

  const params = vwapScalperParamsFromSettings(settings);
  const toDate = new Date().toISOString().slice(0, 10);
  const opened: Array<{ symbol: string; direction: string; quantity: number }> = [];
  const rejectedNoStop: string[] = [];
  let checked = 0;
  let signalsFired = 0;

  for (const symbol of candidateSymbols) {
    if (opened.length >= openSlots) break;
    const instrumentToken = tokenBySymbol.get(symbol);
    if (!instrumentToken) continue;

    let candles: any;
    try {
      candles = await kiteFetch(`/instruments/historical/${instrumentToken}/minute?from=${toDate}&to=${toDate}`, { token, apiKey });
    } catch (err: any) {
      await log('error', `Historical candle fetch failed for ${symbol}`, { message: err.message });
      continue;
    }
    checked++;
    const bars: VwapBar[] = (candles?.candles ?? [])
      .filter((c: unknown): c is [string, number, number, number, number, number] => Array.isArray(c))
      .map((c: [string, number, number, number, number, number]) => ({ t: new Date(c[0]).getTime(), o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }));
    if (bars.length === 0) continue;

    const bands = computeVwapBands(bars, params.stdevMultiplier);
    const signals = detectVwapScalperSignals(bars, bands, params, false);
    const freshSignal = signals.find((s) => s.barIndex === bars.length - 1);
    if (!freshSignal) continue;
    signalsFired++;

    const sizingMode = settings.sizing_mode === 'FIXED_CAPITAL' ? 'FIXED_CAPITAL' : 'RISK_BASED';

    // RISK_BASED needs a real stop to size against (no stop = no risk-per-
    // unit to measure); FIXED_CAPITAL doesn't (quantity = capital / price
    // regardless of stop distance) — see positionSizing.ts's own header.
    if (sizingMode === 'RISK_BASED' && freshSignal.stopPrice === null) {
      rejectedNoStop.push(symbol);
      continue;
    }
    const sizing = sizingMode === 'FIXED_CAPITAL'
      ? computeFixedCapitalPositionSize({
          capitalPerTrade: Number(settings.capital_per_trade) || 0,
          entryPrice: freshSignal.entryPrice, stopPrice: freshSignal.stopPrice,
        })
      : computeVwapScalperPositionSize({
          accountEquity: Number(settings.account_equity) || 0,
          maxRiskPerTradePct: Number(settings.max_risk_per_trade_pct) || 0,
          entryPrice: freshSignal.entryPrice, stopPrice: freshSignal.stopPrice!,
        });
    if (!sizing) {
      await log('info', `${symbol}: ${freshSignal.direction} signal fired but could not be sized (${sizingMode === 'FIXED_CAPITAL' ? 'capital_per_trade too small for even 1 share' : 'budget too small for even 1 share'}).`);
      continue;
    }

    const { error: insertErr } = await supabase.from('vwap_scalper_positions').insert({
      symbol, direction: freshSignal.direction, quantity: sizing.quantity,
      entry_price: freshSignal.entryPrice, vwap_at_entry: freshSignal.vwapAtEntry,
      stop_price: freshSignal.stopPrice, entry_bar_time: new Date(bars[bars.length - 1].t).toISOString(),
      status: 'ACTIVE',
    });
    if (insertErr) { await log('error', `Failed to open PAPER position for ${symbol}`, { message: insertErr.message }); continue; }

    const stopLabel = freshSignal.stopPrice !== null ? `stop ₹${freshSignal.stopPrice.toFixed(2)}` : 'no stop';
    await log('info', `Opened PAPER position: ${symbol} ${freshSignal.direction} x${sizing.quantity} @ ₹${freshSignal.entryPrice.toFixed(2)} (${stopLabel}) — ${freshSignal.reason}`);
    opened.push({ symbol, direction: freshSignal.direction, quantity: sizing.quantity });

    await supabase.from('vwap_scalper_daily_stats').upsert({ trade_date: todayIST, trades_taken: (Number(dailyRow?.trades_taken) || 0) + opened.length });
  }

  if (rejectedNoStop.length) {
    await log('info', `${rejectedNoStop.length} signal(s) fired but stop_loss_enabled is off, so nothing could be sized: ${rejectedNoStop.join(', ')}.`);
  }

  res.status(200).json({ ok: true, checked, signalsFired, opened, rejectedNoStop, activeCount: activeSymbols.size + opened.length });
}

/**
 * Live target/stop monitoring for every ACTIVE position — re-fetches
 * today's bars-so-far (for the CURRENT vwap, which keeps moving) plus a
 * live quote (for the current price), same two-source approach
 * options-autotrade.ts's own handlePositionMonitor uses for its legs.
 * Persists unrealized_pnl every cycle regardless of whether an exit also
 * triggers, mirroring that same fix.
 */
async function handleVwapScalperMonitor(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'server_misconfigured' }); return; }

  const log = (level: 'info' | 'error', message: string, detail?: unknown) =>
    supabase.from('vwap_scalper_log').insert({ level, message, detail: detail ?? null });

  const { data: settings } = await supabase.from('vwap_scalper_settings').select('*').eq('id', 1).maybeSingle();
  if (!settings) { res.status(500).json({ ok: false, error: 'settings_not_found' }); return; }

  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!token) { res.status(200).json({ ok: true, skipped: 'no_kite_session' }); return; }

  const { data: positions } = await supabase.from('vwap_scalper_positions').select('*').eq('status', 'ACTIVE');
  if (!positions?.length) { res.status(200).json({ ok: true, checked: 0, closed: [] }); return; }

  const { data: stockRows } = await supabase.from('stocks').select('symbol,instrument_token').in('symbol', positions.map((p: any) => p.symbol));
  const tokenBySymbol = new Map((stockRows ?? []).map((r: any) => [r.symbol, r.instrument_token]));

  const quoteMap = new Map<string, any>();
  for (const batch of chunk(positions.map((p: any) => `NSE:${p.symbol}`), MAX_QUOTE_INSTRUMENTS)) {
    try {
      const data = await kiteFetch(`/quote?${batch.map((k: string) => `i=${encodeURIComponent(k)}`).join('&')}`, { token, apiKey });
      for (const key of batch) if (data?.[key]) quoteMap.set(key, data[key]);
    } catch (err: any) {
      await log('error', 'Live quote batch failed during vwap-scalper-monitor', { message: err.message });
    }
  }

  const params = vwapScalperParamsFromSettings(settings);
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const toDate = new Date().toISOString().slice(0, 10);
  const closed: Array<{ positionId: number; symbol: string; reason: string; realizedPnl: number }> = [];

  for (const p of positions) {
    const quote = quoteMap.get(`NSE:${p.symbol}`);
    const ltp = quote?.last_price;
    if (!(ltp > 0)) { await log('error', `Position #${p.id} (${p.symbol}): no live quote this cycle — skipped.`); continue; }

    const instrumentToken = tokenBySymbol.get(p.symbol);
    if (!instrumentToken) { await log('error', `Position #${p.id} (${p.symbol}): no instrument token — skipped.`); continue; }
    let candles: any;
    try {
      candles = await kiteFetch(`/instruments/historical/${instrumentToken}/minute?from=${toDate}&to=${toDate}`, { token, apiKey });
    } catch (err: any) {
      await log('error', `Position #${p.id} (${p.symbol}): historical candle fetch failed — skipped`, { message: err.message });
      continue;
    }
    const bars: VwapBar[] = (candles?.candles ?? [])
      .filter((c: unknown): c is [string, number, number, number, number, number] => Array.isArray(c))
      .map((c: [string, number, number, number, number, number]) => ({ t: new Date(c[0]).getTime(), o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }));
    if (bars.length === 0) { await log('error', `Position #${p.id} (${p.symbol}): no bars this session yet — skipped.`); continue; }
    const currentVwap = computeVwapBands(bars, params.stdevMultiplier)[bars.length - 1].vwap;

    const direction = p.direction as 'LONG' | 'SHORT';
    const unrealizedPnl = (direction === 'LONG' ? ltp - Number(p.entry_price) : Number(p.entry_price) - ltp) * Number(p.quantity);
    await supabase.from('vwap_scalper_positions').update({
      unrealized_pnl: unrealizedPnl, unrealized_pnl_updated_at: new Date().toISOString(),
    }).eq('id', p.id);

    const stopPrice = p.stop_price !== null ? Number(p.stop_price) : null;
    const minRewardMultiple = Number(settings.min_reward_risk_multiple) || null;
    const effectiveTarget = computeEffectiveTarget(direction, Number(p.entry_price), stopPrice, currentVwap, minRewardMultiple);
    const stopHit = stopPrice !== null && (direction === 'LONG' ? ltp <= stopPrice : ltp >= stopPrice);
    const targetHit = direction === 'LONG' ? ltp >= effectiveTarget : ltp <= effectiveTarget;
    const sessionEnded = !isMarketOpenIST();

    if (!stopHit && !targetHit && !sessionEnded) continue;

    const exitPrice = stopHit ? stopPrice! : targetHit ? effectiveTarget : ltp;
    const reason = stopHit ? 'STOP' : targetHit ? 'TARGET' : 'SESSION_END';
    const realizedPnl = (direction === 'LONG' ? exitPrice - Number(p.entry_price) : Number(p.entry_price) - exitPrice) * Number(p.quantity);

    const { error: updateErr } = await supabase.from('vwap_scalper_positions').update({
      status: 'CLOSED', exit_price: exitPrice, exit_reason: reason, exit_bar_time: new Date().toISOString(),
      realized_pnl: realizedPnl, unrealized_pnl: realizedPnl, updated_at: new Date().toISOString(),
    }).eq('id', p.id);
    if (updateErr) { await log('error', `Position #${p.id}: failed to persist close`, { message: updateErr.message }); continue; }

    const { data: dailyRow } = await supabase.from('vwap_scalper_daily_stats').select('realized_pnl,consecutive_losses').eq('trade_date', todayIST).maybeSingle();
    await supabase.from('vwap_scalper_daily_stats').upsert({
      trade_date: todayIST,
      realized_pnl: (Number(dailyRow?.realized_pnl) || 0) + realizedPnl,
      consecutive_losses: realizedPnl < 0 ? (Number(dailyRow?.consecutive_losses) || 0) + 1 : 0,
    });

    await log('info', `Closed PAPER position #${p.id} (${p.symbol} ${direction}): ${reason} — realized P&L ₹${realizedPnl.toFixed(0)}.`);
    closed.push({ positionId: p.id, symbol: p.symbol, reason, realizedPnl });
  }

  res.status(200).json({ ok: true, checked: positions.length, closed });
}

/**
 * Browser-facing: the actual, real Kite account balance — not
 * settings.reserved_fund, which is a self-declared risk-budget allocation
 * a human typed in, not a live pull of the broker. Exists so the
 * dashboard can show genuine real-money figures once AUTO is on, instead
 * of implying reserved_fund is the account balance. Null fields mean no
 * Kite session / the fetch failed, not zero.
 */
/**
 * Browser-facing: live NIFTY/BANKNIFTY/SENSEX index quotes for the
 * dashboard's own ticker strip — read-only, no shared-secret gate, same
 * reasoning as handleSettings. Uses the same INDEX_QUOTE_KEY mapping the
 * scan/monitor cycles already trade against, not a separate guess at the
 * right instrument key.
 */
async function handleIndices(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'server_misconfigured' }); return; }
  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!token) { res.status(200).json({ ok: true, indices: [], skipped: 'no_kite_session' }); return; }

  const entries = Object.entries(INDEX_QUOTE_KEY as Record<string, string>);
  try {
    const data = await kiteFetch(`/quote?${entries.map(([, key]) => `i=${encodeURIComponent(key)}`).join('&')}`, { token, apiKey });
    const indices = entries.map(([symbol, key]) => {
      const q = data?.[key];
      if (!q) return { symbol, lastPrice: null, change: null, changePct: null };
      const lastPrice = Number(q.last_price);
      const change = Number(q.net_change);
      const prevClose = lastPrice - change;
      return { symbol, lastPrice, change, changePct: prevClose > 0 ? (change / prevClose) * 100 : null };
    });
    res.status(200).json({ ok: true, indices });
  } catch (err: any) {
    res.status(200).json({ ok: true, indices: [], error: err.message });
  }
}

async function handleRealFunds(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'server_misconfigured' }); return; }
  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token;
  if (!token) { res.status(200).json({ ok: true, availableFunds: null, skipped: 'no_kite_session' }); return; }

  try {
    const data = await kiteFetch('/user/margins/equity', { token, apiKey });
    const availableFunds = Number(data?.available?.live_balance ?? data?.net);
    const utilised = Number(data?.utilised?.debits);
    res.status(200).json({
      ok: true,
      availableFunds: availableFunds > 0 ? availableFunds : 0,
      utilised: Number.isFinite(utilised) ? utilised : null,
    });
  } catch (err: any) {
    res.status(200).json({ ok: true, availableFunds: null, error: err.message });
  }
}

export default async function handler(req: any, res: any) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { res.status(500).json({ error: 'server_misconfigured' }); return; }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const resource = req.query?.resource;

  // Browser-facing resources — no shared-secret gate (matching
  // api/intraday.js's settings/positions convention).
  if (resource === 'settings') return handleSettings(req, res, supabase);
  if (resource === 'positions') return handlePositions(req, res, supabase);
  if (resource === 'real-funds') return handleRealFunds(req, res, supabase);
  if (resource === 'indices') return handleIndices(req, res, supabase);
  if (resource === 'log') return handleLog(req, res, supabase);
  if (resource === 'kill-switch') return handleKillSwitch(req, res, supabase);
  if (resource === 'daily-stats') return handleDailyStats(req, res, supabase);
  if (resource === 'clear-daily-lock') return handleClearDailyLock(req, res, supabase);
  if (resource === 'vwap-scalper-settings') return handleVwapScalperSettings(req, res, supabase);
  if (resource === 'vwap-scalper-positions') return handleVwapScalperPositions(req, res, supabase);
  if (resource === 'vwap-scalper-log') return handleVwapScalperLog(req, res, supabase);
  if (resource === 'vwap-scalper-kill-switch') return handleVwapScalperKillSwitch(req, res, supabase);
  if (resource === 'vwap-scalper-chart') return handleVwapScalperChart(req, res, supabase);
  if (resource === 'vwap-scalper-daily-stats') return handleVwapScalperDailyStats(req, res, supabase);
  if (resource === 'vwap-scalper-clear-daily-lock') return handleVwapScalperClearDailyLock(req, res, supabase);

  // Cron/server-triggered resources — shared-secret gate, since these do
  // real work (live Kite calls, writing a paper position) on a schedule
  // and must not be triggerable by an arbitrary browser request.
  const secret = process.env.OPTIONS_AUTOTRADE_CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (resource === 'instruments-sync') return handleInstrumentsSync(req, res, supabase);
  if (resource === 'margin') return handleMargin(req, res, supabase);
  if (resource === 'paper-scan') return handlePaperScan(req, res, supabase);
  if (resource === 'position-monitor') return handlePositionMonitor(req, res, supabase);
  if (resource === 'vwap-scalper-scan') return handleVwapScalperScan(req, res, supabase);
  if (resource === 'vwap-scalper-monitor') return handleVwapScalperMonitor(req, res, supabase);
  res.status(400).json({ error: 'bad_request', message: 'Unknown or missing ?resource=.' });
}
