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
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { parseKiteOptionsCSV, filterActiveInstruments, OPTIONS_SYMBOLS } from '../src/lib/optionsInstrumentMaster.js';
import { buildBasketMarginRequest, parseBasketMarginResponse, checkMarginSufficient } from '../src/lib/optionsMargin.js';
import { selectStrikesNearSpot, chunk, kiteQuoteToOptionRow, buildInstrumentKeys, MAX_QUOTE_INSTRUMENTS } from '../src/lib/optionsChainLive.js';
import { normalise, type RawChainPayload } from '../src/quant/data/adapter.ts';
import { enrichChain } from '../src/quant/enrich.ts';
import { evaluateExpiries } from '../src/quant/strategies/expirySelector.ts';
import type { HistoricalClose } from '../src/quant/analytics/realizedVolatility.ts';
import { decideTrade, type DecisionThresholds } from '../src/quant/strategies/decisionGate.ts';
import { computePositionSize, type PortfolioState, type OpenPositionSummary } from '../src/quant/strategies/positionSizing.ts';
import { runPreTradeValidation } from '../src/quant/execution/preTradeValidation.ts';
import { runPaperExecution, type PlannedLeg } from '../src/quant/execution/paperFill.ts';
import { evaluateExit, type ShortStrike } from '../src/quant/execution/exitEngine.ts';
import { checkDailyRiskLock } from '../src/quant/execution/dailyRiskLock.ts';

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

  const log = (level: 'info' | 'error', message: string, detail?: unknown) =>
    supabase.from('options_autotrade_log').insert({ level, message, detail: detail ?? null });

  const { data: settings } = await supabase.from('options_autotrade_settings').select('*').eq('id', 1).maybeSingle();
  if (!settings) { res.status(500).json({ ok: false, error: 'settings_not_found' }); return; }
  if (settings.execution_mode !== 'PAPER') {
    res.status(200).json({ ok: true, skipped: `execution_mode is '${settings.execution_mode}', not PAPER` });
    return;
  }

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

  const allExpiries = [...new Set(instrumentRows.map((r: any) => r.expiry as string))].sort();
  const eligibleExpiries = allExpiries.filter((expiry) => {
    const dte = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${todayIST}T00:00:00Z`)) / 86_400_000);
    return dte >= settings.min_dte && dte <= settings.max_dte;
  });
  if (!eligibleExpiries.length) {
    res.status(200).json({ ok: true, skipped: 'no_eligible_expiries', allExpiries });
    return;
  }

  // 2. Spot price for the underlying.
  const indexKey = INDEX_QUOTE_KEY[symbol];
  let spotData: any;
  try {
    spotData = await kiteFetch(`/quote?i=${encodeURIComponent(indexKey)}`, { token, apiKey });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: 'kite_error', message: err.message });
    return;
  }
  const spot = spotData?.[indexKey]?.last_price;
  if (!(spot > 0)) { res.status(502).json({ ok: false, error: 'no_spot_price' }); return; }

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

  // 3. Build the live chain: for each eligible expiry, select strikes near
  // spot from the synced instruments, batch-fetch quotes, map into rows.
  const lotSize = instrumentRows.find((r: any) => r.expiry === eligibleExpiries[0])?.lot_size ?? null;
  const rows: any[] = [];
  const now = Date.now();

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

    for (const batch of chunk(keys, MAX_QUOTE_INSTRUMENTS)) {
      let quoteData: any;
      try {
        quoteData = await kiteFetch(`/quote?${batch.map((k: string) => `i=${encodeURIComponent(k)}`).join('&')}`, { token, apiKey });
      } catch (err: any) {
        await log('error', 'Live quote batch failed during paper-scan', { symbol, expiry, message: err.message });
        continue;
      }
      for (const key of batch) {
        const meta = byKey.get(key);
        const quote = quoteData?.[key];
        if (!meta || !quote) continue;
        rows.push(kiteQuoteToOptionRow({ strike: meta.strike, right: meta.right, expiryEpochMs, asOfEpochMs: now, quote }));
      }
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

  // 4. Run the decision pipeline (skew -> strategy -> optimizer -> expiry
  // selection -> quality score). No live IV-rank history is wired into
  // this endpoint yet (see decisionGate.ts's own handling of a null
  // ivRank — it's excluded and renormalized, not fabricated). premiumEdge
  // IS wired, from the real historicalCloses fetched above.
  const step = enriched.slices[0]?.forward ? inferStrikeStep(enriched.slices[0].quotes.map((q) => q.quote.strike)) : 50;
  const wingWidths = [2, 4, 6].map((m) => m * step);
  const evaluations = evaluateExpiries(enriched, {
    lotSize: lotSize && lotSize > 0 ? lotSize : 1,
    wingWidths,
    minDte: settings.min_dte,
    maxDte: settings.max_dte,
    ivRank: null,
    historicalCloses,
  });
  const thresholds: DecisionThresholds = {
    noTradeBelow: settings.no_trade_below,
    watchBelow: settings.watch_below,
    highConvictionAtOrAbove: settings.high_conviction_at_or_above,
  };
  const decision = decideTrade(evaluations, thresholds);
  const diagnostics = {
    spot, symbol, scannedAt: new Date(now).toISOString(),
    eligibleExpiries, rejectedRows: rejected.length,
    historicalClosesFetched: historicalCloses.length,
    evaluations: evaluations.map(serializeExpiryEvaluation),
  };

  await log('info', `Paper-scan decision for ${symbol}: ${decision.action}`, { rejectedRows: rejected.length, decision: decision.explanation });

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

  const sizing = computePositionSize(
    {
      pricing: { maxLoss: best.result.maxLoss, maxProfit: best.result.maxProfit, netCredit: best.result.netCredit, netGreeks: best.result.netGreeks },
      marginRequiredPerLot,
      underlyingGroup: candidateSymbolGroup,
    },
    { equity: Number(settings.reserved_fund) || 0, availableFunds: Number(settings.reserved_fund) || 0 },
    portfolio,
    {
      maxRiskPerTradePct: settings.max_risk_per_trade_pct, maxDailyLossPct: settings.max_daily_loss_pct,
      maxWeeklyLossPct: settings.max_weekly_loss_pct, maxPortfolioRiskPct: settings.max_portfolio_risk_pct,
      maxMarginUtilizationPct: settings.max_margin_utilization_pct, maxPositions: settings.max_positions,
      maxUnderlyingDelta: settings.max_underlying_delta, maxGamma: settings.max_gamma, maxVega: settings.max_vega,
      maxCorrelatedGroupRiskPct: settings.max_correlated_group_risk_pct,
    },
  );

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

  const paperResult = runPaperExecution(legs, validation);

  if (paperResult.state !== 'ACTIVE') {
    await log('info', `Paper position not opened for ${symbol}`, { reason: paperResult.log });
    res.status(200).json({ ok: true, action: decision.action, opened: false, validation, sizing, log: paperResult.log, diagnostics });
    return;
  }

  const { data: inserted, error: insertErr } = await supabase.from('options_autotrade_positions').insert({
    symbol, strategy_label: decision.expiryEvaluation.strategyLabel,
    expiry: expiryDateStr,
    status: 'ACTIVE', execution_state: paperResult.state, protection: paperResult.protection,
    lots: sizing.lots, net_credit: best.result.netCredit, max_profit: sizing.sizedMaxProfit, max_loss: sizing.sizedMaxLoss,
    margin_required: sizing.sizedMarginRequired,
    net_delta: (best.result.netGreeks.delta ?? 0) * sizing.lots, net_gamma: (best.result.netGreeks.gamma ?? 0) * sizing.lots,
    net_theta: (best.result.netGreeks.theta ?? 0) * sizing.lots, net_vega: (best.result.netGreeks.vega ?? 0) * sizing.lots,
    quality_score: best.qualityScore.score, decision_explanation: decision.explanation,
    entry_date: todayIST,
  }).select('id').single();

  if (insertErr) { res.status(502).json({ ok: false, error: 'supabase_error', message: insertErr.message }); return; }

  const legRows = paperResult.legFills.map((l) => ({
    position_id: inserted.id, side: l.side, option_right: l.right, strike: l.strike,
    tradingsymbol: l.tradingsymbol, quantity: l.quantity, fill_price: l.fillPrice, status: l.status,
  }));
  await supabase.from('options_autotrade_legs').insert(legRows);
  await log('info', `Opened PAPER position #${inserted.id}: ${decision.expiryEvaluation.strategyLabel} on ${symbol}, ${sizing.lots} lot(s).`);

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

  const log = (level: 'info' | 'error', message: string, detail?: unknown) =>
    supabase.from('options_autotrade_log').insert({ level, message, detail: detail ?? null });

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
    if (missingQuote) { await log('error', `Position #${p.id}: could not re-quote every leg — skipped this cycle.`); continue; }

    const underlyingPrice = quoteMap.get(indexKeys[p.symbol])?.last_price;
    if (!(underlyingPrice > 0)) { await log('error', `Position #${p.id}: no live spot price for ${p.symbol} — skipped this cycle.`); continue; }

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

    const realizedPnl = (Number(p.max_profit) || 0) - currentCostToClose;
    const { error: updateErr } = await supabase.from('options_autotrade_positions').update({
      status: 'CLOSED', execution_state: 'CLOSED', exit_date: todayIST, exit_reason: decision.reason,
      realized_pnl: realizedPnl, updated_at: new Date().toISOString(),
    }).eq('id', p.id);
    if (updateErr) { await log('error', `Position #${p.id}: failed to persist close`, { message: updateErr.message }); continue; }

    const { data: dailyRow } = await supabase.from('options_autotrade_daily_stats').select('realized_pnl,consecutive_losses').eq('trade_date', todayIST).maybeSingle();
    await supabase.from('options_autotrade_daily_stats').upsert({
      trade_date: todayIST,
      realized_pnl: (Number(dailyRow?.realized_pnl) || 0) + realizedPnl,
      consecutive_losses: realizedPnl < 0 ? (Number(dailyRow?.consecutive_losses) || 0) + 1 : 0,
    });

    await log('info', `Closed PAPER position #${p.id} (${p.symbol} ${p.strategy_label}): ${decision.reason} — realized P&L ₹${realizedPnl.toFixed(0)}.`);
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
    if (body.execution_mode !== undefined && !['OFF', 'PAPER'].includes(body.execution_mode)) {
      res.status(400).json({ error: 'bad_request', message: `execution_mode must be OFF or PAPER — ALERT_ONLY/SEMI_AUTO/AUTO aren't implemented yet.` });
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
  const { count } = await supabase.from('options_autotrade_positions').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE');
  res.status(200).json({
    ok: true,
    message: `New entries stopped (execution_mode set to OFF).${count ? ` ${count} paper position(s) remain open — position-monitor's exit engine keeps evaluating them independently on its own 5-min cron.` : ' No open positions.'}`,
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
  if (resource === 'log') return handleLog(req, res, supabase);
  if (resource === 'kill-switch') return handleKillSwitch(req, res, supabase);
  if (resource === 'daily-stats') return handleDailyStats(req, res, supabase);
  if (resource === 'clear-daily-lock') return handleClearDailyLock(req, res, supabase);

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
  res.status(400).json({ error: 'bad_request', message: 'Unknown or missing ?resource=.' });
}
