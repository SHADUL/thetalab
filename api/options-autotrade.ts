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
import { randomUUID } from 'node:crypto';
import { decideTrade, type DecisionThresholds } from '../src/quant/strategies/decisionGate.ts';
import { computePositionSize, type PortfolioState, type OpenPositionSummary } from '../src/quant/strategies/positionSizing.ts';
import { runPreTradeValidation } from '../src/quant/execution/preTradeValidation.ts';
import { runPaperExecution, type PlannedLeg } from '../src/quant/execution/paperFill.ts';
import { runLiveExecution, type LiveOrderPlacer } from '../src/quant/execution/liveFill.ts';
import { evaluateExit, type ShortStrike } from '../src/quant/execution/exitEngine.ts';
import { checkDailyRiskLock } from '../src/quant/execution/dailyRiskLock.ts';
import { claimOrderIntent, supabaseOrderIntentStore } from '../src/quant/execution/orderIntent.ts';
import { runShadowExecutionForLegs, isEligibleForForwardValidation } from '../src/quant/execution/shadowExecution.ts';
import { supabaseShadowRepository, dedupeIvHistoryRows, type OptionChainSnapshotRow, type IvHistoryRow, type ExecutionQualityRow } from '../src/quant/execution/shadowRepository.ts';
import { recordSignal, recordOutcome, supabaseForwardLedgerStore, type ForwardSignal } from '../src/quant/execution/forwardLedger.ts';
import { BASELINE_VERSION } from '../src/options-auto/backtest/baselineV1.ts';
import { approxTradingSessionsFromCalendarDays } from '../src/quant/analytics/timeConventions.ts';
import { isCompletedTradeEligibleForForwardValidation, buildLegQuoteFromRawKiteQuote, type RawKiteQuote } from '../src/quant/execution/shadowExecution.ts';
import { simulateShadowExitFills } from '../src/quant/execution/shadowScan.ts';
import { simulateStructureFill, SHADOW_EXECUTION_V1 } from '../src/quant/execution/fillSimulator.ts';
import { computeExecutionCostBreakdown, computeCanonicalForwardPnl, estimateTransactionCharges, EXECUTION_COST_MODEL_VERSION } from '../src/quant/execution/executionCost.ts';
import { computeShadowHealthReport, type ShadowHealthCounts } from '../src/quant/analytics/shadowHealth.ts';
import { evaluateForwardValidationReadiness } from '../src/quant/execution/readiness.ts';
import { runForwardValidationSelfTest } from '../src/quant/execution/selfTest.ts';
import { classifyShadowConsistency, buildShadowRecoveryFinalizationPlan, hasOrphanedExitTelemetry } from '../src/quant/execution/shadowConsistency.ts';
import { evaluateProtocolTimingEligibility } from '../src/quant/execution/protocolTiming.ts';
import { reconcile, type DbPositionSummary, type BrokerPosition, type BrokerOrder } from '../src/quant/execution/brokerReconciliation.ts';
import { computeVwapBands } from '../src/vwap-scalper/vwapBands.ts';
import { detectVwapScalperSignals } from '../src/vwap-scalper/signals.ts';
import { computeVwapScalperPositionSize, computeFixedCapitalPositionSize } from '../src/vwap-scalper/positionSizing.ts';
import { NIFTY_50_UNIVERSE } from '../src/vwap-scalper/nifty50Universe.ts';
import { computeEffectiveTarget } from '../src/vwap-scalper/targetAndStop.ts';
import type { Bar as VwapBar, VwapScalperParams } from '../src/vwap-scalper/types.ts';
import { createSessionToken, buildSetCookieHeader, buildClearCookieHeader, readCookie, verifySessionToken, sessionCookieName } from '../src/lib/session.ts';

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
 * Mid-price of the live bid/ask depth, falling back to last_price only
 * when depth is unavailable — matches enrich.ts's own markPricePreference
 * (['mid', 'settle', 'last']), the same convention entry pricing already
 * uses (creditSpread.ts/ironCondor.ts price every leg off markPrice).
 * position-monitor used to re-quote off last_price alone, which on a
 * thin/POOR-liquidity leg can print far to one side of a wide bid/ask
 * spread — comparing that against a mid-based entry price manufactures
 * an instant "profit" or "loss" purely from which side the last trade
 * happened to print on, not from any real price movement. Keeping both
 * ends of the same position on the same pricing convention removes that
 * artifact.
 */
function midOrLastPrice(quote: any): number | null {
  const bid = Number(quote?.depth?.buy?.[0]?.price);
  const ask = Number(quote?.depth?.sell?.[0]?.price);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  const last = Number(quote?.last_price);
  return last > 0 ? last : null;
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

    // A single, direct order-status query — used only to resolve an
    // awaitFill TIMEOUT (see liveFill.ts's header on this method). A
    // failure here is reported as UNKNOWN rather than thrown, so the
    // caller's "never retry/never assume on ambiguity" handling always
    // gets a definite (if unhelpful) answer rather than an exception to
    // separately guard against.
    async getOrderStatus(orderId) {
      try {
        const history = await kiteFetch(`/orders/${orderId}`, { token, apiKey });
        const last = Array.isArray(history) ? history[history.length - 1] : null;
        const status = last?.status as string | undefined;
        if (status === 'COMPLETE') {
          const avg = Number(last?.average_price);
          return { status: 'COMPLETE' as const, averagePrice: avg > 0 ? avg : null };
        }
        if (status === 'REJECTED') return { status: 'REJECTED' as const, averagePrice: null };
        if (status === 'CANCELLED') return { status: 'CANCELLED' as const, averagePrice: null };
        if (status === 'OPEN') return { status: 'OPEN' as const, averagePrice: null };
        if (status === 'TRIGGER PENDING') return { status: 'TRIGGER PENDING' as const, averagePrice: null };
        return { status: 'UNKNOWN' as const, averagePrice: null };
      } catch {
        return { status: 'UNKNOWN' as const, averagePrice: null };
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
 * Broker-side state for pre-entry reconciliation (QUANT_AUDIT.md Task 3).
 * Both functions return `null` on any failure — the caller (handlePaperScan)
 * treats that identically to a genuine RECONCILIATION_REQUIRED finding
 * (broker state that cannot currently be verified must block new AUTO
 * entries exactly like broker state that actively disagrees), never as
 * "assume nothing's open."
 */
async function fetchBrokerPositions(token: string, apiKey: string): Promise<BrokerPosition[] | null> {
  try {
    const data = await kiteFetch('/positions', { token, apiKey });
    const net: any[] = data?.net ?? [];
    return net
      .filter((p) => (p.exchange === 'NFO' || p.exchange === 'BFO') && Number(p.quantity) !== 0)
      .map((p) => ({ tradingsymbol: String(p.tradingsymbol), quantity: Number(p.quantity) }));
  } catch {
    return null;
  }
}

function mapKiteOrderStatus(status: string | undefined): BrokerOrder['status'] {
  switch (status) {
    case 'COMPLETE': return 'COMPLETE';
    case 'REJECTED': return 'REJECTED';
    case 'CANCELLED': return 'CANCELLED';
    case 'OPEN': return 'OPEN';
    case 'TRIGGER PENDING': return 'TRIGGER PENDING';
    default: return 'UNKNOWN';
  }
}

async function fetchBrokerOrdersToday(token: string, apiKey: string): Promise<BrokerOrder[] | null> {
  try {
    const data = await kiteFetch('/orders', { token, apiKey });
    const orders: any[] = Array.isArray(data) ? data : [];
    return orders
      .filter((o) => o.exchange === 'NFO' || o.exchange === 'BFO')
      .map((o) => ({
        orderId: String(o.order_id), tradingsymbol: String(o.tradingsymbol),
        status: mapKiteOrderStatus(o.status), transactionType: o.transaction_type === 'SELL' ? 'SELL' as const : 'BUY' as const,
        quantity: Number(o.quantity) || 0, filledQuantity: Number(o.filled_quantity) || 0,
      }));
  } catch {
    return null;
  }
}

/** DB-side inputs for reconciliation — active positions (mapped to their
    legs), positions already flagged elsewhere as needing manual reconciliation,
    and any still-open (non-terminal) order intents, ALL account-wide (not
    scoped to one symbol) — a broker-state disagreement on ANY symbol blocks
    ALL new AUTO entries, per Task 3's "BLOCK ALL NEW AUTO ENTRIES". */
async function fetchDbReconciliationInputs(supabase: SupabaseClient): Promise<{
  dbActivePositions: DbPositionSummary[]; dbPendingReconciliation: DbPositionSummary[];
  openIntents: Array<{ id: string; symbol: string; status: 'CLAIMED' | 'EXECUTING' | 'ABANDONED'; intentKey: string; ageMs: number }>;
}> {
  const toSummaries = async (statuses: string[]): Promise<DbPositionSummary[]> => {
    const { data: positions } = await supabase.from('options_autotrade_positions')
      .select('id,symbol,expiry').in('status', statuses).eq('execution_mode', 'AUTO');
    const rows = positions ?? [];
    if (!rows.length) return [];
    const ids = rows.map((p: any) => p.id);
    const { data: legs } = await supabase.from('options_autotrade_legs')
      .select('position_id,tradingsymbol,side,quantity,strike,option_right').in('position_id', ids);
    const legsByPosition = new Map<number, DbPositionSummary['legs']>();
    for (const l of legs ?? []) {
      const list = legsByPosition.get(l.position_id) ?? [];
      list.push({ tradingsymbol: l.tradingsymbol, side: l.side, quantity: l.quantity, strike: Number(l.strike), right: l.option_right });
      legsByPosition.set(l.position_id, list);
    }
    return rows.map((p: any) => ({ id: p.id, symbol: p.symbol, expiry: p.expiry, legs: legsByPosition.get(p.id) ?? [] }));
  };

  const [dbActivePositions, dbPendingReconciliation, intentRows] = await Promise.all([
    toSummaries(['ACTIVE']),
    toSummaries(['CLOSE_FAILED', 'RECONCILIATION_REQUIRED', 'PARTIALLY_FILLED']),
    supabase.from('options_autotrade_order_intents').select('id,symbol,status,intent_key,created_at')
      .in('status', ['CLAIMED', 'EXECUTING', 'ABANDONED']).eq('execution_mode', 'AUTO'),
  ]);

  const openIntents = (intentRows.data ?? []).map((r: any) => ({
    id: r.id, symbol: r.symbol, status: r.status as 'CLAIMED' | 'EXECUTING' | 'ABANDONED',
    intentKey: r.intent_key, ageMs: Date.now() - Date.parse(r.created_at),
  }));

  return { dbActivePositions, dbPendingReconciliation, openIntents };
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
  if (settings.execution_mode !== 'PAPER' && settings.execution_mode !== 'AUTO' && settings.execution_mode !== 'SHADOW') {
    res.status(200).json({ ok: true, skipped: `execution_mode is '${settings.execution_mode}', not PAPER, SHADOW or AUTO` });
    return;
  }

  // Computed once, up top, so every log entry this whole scan produces —
  // not just the ones after sizing — is tagged with the mode it actually
  // ran under. The dashboard's Activity Log filters on this exactly like
  // it already filters positions, so old PAPER chatter doesn't sit next
  // to real AUTO activity looking like it's still happening.
  const isLive = settings.execution_mode === 'AUTO';
  // SHADOW runs the exact same decision pipeline AUTO does — including
  // real-funds-based sizing, so the hypothetical order intent it records
  // is what AUTO would ACTUALLY have sized, not a reserved_fund guess —
  // but places zero broker orders (FORWARD_VALIDATION_PROTOCOL.md). It
  // deliberately does NOT go through the broker-reconciliation gate below:
  // that gate exists specifically to protect against a REAL duplicate
  // order, which cannot happen here regardless.
  const isShadow = settings.execution_mode === 'SHADOW';
  const modeLabel = isLive ? 'AUTO' : isShadow ? 'SHADOW' : 'PAPER';
  const log = (level: 'info' | 'error', message: string, detail?: unknown) =>
    supabase.from('options_autotrade_log').insert({ level, message, detail: detail ?? null, execution_mode: modeLabel });

  // Observability (QUANT_AUDIT.md Task 9): a traceable lifecycle for every
  // AUTO attempt — a stable scanId ties every event this one invocation
  // produces together, so a human reading the log can reconstruct exactly
  // what happened for one specific scan without guessing which log lines
  // belong together. Never logs secrets/tokens — `detail` here is always a
  // plain object of IDs, symbols, and human-readable strings.
  const scanId = randomUUID();
  const event = (name: string, detail?: Record<string, unknown>) =>
    log('info', `[${name}] ${symbol}`, { event: name, scanId, symbol, ...detail });
  await event('SCAN_STARTED', { executionMode: modeLabel });

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
  await event('CANDIDATE_SELECTED', {
    strategyLabel: decision.expiryEvaluation.strategyLabel, qualityScore: decision.expiryEvaluation.best.qualityScore.score,
  });

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
  // has verified the account actually holds. SHADOW sizes against the SAME
  // real balance (never reserved_fund either) so its recorded hypothetical
  // intent reflects what AUTO would actually have sized — see this file's
  // header note on isShadow above.
  const usesRealFunds = isLive || isShadow;
  const realAvailableFunds = usesRealFunds ? await fetchRealAvailableFunds(token, apiKey) : null;
  if (usesRealFunds && realAvailableFunds === null) {
    await log('error', `${modeLabel}: could not verify real account funds for ${symbol} — refusing to size or record any intent this cycle.`);
    res.status(200).json({ ok: true, action: decision.action, opened: false, skipped: 'real_funds_unavailable', diagnostics });
    return;
  }

  // Broker reconciliation gate (QUANT_AUDIT.md Task 3) — AUTO only, and
  // account-wide (not scoped to this one symbol): a disagreement between
  // this system's own records and Kite's actual order/position book on
  // ANY symbol blocks EVERY new AUTO entry this cycle, regardless of
  // which symbol is being scanned right now. This never touches an
  // existing position — it only refuses to add MORE exposure while the
  // broker's true state is uncertain.
  if (isLive) {
    const [brokerPositions, brokerOrders] = await Promise.all([
      fetchBrokerPositions(token, apiKey),
      fetchBrokerOrdersToday(token, apiKey),
    ]);
    if (brokerPositions === null || brokerOrders === null) {
      await event('BROKER_STATE_AMBIGUOUS', { reason: 'fetch_failed' });
      await log('error', `AUTO: could not verify broker positions/orders for reconciliation — refusing all new AUTO entries this cycle.`);
      res.status(200).json({ ok: true, action: decision.action, opened: false, skipped: 'broker_state_unavailable', diagnostics });
      return;
    }
    const { dbActivePositions, dbPendingReconciliation, openIntents } = await fetchDbReconciliationInputs(supabase);
    const reconciliation = reconcile({ dbActivePositions, dbPendingReconciliation, openIntents, brokerPositions, brokerOrders });
    if (reconciliation.status === 'MISMATCH' || reconciliation.status === 'RECONCILIATION_REQUIRED') {
      await event('RECONCILIATION_REQUIRED', { reconciliationStatus: reconciliation.status, findingCount: reconciliation.findings.length });
      await log('error', `AUTO: broker reconciliation is ${reconciliation.status} — BLOCKING all new AUTO entries until resolved.`,
        { findings: reconciliation.findings });
      res.status(200).json({
        ok: true, action: decision.action, opened: false, skipped: 'reconciliation_required',
        reconciliation, diagnostics,
      });
      return;
    }
    await event('BROKER_RECONCILED', { reconciliationStatus: reconciliation.status });
  }

  const sizing = computePositionSize(
    {
      pricing: { maxLoss: best.result.maxLoss, maxProfit: best.result.maxProfit, netCredit: best.result.netCredit, netGreeks: best.result.netGreeks },
      marginRequiredPerLot,
      underlyingGroup: candidateSymbolGroup,
    },
    {
      // AUTO and SHADOW both base every %-of-equity risk cap (max
      // risk/trade, daily/weekly loss, portfolio risk, correlated-group
      // risk) on the REAL account balance — reserved_fund is a self-
      // declared number a human typed in, and letting real risk limits key
      // off it would let those caps drift arbitrarily far from what the
      // account can actually absorb. PAPER keeps using reserved_fund,
      // since there's no real balance to check it against.
      equity: usesRealFunds ? (realAvailableFunds ?? 0) : Number(settings.reserved_fund) || 0,
      availableFunds: usesRealFunds ? (realAvailableFunds ?? 0) : Number(settings.reserved_fund) || 0,
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

  // Concurrency/idempotency gate (QUANT_AUDIT.md Task 2) — the actual
  // claim happens here, right before execution, on the FINAL scaled legs
  // (the exact candidate shape a real order would be placed for). A
  // conflicting claim means another invocation already owns this exact
  // candidate right now — zero broker calls follow for this attempt. See
  // orderIntent.ts for exactly what "the same trade" means here, and why
  // a later, distinct attempt is never permanently blocked.
  const intentStore = supabaseOrderIntentStore(supabase);
  const claim = await claimOrderIntent(intentStore, {
    symbol, expiry: expiryDateStr, strategyLabel: decision.expiryEvaluation.strategyLabel, tradeDate: todayIST,
    legs: scaledLegs.map((l) => ({ side: l.side, right: l.right, strike: l.strike })),
    executionMode: modeLabel,
  });
  if (!claim.claimed) {
    if (claim.reason === 'CONFLICT') {
      await event('INTENT_CONFLICT', { intentKey: claim.intentKey });
      await event('ENTRY_SKIPPED', { reason: 'intent_conflict' });
      await log('info', `${modeLabel}: intent conflict for ${symbol} — another invocation already claimed this exact candidate. Skipping, zero orders placed.`);
      res.status(200).json({ ok: true, action: decision.action, opened: false, skipped: 'intent_conflict', diagnostics });
      return;
    }
    // STORE_ERROR — the intent table itself couldn't be written to. Fail
    // closed rather than proceeding without the concurrency guarantee.
    await event('ENTRY_SKIPPED', { reason: 'intent_claim_failed' });
    await log('error', `${modeLabel}: failed to claim an order intent for ${symbol} — refusing to place any order without the concurrency lock.`, { message: claim.message });
    res.status(200).json({ ok: true, action: decision.action, opened: false, skipped: 'intent_claim_failed', diagnostics });
    return;
  }
  await event('INTENT_CLAIMED', { intentId: claim.intentId, intentKey: claim.intentKey });
  await event('PRETRADE_VALIDATED', { passed: validation.passed });

  // AUTO fires REAL orders against the real Zerodha account — BUY (hedge)
  // legs first, confirmed FILLED, before any SELL (short) leg, exactly the
  // sequencing real margin treatment requires (see liveFill.ts's own
  // header). PAPER keeps simulating every leg filling instantly.
  if (isLive) await event('HEDGE_SUBMITTED', { intentId: claim.intentId });
  const winningSlice = enriched.slices.find((s) => s.expiry === decision.expiryEvaluation!.expiry);
  const shadowExecResult = isShadow && winningSlice
    ? runShadowExecutionForLegs(scaledLegs, validation, winningSlice.quotes)
    : null;
  const execResult = isLive
    ? await runLiveExecution(scaledLegs, validation, makeLiveOrderPlacer(token, apiKey), { exchange })
    : shadowExecResult
      ? shadowExecResult
      : runPaperExecution(scaledLegs, validation);

  // SHADOW-only telemetry: option-chain snapshot + per-expiry IV history +
  // the forward-validation ledger signal, ALL best-effort (SOFT_FAIL — a
  // failure here never blocks recording the position/log below, it only
  // affects this signal's eligibility for the OFFICIAL forward-validation
  // sample, per FORWARD_VALIDATION_PROTOCOL.md). Persists the EXACT slice
  // already used above — never a second fetch.
  let shadowEligible = false;
  let shadowEligibilityReasons: string[] = [];
  let shadowLedgerId: string | null = null;
  if (isShadow && winningSlice) {
    const shadowRepo = supabaseShadowRepository(supabase);
    const scanIdForShadow = randomUUID();
    const nowIso = new Date().toISOString();
    const snapshotRows: OptionChainSnapshotRow[] = winningSlice.quotes.map((q) => ({
      scanId: scanIdForShadow, capturedAt: nowIso, symbol, spot: spot ?? null,
      indiaVix: null, forward: winningSlice.forward, expiry: expiryDateStr,
      calendarDte: decision.expiryEvaluation!.dte, tradingSessionHorizon: approxTradingSessionsFromCalendarDays(decision.expiryEvaluation!.dte),
      strike: q.quote.strike, optionRight: q.quote.right,
      bid: q.quote.bid, bidQty: null, ask: q.quote.ask, askQty: null, ltp: q.quote.last, markPrice: q.markPrice,
      volume: q.quote.volume, openInterest: q.quote.openInterest, iv: q.iv,
      delta: q.greeks.delta, gamma: q.greeks.gamma, theta: q.greeks.theta, vega: q.greeks.vega,
    }));
    let snapshotOk = true;
    try { snapshotOk = 'ok' in await shadowRepo.insertChainSnapshots(snapshotRows); } catch { snapshotOk = false; }

    const atmIvForShadow = atmIvOf(winningSlice);
    const ivRows: IvHistoryRow[] = winningSlice.atmStrike !== null ? [{
      capturedAt: nowIso, symbol, expiry: expiryDateStr, atmStrike: winningSlice.atmStrike,
      atmCallIv: winningSlice.quotes.find((q) => q.quote.strike === winningSlice.atmStrike && q.quote.right === 'CE')?.iv ?? null,
      atmPutIv: winningSlice.quotes.find((q) => q.quote.strike === winningSlice.atmStrike && q.quote.right === 'PE')?.iv ?? null,
      combinedAtmIv: atmIvForShadow, calendarDte: decision.expiryEvaluation!.dte, tradingSessionHorizon: approxTradingSessionsFromCalendarDays(decision.expiryEvaluation!.dte),
      spot: spot ?? null, indiaVix: null,
    }] : [];
    try { await shadowRepo.insertIvHistory(dedupeIvHistoryRows(ivRows)); } catch { /* SOFT_FAIL — see comment above */ }

    let ledgerOk = true;
    try {
      // Task 13: version fingerprint — activeProtocolId is null (a real,
      // honest PRE_PROTOCOL state) until a protocol run has actually been
      // started for this symbol+baseline via resource=start-forward-
      // validation; this lookup never creates or infers one.
      const { data: activeRun } = await supabase.from('forward_validation_runs')
        .select('protocol_id').eq('symbol', symbol).eq('baseline_version', BASELINE_VERSION).eq('status', 'ACTIVE').maybeSingle();
      const signal: ForwardSignal = {
        symbol, strategyLabel: decision.expiryEvaluation!.strategyLabel, expiry: expiryDateStr,
        calendarDte: decision.expiryEvaluation!.dte, tradingSessionHorizon: approxTradingSessionsFromCalendarDays(decision.expiryEvaluation!.dte),
        shortDeltaTarget: null, wingWidth: null, netCredit: best.result.netCredit, estimatedMaxLoss: best.result.maxLoss,
        estimatedPop: best.result.pop, expectedValue: best.expectedValue, premiumEdgePct: best.qualityScore.raw.premiumEdgePct,
        independentEvPerUnitRisk: best.qualityScore.raw.independentEvPerUnitRisk, ivRank: null,
        liquidityTier: best.liquidity.tier, marketRegime: null, sizingLots: sizing.lots, expectedCostsRupees: null,
        intentId: claim.claimed ? claim.intentId : null,
        baselineVersion: BASELINE_VERSION, fillModelVersion: 'SHADOW_EXECUTION_V1',
        protocolId: activeRun?.protocol_id ?? null, codeVersion: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      };
      // Task 1: capture the returned ledger row id so it can be stored on
      // the position row created below — this IS the link that lets the
      // eventual exit find its way back to the same ledger row.
      shadowLedgerId = await recordSignal(supabaseForwardLedgerStore(supabase), signal);
    } catch { ledgerOk = false; }

    // Task 3: entry execution-quality telemetry, one row per leg, from the
    // SAME fill/quote objects SHADOW_EXECUTION_V1 already produced above —
    // never a second fetch.
    let entryTelemetryOk = true;
    if (shadowExecResult && shadowExecResult.state !== 'FAILED') {
      try {
        const quotesByKey = new Map(winningSlice.quotes.map((q) => [`${q.quote.strike}:${q.quote.right}`, q]));
        const entryRows: ExecutionQualityRow[] = shadowExecResult.legFills.map((l) => {
          const q = quotesByKey.get(`${l.strike}:${l.right}`);
          const decisionMid = q?.mid ?? null;
          const slippage = decisionMid !== null ? (l.side === 'BUY' ? l.fillPrice - decisionMid : decisionMid - l.fillPrice) : null;
          return {
            scanId: scanIdForShadow, candidateId: null, intentId: claim.claimed ? claim.intentId : null,
            positionId: null, legId: null, symbol, strategyLabel: decision.expiryEvaluation!.strategyLabel,
            expiry: expiryDateStr, strike: l.strike, optionRight: l.right, side: l.side, quantity: l.quantity,
            executionMode: 'SHADOW', fillModel: 'SHADOW_EXECUTION_V1',
            // Task 2: phase+forwardLedgerId are what let an eventual exit
            // look up this EXACT entry's real slippage cost instead of
            // hard-coding entryExecutionCost to 0.
            phase: 'ENTRY', forwardLedgerId: shadowLedgerId,
            decisionAt: nowIso, quoteAt: nowIso, submittedAt: nowIso, filledAt: nowIso,
            decisionMid, bid: q?.quote.bid ?? null, ask: q?.quote.ask ?? null, spreadPct: q?.spreadPct ?? null,
            submittedPrice: l.fillPrice, actualFill: l.fillPrice,
            slippageRupees: slippage, slippageBps: decisionMid && decisionMid > 0 && slippage !== null ? (slippage / decisionMid) * 10_000 : null,
            latencyMs: null, volume: q?.quote.volume ?? null, openInterest: q?.quote.openInterest ?? null,
            delta: q?.greeks.delta ?? null, dte: decision.expiryEvaluation!.dte, indiaVix: null,
            brokerOrderId: null, fillIsSimulated: true,
          };
        });
        const result = await shadowRepo.insertExecutionQuality(entryRows);
        entryTelemetryOk = 'ok' in result;
      } catch { entryTelemetryOk = false; }
    }

    const eligibility = isEligibleForForwardValidation({
      baselineVersion: BASELINE_VERSION, executionMode: 'SHADOW', fillModel: 'SHADOW_EXECUTION_V1',
      everyLegHasRealBidAsk: shadowExecResult?.hasRealBidAsk ?? false,
      quotesFreshMs: 0, maxQuoteAgeMs: 5 * 60_000,
      snapshotStoredSuccessfully: snapshotOk, ledgerSignalStoredSuccessfully: ledgerOk && entryTelemetryOk,
      knownIngestionBug: false, brokerOrderPlaced: false,
      expectedBaselineVersion: BASELINE_VERSION, expectedFillModel: 'SHADOW_EXECUTION_V1',
    });
    shadowEligible = eligibility.eligible;
    shadowEligibilityReasons = eligibility.reasons;
    await event('SHADOW_SIGNAL_RECORDED', { eligibleForForwardValidation: shadowEligible, reasons: shadowEligibilityReasons, ledgerId: shadowLedgerId });
  }

  if (execResult.state === 'RECONCILIATION_REQUIRED') {
    // A real order's true broker status is unknown (a timeout the
    // follow-up query also couldn't resolve — see liveFill.ts). This MUST
    // leave a durable, visible record — not just a log line — so the
    // reconciliation gate above actually blocks future AUTO entries on
    // the next scan, and a human sees it in the dashboard the same way
    // an existing CLOSE_FAILED position already shows up.
    const { data: reconRow } = await supabase.from('options_autotrade_positions').insert({
      symbol, strategy_label: decision.expiryEvaluation.strategyLabel, expiry: expiryDateStr,
      status: 'RECONCILIATION_REQUIRED', execution_state: execResult.state, protection: execResult.protection,
      execution_mode: modeLabel, lots: sizing.lots, net_credit: best.result.netCredit,
      max_profit: sizing.sizedMaxProfit, max_loss: sizing.sizedMaxLoss, margin_required: sizing.sizedMarginRequired,
      quality_score: best.qualityScore.score, decision_explanation: decision.explanation, entry_date: todayIST,
    }).select('id').single();
    if (reconRow) {
      await supabase.from('options_autotrade_legs').insert(execResult.legFills.map((l) => ({
        position_id: reconRow.id, side: l.side, option_right: l.right, strike: l.strike,
        tradingsymbol: l.tradingsymbol, quantity: l.quantity, fill_price: l.fillPrice, status: l.status,
        order_id: l.orderId ?? null,
      })));
    }
    await intentStore.updateStatus(claim.intentId, { status: 'FAILED', error: 'RECONCILIATION_REQUIRED', positionId: reconRow?.id });
    await event('BROKER_STATE_AMBIGUOUS', { intentId: claim.intentId, positionId: reconRow?.id });
    await event('RECONCILIATION_REQUIRED', { intentId: claim.intentId, positionId: reconRow?.id });
    await log('error', `${modeLabel}: position for ${symbol} needs MANUAL RECONCILIATION against the broker — at least one leg's true status is unknown. New AUTO entries are now blocked account-wide until resolved.`, { log: execResult.log });
    res.status(200).json({ ok: true, action: decision.action, opened: false, reconciliationRequired: true, validation, sizing, log: execResult.log, diagnostics });
    return;
  }

  if (execResult.state !== 'ACTIVE') {
    await intentStore.updateStatus(claim.intentId, { status: 'FAILED', error: execResult.state });
    await event('ENTRY_SKIPPED', { intentId: claim.intentId, reason: execResult.state });
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
    // Task 1: link this position back to its forward-validation ledger
    // row (null for PAPER/AUTO, which never populate shadowLedgerId).
    // If ledger recording failed, the position still opens (a research-
    // telemetry failure must never block the underlying paper/shadow
    // tracking itself) but is explicitly marked ineligible rather than
    // silently left in an ambiguous state.
    forward_ledger_id: isShadow ? shadowLedgerId : null,
    valid_for_forward_validation: isShadow ? shadowEligible : null,
    forward_validation_ineligibility_reasons: isShadow && !shadowEligible ? shadowEligibilityReasons : null,
  }).select('id').single();

  if (insertErr) {
    // A real fill (for AUTO) may have just happened at the broker, but it
    // couldn't be persisted — the intent must NOT be left CLAIMED (that
    // would silently permit a duplicate claim of the identical candidate
    // later) nor marked COMPLETED (nothing was actually recorded). Marked
    // ABANDONED so the next scan's reconciliation gate blocks new AUTO
    // entries account-wide until a human confirms what really happened.
    await intentStore.updateStatus(claim.intentId, { status: 'ABANDONED', error: `position_insert_failed: ${insertErr.message}` });
    await log('error', `${modeLabel}: position insert FAILED for ${symbol} after execution reported ${execResult.state} — broker state and DB now disagree. Manual reconciliation required.`, { message: insertErr.message, log: execResult.log });
    res.status(502).json({ ok: false, error: 'supabase_error', message: insertErr.message });
    return;
  }

  const legRows = execResult.legFills.map((l) => ({
    position_id: inserted.id, side: l.side, option_right: l.right, strike: l.strike,
    tradingsymbol: l.tradingsymbol, quantity: l.quantity, fill_price: l.fillPrice, status: l.status,
    order_id: l.orderId ?? null,
  }));
  await supabase.from('options_autotrade_legs').insert(legRows);
  await intentStore.updateStatus(claim.intentId, { status: 'COMPLETED', positionId: inserted.id });
  await event('POSITION_ACTIVE', { intentId: claim.intentId, positionId: inserted.id, lots: sizing.lots });
  await log('info', `Opened ${modeLabel} position #${inserted.id}: ${decision.expiryEvaluation.strategyLabel} on ${symbol}, ${sizing.lots} lot(s).`, isLive ? { log: execResult.log } : undefined);

  res.status(200).json({ ok: true, action: decision.action, opened: true, positionId: inserted.id, sizing, explanation: decision.explanation, diagnostics });
}

/**
 * Forward-start blocker phase, Task 3/4/5 — the LEDGER_COMPLETED +
 * POSITION_ACTIVE recovery path. See SHADOW_EXIT_RECOVERY.md for the full
 * durable-sequence design. Returns the closed-position summary (for the
 * position-monitor response) when a recovery finalize actually ran, or
 * `null` when the ledger was not yet completed (the ordinary, no-op case
 * — the caller should continue with its normal exit-evaluation logic).
 *
 * Never re-simulates an exit, never re-derives P&L from fresh quotes,
 * never writes a second batch of exit telemetry — only reads back the
 * FIRST, already-persisted ledger outcome and idempotently finalizes the
 * position from those exact values, via an atomic
 * `WHERE id = ? AND status = 'ACTIVE'` UPDATE so a second, concurrent
 * recovery attempt affects zero rows instead of double-firing.
 */
async function recoverShadowPositionIfLedgerCompleted(
  supabase: SupabaseClient, p: any, log: (level: 'info' | 'error', message: string, detail?: unknown, mode?: string | null) => any,
): Promise<{ positionId: number; symbol: string; reason: string | null; realizedPnl: number } | null> {
  const ledgerStore = supabaseForwardLedgerStore(supabase);
  const ledgerRead = await ledgerStore.getOutcome(p.forward_ledger_id);
  const ledgerCompleted = ledgerRead.found && ledgerRead.outcome.completed;
  const state = classifyShadowConsistency(ledgerCompleted, p.status);

  if (state === 'RECONCILIATION_REQUIRED') {
    // A position status this SHADOW lifecycle never intentionally
    // produces alongside an incomplete ledger (e.g. CLOSED with no
    // completed outcome) — surfaced, never silently ignored, but this
    // function only RECOVERS the RECOVERABLE_INCONSISTENCY case; a true
    // reconciliation-required state needs a human, not an automatic fix.
    await log('error', `Position #${p.id} (SHADOW): consistency check found ${state} (ledger completed=${ledgerCompleted}, position status=${p.status}) — needs manual reconciliation, not auto-fixed.`, undefined, 'SHADOW');
    return null;
  }
  if (state !== 'RECOVERABLE_INCONSISTENCY') return null; // NORMAL_OPEN or NORMAL_CLOSED — nothing to do.

  // RECOVERABLE_INCONSISTENCY: recordOutcome succeeded in some earlier
  // invocation, but the position's own CLOSED update never ran (or hasn't
  // yet, in a still-in-flight concurrent invocation). Read back exactly
  // what that FIRST outcome persisted, and finalize from it.
  if (!ledgerRead.found) return null; // unreachable given ledgerCompleted above, but keeps the type narrowing honest.
  const { count: exitTelemetryCount } = await supabase.from('options_execution_quality')
    .select('id', { count: 'exact', head: true }).eq('forward_ledger_id', p.forward_ledger_id).eq('phase', 'EXIT');

  const plan = buildShadowRecoveryFinalizationPlan({
    ledgerId: p.forward_ledger_id, positionId: p.id,
    entryDateIso: p.entry_date ? String(p.entry_date) : new Date().toISOString().slice(0, 10),
    outcome: {
      exitReason: ledgerRead.outcome.exitReason, netPnl: ledgerRead.outcome.netPnl,
      outcomeRecordedAtIso: ledgerRead.outcome.outcomeRecordedAtIso,
      validForForwardValidationCarry: p.valid_for_forward_validation ?? false,
    },
    exitTelemetryFound: (exitTelemetryCount ?? 0) > 0,
  });

  // Atomic — matches zero rows if another concurrent recovery invocation
  // (or the original invocation, finishing late) already finalized it.
  const { data: closedRows } = await supabase.from('options_autotrade_positions')
    .update(plan.update).eq('id', p.id).eq('status', 'ACTIVE').select('id');
  if (!closedRows || closedRows.length === 0) {
    await log('info', `Position #${p.id} (SHADOW): recovery finalize found it already CLOSED by another invocation — no-op.`, undefined, 'SHADOW');
    return null;
  }

  await log('info', `Position #${p.id} (SHADOW): RECOVERED from a completed ledger outcome (ledger #${p.forward_ledger_id}) that the position row had not yet reflected — finalized CLOSED using the ORIGINAL persisted outcome, no re-simulated exit.`, { plan }, 'SHADOW');
  return { positionId: p.id, symbol: p.symbol, reason: plan.update.exit_reason, realizedPnl: plan.update.realized_pnl };
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

    // Forward-start blocker phase, Task 3/4/5: recovery MUST be checked
    // BEFORE any quote-based logic or a fresh evaluateExit() call — if the
    // market has moved back since a prior crash (recordOutcome succeeded,
    // then the process died before the position CLOSED update), a fresh
    // exit decision this cycle could easily be HOLD, and this position
    // would never reach the exit-handling code below again. A completed
    // ledger is authoritative regardless of what today's quotes say.
    if (p.execution_mode === 'SHADOW' && p.forward_ledger_id) {
      const recovered = await recoverShadowPositionIfLedgerCompleted(supabase, p, log);
      if (recovered) { closed.push(recovered); continue; }
    }

    let currentCostToClose = 0;
    let missingQuote = false;
    for (const l of legs) {
      const price = midOrLastPrice(quoteMap.get(`${exchange}:${l.tradingsymbol}`));
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
    } else if (p.execution_mode === 'SHADOW') {
      // SHADOW exit (lifecycle-completion phase, Task 4/5/6/9/10). Same
      // trigger (evaluateExit, above) and same re-quoted quoteMap as every
      // other position this cycle — never a second fetch. NO broker
      // closeLeg/awaitFill call anywhere in this branch.
      const exitLegs = legs.map((l: any) => ({
        side: l.side as 'BUY' | 'SELL', right: l.option_right as 'CE' | 'PE', strike: Number(l.strike),
        price: midOrLastPrice(quoteMap.get(`${exchange}:${l.tradingsymbol}`)) ?? 0,
        entryFillPrice: Number(l.fill_price), quantity: l.quantity, tradingsymbol: l.tradingsymbol,
      }));
      const rawQuoteMapForShadow = new Map<string, RawKiteQuote>();
      for (const l of legs) {
        const raw = quoteMap.get(`${exchange}:${l.tradingsymbol}`);
        if (raw) rawQuoteMapForShadow.set(`${exchange}:${l.tradingsymbol}`, raw);
      }

      // Task 6's "exit telemetry written + crash before outcome" case: if
      // a PRIOR invocation already inserted an EXIT telemetry batch for
      // this exact ledger row but the ledger itself was never completed
      // (recordOutcome never ran, or crashed before it), re-simulating a
      // fresh exit here would produce a SECOND, independently-priced exit
      // — the exact "no duplicate telemetry representing two independent
      // exits" invariant this phase requires. Rather than guess which set
      // of fills is authoritative, this is flagged for manual
      // reconciliation and the position is left ACTIVE — never silently
      // resolved by trusting either a re-simulation or a fragile
      // reconstruction from partial stored fields.
      const { count: existingExitTelemetryCount } = await supabase.from('options_execution_quality')
        .select('id', { count: 'exact', head: true }).eq('forward_ledger_id', p.forward_ledger_id).eq('phase', 'EXIT');
      // ledgerCompleted is always false here — if it were true, the
      // earlier recovery check at the top of this loop would already
      // have handled (and `continue`d) this position.
      if (hasOrphanedExitTelemetry(false, existingExitTelemetryCount ?? 0)) {
        await log('error', `Position #${p.id} (SHADOW): exit execution-quality telemetry already exists for ledger #${p.forward_ledger_id} but its outcome was never completed — an ambiguous crash-recovery state (telemetry written, outcome not recorded) that cannot be safely auto-resolved. Left ACTIVE; manual reconciliation required.`, undefined, 'SHADOW');
        continue;
      }

      const exitFillResult = simulateShadowExitFills({ legs: exitLegs, quoteMap: rawQuoteMapForShadow, exchange });

      if (exitFillResult.status !== 'FILLED') {
        await log('error', `Position #${p.id} (SHADOW): exit fill simulation failed — ${exitFillResult.reason}. Left ACTIVE for a retry next cycle.`, undefined, 'SHADOW');
        continue;
      }
      // Task 3: grossPnl is the MID-to-MID economic payoff (zero
      // execution slippage) — costToCloseAtMid, not the slippage-bearing
      // costToClose, is what belongs here; slippage is subtracted out
      // exactly once via entryExecutionCost/exitExecutionCost below (see
      // executionCost.ts for the full canonical-formula rationale).
      const grossPnl = (Number(p.max_profit) || 0) - exitFillResult.costToCloseAtMid;
      const exitExecutionCost = exitFillResult.fills.reduce((s, f) => s + Math.abs(f.slippageRupees), 0);

      // Task 2: real entry-side slippage cost, looked up from THIS exact
      // trade's own phase='ENTRY' telemetry rows — never hard-coded to 0.
      // null (not 0) when unavailable, e.g. entry telemetry failed to
      // persist or predates this fix.
      const shadowRepoForCost = supabaseShadowRepository(supabase);
      const entryExecutionCostLookup = p.forward_ledger_id
        ? await shadowRepoForCost.sumEntryExecutionCost(p.forward_ledger_id)
        : { value: null, rowCount: 0 };

      // Task 2: statutory/brokerage charges — a deterministic estimate
      // from the SAME cost model the backtest engine uses, kept strictly
      // separate from slippage (never folded into totalExecutionCost).
      const transactionChargesEstimate = estimateTransactionCharges({
        legs: legs.map((l: any, i: number) => ({
          side: l.side as 'BUY' | 'SELL', entryTurnover: Number(l.fill_price) * l.quantity,
          exitTurnover: exitFillResult.fills[i].filledPrice * l.quantity,
        })),
        tradeDate: todayIST,
      }).estimate;

      const costs = computeExecutionCostBreakdown({ entryExecutionCostLookup, exitExecutionCost, transactionChargesEstimate });
      const canonicalPnl = computeCanonicalForwardPnl(grossPnl, costs);
      realizedPnl = canonicalPnl.netPnl;
      const entryDate = p.entry_date ? String(p.entry_date) : todayIST;
      const holdingPeriodDays = Math.max(0, Math.round((Date.parse(todayIST) - Date.parse(entryDate)) / 86_400_000));

      // Task 11: forward observability ONLY — this hypothetical read never
      // writes to the SHARED options_autotrade_daily_stats table (that
      // table governs the REAL daily-risk-lock for PAPER/AUTO; mixing
      // SHADOW's hypothetical P&L into it would corrupt that gate). It is
      // approximated against settings.reserved_fund (not a real funds
      // re-fetch — see this phase's own report for why) — a disclosed
      // limitation, not silently assumed exact.
      const { data: shadowTodayRows } = await supabase.from('options_autotrade_positions')
        .select('realized_pnl').eq('execution_mode', 'SHADOW').eq('status', 'CLOSED').eq('exit_date', todayIST);
      const shadowRealizedToday = (shadowTodayRows ?? []).reduce((s: number, r: any) => s + (Number(r.realized_pnl) || 0), 0) + realizedPnl;
      const shadowConsecutiveLosses = (() => {
        let count = realizedPnl < 0 ? 1 : 0;
        for (const r of (shadowTodayRows ?? []).slice().reverse()) {
          if (Number(r.realized_pnl) < 0) count++; else break;
        }
        return count;
      })();
      const hypotheticalLock = checkDailyRiskLock(
        { realizedPnlToday: shadowRealizedToday, consecutiveLosses: shadowConsecutiveLosses },
        { equity: Number(settings.reserved_fund) || 0, maxDailyLossPct: settings.max_daily_loss_pct, maxConsecutiveLosses: settings.max_consecutive_losses },
      );

      let outcomeStoredOk = false;
      if (p.forward_ledger_id) {
        const outcomeResult = await recordOutcome(supabaseForwardLedgerStore(supabase), p.forward_ledger_id, {
          exitReason: decision.reason ?? 'UNKNOWN', holdingPeriodDays,
          grossPnl: canonicalPnl.grossPnl, netPnl: canonicalPnl.netPnl,
          entryExecutionCost: canonicalPnl.entryExecutionCost, exitExecutionCost: canonicalPnl.exitExecutionCost,
          totalExecutionCost: canonicalPnl.totalExecutionCost, transactionChargesEstimate: canonicalPnl.transactionChargesEstimate,
          costModelVersion: EXECUTION_COST_MODEL_VERSION,
          maxAdverseExcursion: null, maxFavorableExcursion: null, // Task 7: MAE_MFE_UNAVAILABLE — no intratrade mark series persisted yet
          dailyLockState: {
            wouldTriggerMaxDailyLoss: hypotheticalLock.locked && hypotheticalLock.reason === 'MAX_DAILY_LOSS',
            wouldTriggerMaxConsecutiveLosses: hypotheticalLock.locked && hypotheticalLock.reason === 'MAX_CONSECUTIVE_LOSSES',
            realizedPnlTodayAfterThisTrade: shadowRealizedToday, consecutiveLossesAfterThisTrade: shadowConsecutiveLosses,
          },
          dataQuality: {
            maeMfe: 'MAE_MFE_UNAVAILABLE',
            entryExecutionCostBasis: canonicalPnl.costBasis.entry,
            entryExecutionCostRowCount: entryExecutionCostLookup.rowCount,
          },
        });
        if ('alreadyCompleted' in outcomeResult) {
          // Task 9/10 (and forward-start blocker phase Task 3): another
          // (overlapping/retried) invocation already completed this exact
          // SHADOW trade's outcome — the ledger's own atomic guard caught
          // it. This losing invocation must NEVER write its own telemetry
          // or touch the ledger again, but the position itself may still
          // be sitting ACTIVE if the WINNING invocation hasn't reached its
          // own CLOSED update yet (or crashed before it) — recover from
          // the winner's persisted outcome instead of silently leaving it
          // stuck, using the exact same recovery path a later monitor
          // cycle would use.
          const recovered = await recoverShadowPositionIfLedgerCompleted(supabase, p, log);
          if (recovered) { closed.push(recovered); }
          else { await log('info', `Position #${p.id} (SHADOW): outcome already recorded by another invocation — skipping duplicate exit (position not yet recoverable this pass).`, undefined, 'SHADOW'); }
          continue;
        }
        outcomeStoredOk = 'ok' in outcomeResult;
      }

      // Exit execution-quality telemetry, one row per leg (Task 5).
      let exitTelemetryOk = true;
      try {
        const shadowRepo = supabaseShadowRepository(supabase);
        const exitRows: ExecutionQualityRow[] = exitFillResult.fills.map((f, i) => {
          const leg = exitLegs[i];
          return {
            scanId: randomUUID(), candidateId: null, intentId: null, positionId: p.id, legId: null,
            symbol: p.symbol, strategyLabel: p.strategy_label, expiry: p.expiry, strike: leg.strike, optionRight: leg.right,
            side: f.side, quantity: leg.quantity, executionMode: 'SHADOW', fillModel: 'SHADOW_EXECUTION_V1',
            phase: 'EXIT', forwardLedgerId: p.forward_ledger_id ?? null,
            decisionAt: new Date().toISOString(), quoteAt: new Date().toISOString(), submittedAt: new Date().toISOString(), filledAt: new Date().toISOString(),
            decisionMid: f.decisionPrice, bid: null, ask: null, spreadPct: f.spreadAtEntryPct,
            submittedPrice: f.submittedPrice, actualFill: f.filledPrice,
            slippageRupees: f.slippageRupees, slippageBps: f.slippageBps, latencyMs: f.latencyMs,
            volume: null, openInterest: null, delta: null, dte: 0, indiaVix: null,
            brokerOrderId: null, fillIsSimulated: true,
          };
        });
        const result = await shadowRepo.insertExecutionQuality(exitRows);
        exitTelemetryOk = 'ok' in result;
      } catch { exitTelemetryOk = false; }

      // Forward-start blocker phase, Task 2: the final completed-trade
      // eligibility verdict, now including protocol-timing — read from
      // the ledger signal's own version fingerprint + the referenced
      // protocol run (a real DB read, done HERE by the caller; the
      // eligibility functions themselves stay pure — see
      // protocolTiming.ts/shadowExecution.ts's own comments on this).
      const { data: ledgerFingerprint } = await supabase.from('options_forward_validation_ledger')
        .select('protocol_id,baseline_version,fill_model_version,recorded_at').eq('id', p.forward_ledger_id).maybeSingle();
      const { data: referencedRun } = ledgerFingerprint?.protocol_id
        ? await supabase.from('forward_validation_runs').select('protocol_id,baseline_version,fill_model,status,started_at,stopped_at').eq('protocol_id', ledgerFingerprint.protocol_id).maybeSingle()
        : { data: null };
      const protocolTiming = evaluateProtocolTimingEligibility(
        {
          signalProtocolId: ledgerFingerprint?.protocol_id ?? null,
          signalBaselineVersion: ledgerFingerprint?.baseline_version ?? BASELINE_VERSION,
          signalFillModelVersion: ledgerFingerprint?.fill_model_version ?? 'SHADOW_EXECUTION_V1',
          signalTimestampMs: ledgerFingerprint?.recorded_at ? Date.parse(ledgerFingerprint.recorded_at) : Date.now(),
        },
        {
          runExists: !!referencedRun, runStatus: referencedRun?.status ?? null, runProtocolId: referencedRun?.protocol_id ?? null,
          runBaselineVersion: referencedRun?.baseline_version ?? null, runFillModel: referencedRun?.fill_model ?? null,
          runStartedAtMs: referencedRun?.started_at ? Date.parse(referencedRun.started_at) : null,
          runTerminalAtMs: referencedRun?.stopped_at ? Date.parse(referencedRun.stopped_at) : null,
        },
      );
      const completedEligibility = isCompletedTradeEligibleForForwardValidation({
        entryEligibility: { eligible: p.valid_for_forward_validation ?? false, reasons: p.forward_validation_ineligibility_reasons ?? [] },
        exitEverLegHasRealBidAsk: exitFillResult.hasRealBidAsk, exitQuotesFreshMs: 0, maxQuoteAgeMs: 5 * 60_000,
        entryExecutionTelemetryStored: entryExecutionCostLookup.rowCount > 0, exitExecutionTelemetryStored: exitTelemetryOk,
        outcomeStoredSuccessfully: outcomeStoredOk, strategyDrift: false, fillModelDrift: false,
        knownIngestionBug: false, brokerOrderPlaced: false, protocolTiming,
      });

      // Second-layer completion guard on the position row itself (Task 9)
      // — .eq('status','ACTIVE') makes this UPDATE match zero rows if
      // another invocation already closed it, independent of the ledger
      // guard above (belt-and-braces, not a replacement for it).
      const { data: closedRows } = await supabase.from('options_autotrade_positions').update({
        status: 'CLOSED', execution_state: 'CLOSED', exit_date: todayIST, exit_reason: decision.reason,
        realized_pnl: realizedPnl, updated_at: new Date().toISOString(),
        valid_for_forward_validation: completedEligibility.eligible,
        forward_validation_ineligibility_reasons: completedEligibility.eligible ? null : completedEligibility.reasons,
      }).eq('id', p.id).eq('status', 'ACTIVE').select('id');
      if (!closedRows || closedRows.length === 0) {
        await log('info', `Position #${p.id} (SHADOW): already closed by another invocation — skipping duplicate update.`, undefined, 'SHADOW');
        continue;
      }
      await log('info', `Closed SHADOW position #${p.id} (${p.symbol} ${p.strategy_label}): ${decision.reason} — hypothetical realized P&L ₹${realizedPnl.toFixed(0)} (real bid/ask: ${exitFillResult.hasRealBidAsk}).`, undefined, 'SHADOW');
      closed.push({ positionId: p.id, symbol: p.symbol, reason: decision.reason, realizedPnl });
      continue; // SHADOW's own position update already ran above — skip the shared PAPER/AUTO update below
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

/**
 * SHADOW health panel (forward-validation readiness phase, Task 4).
 * READ-ONLY — makes no write of any kind. Per-symbol counts are drawn
 * from what is ACTUALLY, reliably observable in this schema:
 *   - scansAttempted / entryTelemetryAttempts / ledgerSignalAttempts all
 *     come from the SCAN_STARTED / SHADOW_SIGNAL_RECORDED log events
 *     handlePaperScan already emits unconditionally for every SHADOW scan
 *     cycle that reaches that stage — this IS the honest "attempted"
 *     count, since a totally-failed DB insert leaves no row of its own to
 *     count, only a log line proving the attempt happened.
 *   - every *_Successes count comes straight from real rows in the
 *     underlying table (a row only exists when its insert actually
 *     succeeded).
 *   - exitTelemetryAttempts/ledgerOutcomeAttempts are approximated from
 *     the position-monitor's own SHADOW exit log lines (a disclosed
 *     approximation — there is no dedicated per-exit-attempt event table
 *     the way entry has SHADOW_SIGNAL_RECORDED — see this comment, not
 *     silently assumed exact).
 * Defaults to today (IST); pass ?date=YYYY-MM-DD for a different day.
 */
async function handleShadowHealth(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const date = (req.query?.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;
  const symbols = Object.keys(OPTIONS_SYMBOLS as Record<string, string>);
  const nowMs = Date.now();

  const reports = [];
  for (const symbol of symbols) {
    const scanStartedCount = await countLog(supabase, symbol, 'SHADOW', '[SCAN_STARTED]', dayStart, dayEnd);
    const signalRecordedCount = await countLog(supabase, symbol, 'SHADOW', '[SHADOW_SIGNAL_RECORDED]', dayStart, dayEnd);
    const exitClosedCount = await countLog(supabase, symbol, 'SHADOW', 'Closed SHADOW position', dayStart, dayEnd);
    const exitFailedCount = await countLog(supabase, symbol, 'SHADOW', 'exit fill simulation failed', dayStart, dayEnd);
    const exitDuplicateCount = await countLog(supabase, symbol, 'SHADOW', 'outcome already recorded', dayStart, dayEnd);

    const { data: snapshotRows } = await supabase.from('options_chain_snapshots')
      .select('scan_id,bid,ask,open_interest,iv,captured_at').eq('symbol', symbol).gte('captured_at', dayStart).lte('captured_at', dayEnd);
    const snapshots = snapshotRows ?? [];
    const distinctSnapshotScans = new Set(snapshots.map((r: any) => r.scan_id)).size;

    const { data: ivRows } = await supabase.from('options_iv_history').select('id').eq('symbol', symbol).gte('captured_at', dayStart).lte('captured_at', dayEnd);

    const { data: entryTelemetryRows } = await supabase.from('options_execution_quality')
      .select('scan_id').eq('symbol', symbol).eq('execution_mode', 'SHADOW').eq('phase', 'ENTRY').gte('decision_at', dayStart).lte('decision_at', dayEnd);
    const distinctEntryTelemetryScans = new Set((entryTelemetryRows ?? []).map((r: any) => r.scan_id)).size;

    const { data: exitTelemetryRows } = await supabase.from('options_execution_quality')
      .select('id').eq('symbol', symbol).eq('execution_mode', 'SHADOW').eq('phase', 'EXIT').gte('decision_at', dayStart).lte('decision_at', dayEnd);

    const { count: ledgerSignalCount } = await supabase.from('options_forward_validation_ledger')
      .select('id', { count: 'exact', head: true }).eq('symbol', symbol).gte('recorded_at', dayStart).lte('recorded_at', dayEnd);

    const { count: ledgerOutcomeCount } = await supabase.from('options_forward_validation_ledger')
      .select('id', { count: 'exact', head: true }).eq('symbol', symbol).eq('completed', true).gte('outcome_recorded_at', dayStart).lte('outcome_recorded_at', dayEnd);

    const { count: openPositions } = await supabase.from('options_autotrade_positions')
      .select('id', { count: 'exact', head: true }).eq('symbol', symbol).eq('execution_mode', 'SHADOW').eq('status', 'ACTIVE');
    const { count: completedTrades } = await supabase.from('options_autotrade_positions')
      .select('id', { count: 'exact', head: true }).eq('symbol', symbol).eq('execution_mode', 'SHADOW').eq('status', 'CLOSED');
    const { count: eligibleCompletedTrades } = await supabase.from('options_autotrade_positions')
      .select('id', { count: 'exact', head: true }).eq('symbol', symbol).eq('execution_mode', 'SHADOW').eq('status', 'CLOSED').eq('valid_for_forward_validation', true);

    const { data: activeRun } = await supabase.from('forward_validation_runs')
      .select('started_at').eq('symbol', symbol).eq('baseline_version', BASELINE_VERSION).eq('status', 'ACTIVE').maybeSingle();

    // Task 7/8: classify every SHADOW position (that has a ledger link at
    // all) against its ledger's completed state, using the SAME pure
    // classifier the position monitor's recovery path uses — a read-only
    // embedded-relationship query, no write of any kind.
    const { data: allShadowRows } = await supabase.from('options_autotrade_positions')
      .select('id,status,forward_ledger_id,forward_validation_ineligibility_reasons,options_forward_validation_ledger(completed)')
      .eq('symbol', symbol).eq('execution_mode', 'SHADOW').not('forward_ledger_id', 'is', null);
    let completedLedgerActivePositionCount = 0;
    let closedPositionIncompleteLedgerCount = 0;
    let recoveryRequiredCount = 0;
    for (const row of allShadowRows ?? []) {
      const ledgerCompleted = (row as any).options_forward_validation_ledger?.completed === true;
      const state = classifyShadowConsistency(ledgerCompleted, row.status);
      if (state === 'RECOVERABLE_INCONSISTENCY') completedLedgerActivePositionCount++;
      else if (state === 'RECONCILIATION_REQUIRED' && row.status === 'CLOSED') closedPositionIncompleteLedgerCount++;
      else if (state === 'RECONCILIATION_REQUIRED') recoveryRequiredCount++;
    }
    // jsonb array column — filtered in JS rather than via a PostgREST
    // text-pattern operator that doesn't apply cleanly to jsonb.
    const { data: ineligibleClosedRows } = await supabase.from('options_autotrade_positions')
      .select('forward_validation_ineligibility_reasons').eq('symbol', symbol).eq('execution_mode', 'SHADOW')
      .eq('status', 'CLOSED').eq('valid_for_forward_validation', false);
    const protocolTimingInvalidTradeCount = (ineligibleClosedRows ?? []).filter((r: any) =>
      Array.isArray(r.forward_validation_ineligibility_reasons) && r.forward_validation_ineligibility_reasons.some((reason: string) => reason.startsWith('protocol:')),
    ).length;

    const maxQuoteAgeMs = 5 * 60_000;
    const counts: ShadowHealthCounts = {
      symbol,
      completedLedgerActivePositionCount, closedPositionIncompleteLedgerCount,
      protocolTimingInvalidTradeCount, recoveryRequiredCount,
      scansAttempted: scanStartedCount,
      snapshotWriteSuccesses: distinctSnapshotScans, snapshotWriteAttempts: signalRecordedCount,
      ivHistoryWriteSuccesses: (ivRows ?? []).length, ivHistoryWriteAttempts: signalRecordedCount,
      missingBidAskCount: snapshots.filter((s: any) => s.bid === null || s.ask === null).length,
      staleQuoteCount: snapshots.filter((s: any) => nowMs - Date.parse(s.captured_at) > maxQuoteAgeMs).length,
      missingOiCount: snapshots.filter((s: any) => s.open_interest === null).length,
      missingIvCount: snapshots.filter((s: any) => s.iv === null).length,
      snapshotRowCount: snapshots.length,
      entryTelemetrySuccesses: distinctEntryTelemetryScans, entryTelemetryAttempts: signalRecordedCount,
      exitTelemetrySuccesses: (exitTelemetryRows ?? []).length, exitTelemetryAttempts: exitClosedCount + exitFailedCount + exitDuplicateCount,
      ledgerSignalSuccesses: ledgerSignalCount ?? 0, ledgerSignalAttempts: signalRecordedCount,
      ledgerOutcomeSuccesses: ledgerOutcomeCount ?? 0, ledgerOutcomeAttempts: exitClosedCount + exitFailedCount + exitDuplicateCount,
      openShadowPositions: openPositions ?? 0, completedShadowTrades: completedTrades ?? 0,
      eligibleCompletedShadowTrades: eligibleCompletedTrades ?? 0,
      activeProtocolRun: !!activeRun, protocolStartedAt: activeRun?.started_at ?? null, nowMs,
    };
    reports.push(computeShadowHealthReport(counts));
  }

  res.status(200).json({ ok: true, date, reports });
}

async function countLog(supabase: SupabaseClient, symbol: string, executionMode: string, messageContains: string, gte: string, lte: string): Promise<number> {
  const { count } = await supabase.from('options_autotrade_log')
    .select('id', { count: 'exact', head: true })
    .eq('execution_mode', executionMode).ilike('message', `%${messageContains}%${symbol}%`).gte('created_at', gte).lte('created_at', lte);
  // handlePaperScan's own event()/log() format is `[EVENT_NAME] SYMBOL` or
  // a plain sentence containing the symbol elsewhere — SCAN_STARTED/
  // SHADOW_SIGNAL_RECORDED follow the first form (checked with the %...%
  // pattern above); the exit-side messages ("Closed SHADOW position #N
  // (SYMBOL ...)") contain the symbol later in the string, which the same
  // wildcard pattern still matches. If a future log format change breaks
  // this match, the count degrades to 0 (visibly wrong, not silently
  // wrong) rather than matching every symbol's rows indiscriminately.
  return count ?? 0;
}

/**
 * Forward-validation protocol START (readiness phase, Task 6/7). Requires
 * EXPLICIT invocation — never runs automatically on deploy or on the
 * first SHADOW trade (no code path calls this function except this HTTP
 * route). Refuses unless BOTH evaluateForwardValidationReadiness()
 * returns READY and the in-memory self-test passes — a wiring regression
 * must never be able to silently start an official run.
 */
async function handleStartForwardValidation(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const symbol = (req.body?.symbol as string) || 'NIFTY';
  if (!(OPTIONS_SYMBOLS as Record<string, string>)[symbol]) {
    res.status(400).json({ error: 'bad_request', message: `Unknown symbol '${symbol}'.` });
    return;
  }

  const { data: settings } = await supabase.from('options_autotrade_settings').select('execution_mode').eq('id', 1).maybeSingle();
  const autoEnabled = settings?.execution_mode === 'AUTO';

  // migrationsPresent: probed non-destructively — real SELECTs of the
  // exact columns/table 011+012+013 add; a missing-column or missing-table
  // error means the migration is not applied, not a fabricated guess.
  const { error: positionsProbeError } = await supabase.from('options_autotrade_positions')
    .select('forward_ledger_id,valid_for_forward_validation,forward_validation_ineligibility_reasons').limit(1);
  const { error: ledgerProbeError } = await supabase.from('options_forward_validation_ledger')
    .select('completed,gross_pnl,entry_execution_cost,exit_execution_cost,total_execution_cost,transaction_charges_estimate,protocol_id,baseline_version,fill_model_version,code_version').limit(1);
  const { error: execQualityProbeError } = await supabase.from('options_execution_quality').select('phase,forward_ledger_id').limit(1);
  const { error: runsProbeError } = await supabase.from('forward_validation_runs')
    .select('id,protocol_id,baseline_version,fill_model,symbol,started_at,status,stopped_at,protocol_version,code_version').limit(1);
  const migrationsPresent = !positionsProbeError && !ledgerProbeError && !execQualityProbeError && !runsProbeError;

  const selfTestResult = await runForwardValidationSelfTest();

  const health = await (async () => {
    const req2 = { method: 'GET', query: { symbol } } as any;
    let captured: any = null;
    const res2 = { status: () => ({ json: (body: any) => { captured = body; } }) } as any;
    await handleShadowHealth(req2, res2, supabase);
    return captured?.reports?.find((r: any) => r.symbol === symbol) ?? null;
  })();
  const hasUnresolvedShadowLifecycleInconsistency = !!health && (
    health.completedLedgerActivePositionCount > 0 || health.closedPositionIncompleteLedgerCount > 0 || health.recoveryRequiredCount > 0
  );

  const readiness = evaluateForwardValidationReadiness({
    migrationsPresent,
    baselineVersion: BASELINE_VERSION, expectedBaselineVersion: BASELINE_VERSION,
    shadowExecutionV1Active: true, // structurally the only fill model shadowExecution.ts's runShadowFillSimulation ever uses
    entryTelemetryWired: true, exitTelemetryWired: true, ledgerSignalWired: true, ledgerOutcomeWired: true,
    entryExecutionCostNonStubbed: true, completionIdempotencyActive: true,
    healthEndpointWorking: health !== null,
    // NOT_READY (zero scans today) is a normal pre-market/fresh-symbol
    // state, not a fault — only DEGRADED (an actual threshold failure or
    // lifecycle inconsistency) blocks readiness here.
    hasActiveUnresolvedDataQualityFault: health?.healthStatus === 'DEGRADED',
    autoEnabled, useNetEvRankingEnabled: false, // hardcoded false in simulate.ts — no code path in this repo can ever set it true
    protocolTimingEligibilityWired: true, completedLedgerRecoveryWired: true, canonicalPnlActive: true,
    hasUnresolvedShadowLifecycleInconsistency,
  });

  if (!selfTestResult.passed) {
    res.status(200).json({
      ok: true, started: false, status: 'NOT_READY',
      reasons: ['pre-start self-test failed', ...selfTestResult.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail ?? 'failed'}`)],
    });
    return;
  }
  if (readiness.status !== 'READY') {
    res.status(200).json({ ok: true, started: false, status: 'NOT_READY', reasons: readiness.reasons });
    return;
  }

  const protocolId = `${symbol}-${BASELINE_VERSION}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  // Atomic claim: forward_validation_runs_one_active_per_symbol_baseline_idx
  // (migration 013) makes a second concurrent ACTIVE row for this exact
  // symbol+baseline fail with a unique-violation, not a check-then-act
  // race — this INSERT is the ONLY place that can ever create a run.
  const { data: inserted, error: insertErr } = await supabase.from('forward_validation_runs').insert({
    protocol_id: protocolId, symbol, baseline_version: BASELINE_VERSION, fill_model: 'SHADOW_EXECUTION_V1',
    status: 'ACTIVE', protocol_version: 'FORWARD_VALIDATION_PROTOCOL_V1', code_version: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  }).select('id,protocol_id,started_at').single();

  if (insertErr) {
    const isUniqueViolation = /duplicate key|unique constraint/i.test(insertErr.message);
    res.status(isUniqueViolation ? 409 : 502).json({
      ok: false, started: false,
      error: isUniqueViolation ? 'already_active' : 'supabase_error',
      message: isUniqueViolation ? `An ACTIVE forward-validation run already exists for ${symbol}/${BASELINE_VERSION}.` : insertErr.message,
    });
    return;
  }

  await supabase.from('options_autotrade_log').insert({
    level: 'info', message: `[FORWARD_VALIDATION_STARTED] ${symbol}`,
    detail: { protocolId, baselineVersion: BASELINE_VERSION, fillModel: 'SHADOW_EXECUTION_V1', startedAt: inserted.started_at },
    execution_mode: 'SHADOW',
  });

  res.status(200).json({ ok: true, started: true, status: 'READY', protocolId, startedAt: inserted.started_at, selfTest: selfTestResult });
}

/**
 * Protocol STOP/ABORT (Task 12). Never deletes a run — transitions ACTIVE
 * -> STOPPED (a deliberate, clean end) or ACTIVE -> INVALIDATED (the
 * code/baseline/fill-model changed mid-run and this run's sample is no
 * longer comparable). A new run always needs a NEW protocol_id — this
 * endpoint never resurrects or reuses one.
 */
async function handleStopForwardValidation(req: any, res: any, supabase: SupabaseClient) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const protocolId = req.body?.protocolId as string;
  const outcome = (req.body?.outcome as string) === 'INVALIDATED' ? 'INVALIDATED' : 'STOPPED';
  if (!protocolId) { res.status(400).json({ error: 'bad_request', message: 'protocolId is required.' }); return; }

  const { data, error } = await supabase.from('forward_validation_runs')
    .update({ status: outcome, stopped_at: new Date().toISOString(), notes: req.body?.notes ?? null })
    .eq('protocol_id', protocolId).eq('status', 'ACTIVE').select('id,protocol_id,symbol,baseline_version,started_at,stopped_at,status');

  if (error) { res.status(502).json({ ok: false, error: 'supabase_error', message: error.message }); return; }
  if (!data || data.length === 0) {
    res.status(404).json({ ok: false, error: 'not_found', message: `No ACTIVE run found for protocolId '${protocolId}'.` });
    return;
  }
  await supabase.from('options_autotrade_log').insert({
    level: 'info', message: `[FORWARD_VALIDATION_${outcome}] ${data[0].symbol}`, detail: data[0], execution_mode: 'SHADOW',
  });
  res.status(200).json({ ok: true, run: data[0] });
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
    // SHADOW (forward-validation readiness phase) runs the exact live
    // decision pipeline but places zero broker orders — see
    // handlePaperScan's own isShadow branch. This validator previously
    // only allowed OFF/PAPER/AUTO, which meant Save Settings silently
    // rejected SHADOW even though the scan/monitor pipeline already
    // supported it end-to-end.
    if (body.execution_mode !== undefined && !['OFF', 'PAPER', 'SHADOW', 'AUTO'].includes(body.execution_mode)) {
      res.status(400).json({ error: 'bad_request', message: `execution_mode must be OFF, PAPER, SHADOW, or AUTO — ALERT_ONLY/SEMI_AUTO aren't implemented yet.` });
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

/**
 * Login/logout/session-check for the custom login page — folded in here
 * (rather than its own api/auth.ts) purely to stay under Vercel Hobby's
 * 12-serverless-function-per-deployment cap, same reasoning the vwap-
 * scalper resources were folded into this file for. Needs no Supabase
 * client at all, so it's routed before that's even created. Deliberately
 * the only resources middleware.ts lets through unauthenticated — every
 * other resource in this file requires the session cookie this issues.
 * See src/lib/session.ts for the signing mechanics.
 */
async function handleAuth(req: any, res: any, resource: string): Promise<boolean> {
  if (resource !== 'login' && resource !== 'logout' && resource !== 'me') return false;

  const expectedUser = process.env.SITE_BASIC_AUTH_USER;
  const expectedPass = process.env.SITE_BASIC_AUTH_PASS;
  const secret = process.env.SESSION_SECRET;
  if (!expectedUser || !expectedPass || !secret) {
    res.status(500).json({ error: 'server_misconfigured' });
    return true;
  }

  if (resource === 'login') {
    if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return true; }
    const { username, password } = req.body ?? {};
    if (username !== expectedUser || password !== expectedPass) {
      res.status(401).json({ ok: false, error: 'invalid_credentials' });
      return true;
    }
    const token = await createSessionToken(username, secret);
    res.setHeader('Set-Cookie', buildSetCookieHeader(token));
    res.status(200).json({ ok: true });
    return true;
  }

  if (resource === 'logout') {
    if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return true; }
    res.setHeader('Set-Cookie', buildClearCookieHeader());
    res.status(200).json({ ok: true });
    return true;
  }

  // resource === 'me'
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return true; }
  const token = readCookie(req.headers?.cookie, sessionCookieName());
  const username = await verifySessionToken(token, secret);
  res.status(200).json({ authenticated: username !== null });
  return true;
}

export default async function handler(req: any, res: any) {
  const resource = req.query?.resource;
  if (await handleAuth(req, res, resource)) return;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { res.status(500).json({ error: 'server_misconfigured' }); return; }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

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
  if (resource === 'shadow-health') return handleShadowHealth(req, res, supabase);
  if (resource === 'start-forward-validation') return handleStartForwardValidation(req, res, supabase);
  if (resource === 'stop-forward-validation') return handleStopForwardValidation(req, res, supabase);
  res.status(400).json({ error: 'bad_request', message: 'Unknown or missing ?resource=.' });
}
