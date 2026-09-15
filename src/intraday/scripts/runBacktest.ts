/**
 * Intraday Backtest Engine (spec §46) — walks the EXACT live signal/
 * execution/exit logic forward through real historical 5-min candles.
 * Imports every scoring/setup/regime/execution function directly from
 * api/intraday.js's own named exports (evaluateIntradaySignal above
 * all) — the live endpoint's logic IS the thing under test here, not a
 * second reimplementation that could quietly drift out of sync (the
 * same reasoning the swing backtest states for reusing its own live
 * pieces).
 *
 * Methodology, stated plainly rather than left implicit:
 *  - Signal-level, not portfolio-level: each symbol/day is simulated
 *    independently. No cross-symbol max_open_positions/sector caps are
 *    enforced — there's no shared capital ledger across an arbitrary
 *    multi-symbol, multi-day run. See backtest/metrics.ts for why this
 *    also means no drawdown/Sharpe are reported, only R-multiple stats.
 *  - Cross-sectional context (relative strength vs NIFTY, sector
 *    strength, breadth) is computed only across the symbols THIS run
 *    was given, not the full ~150-stock live universe — fetching
 *    historical candles for 150 stocks across a date range is well
 *    beyond Kite's historical rate limit and a reasonable runtime. A
 *    small, deliberately-chosen basket (a sector, a watchlist) gives a
 *    more meaningful cross-sectional reading than a large one run
 *    through this same approximation would.
 *  - A "signal" only counts on the bar a symbol's status TRANSITIONS
 *    into SIGNAL_CONFIRMED with no position currently open for it, not
 *    every bar it stays confirmed — same reasoning as the swing
 *    backtest's isNewSignal check.
 *  - A symbol's own previous-day close/volume context comes from
 *    daily_ohlcv/indicators (append-only, so already point-in-time by
 *    construction). NIFTY/BANK NIFTY's own previous close comes from a
 *    daily-interval Kite historical fetch instead, since this schema's
 *    daily_ohlcv is equity-only.
 *  - Bar-index alignment assumption: bar i is assumed to represent the
 *    same 5-minute window across every symbol and both indices on a
 *    given day (true in practice for actively-traded NSE names/indices,
 *    which get a bar every interval even if quiet) — the day's shared
 *    loop bound is the MINIMUM bar count across everything fetched that
 *    day, so a short/gappy series can only shorten the day, never cause
 *    an out-of-bounds read.
 *  - Costs and slippage (backtest/costs.ts) are applied per trade
 *    against a fixed notional --capital (default ₹100,000), sized via
 *    the exact same computePositionSize the live Execution Engine uses.
 *  - No look-ahead: signal generation at bar index i only ever reads
 *    bars[0..i] for every symbol and index; simulateIntradayExit is the
 *    one place allowed to look forward, exactly as the swing backtest's
 *    simulateTrade is the one place there.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types \
 *     src/intraday/scripts/runBacktest.ts SYMBOL1,SYMBOL2,... FROM_DATE TO_DATE [capital]
 *
 *   e.g. node --env-file=.env --experimental-strip-types \
 *     src/intraday/scripts/runBacktest.ts RELIANCE,INFY,TCS,HDFCBANK 2026-08-01 2026-09-10 100000
 */
import { createClient } from '@supabase/supabase-js';
import {
  ema, atr, computeSessionVWAP, computeOpeningRange,
  regimeFromIndices, rvolScoreFor, vwapPositionScore, relativeStrengthScoreFor, regimeAlignmentScore,
  computeSectorScores, sectorScoreFor,
  computePositionSize, parseSquareOffMinutes,
  istMinutesOfDay, sessionFractionElapsed,
  kiteQuote, kiteHistorical,
  evaluateIntradaySignal,
  DEFAULT_SETTINGS,
} from '../../../api/intraday.js';
import { simulateIntradayExit } from '../backtest/simulate.ts';
import { computeIntradayRoundTripCosts, applySlippage } from '../backtest/costs.ts';
import { computeIntradayMetrics, scoreBucketFor, groupBy } from '../backtest/metrics.ts';
import type { SimulatedIntradayTrade } from '../backtest/types.ts';
import type { IntradayBar, Direction } from '../types.ts';

const MIN_ASOF_IDX = 20; // enough bars for EMA20 to mean something
const NIFTY_SYMBOL = 'NSE:NIFTY 50';
const BANKNIFTY_SYMBOL = 'NSE:NIFTY BANK';
const KITE_DELAY_MS = 250; // stay well under Kite's historical-API rate limit across a whole run

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

interface DailyRow { symbol: string; date: string; close: number }
function prevValueBefore(list: DailyRow[] | undefined, date: string): number | null {
  if (!list) return null;
  let result: number | null = null;
  for (const row of list) { if (row.date < date) result = row.close; else break; }
  return result;
}

interface SymbolDayContext {
  bars: IntradayBar[];
  ema9: (number | null)[];
  ema20: (number | null)[];
  vwap: number[];
  prevClose: number;
  volAvg20: number | null;
  sector: string | null;
  cumVol: number[];
}

function summarize(trades: SimulatedIntradayTrade[]) {
  const overall = computeIntradayMetrics(trades);
  const byScoreBucket = Object.fromEntries(
    [...groupBy(trades, (t) => scoreBucketFor(t.score))].map(([bucket, ts]) => [bucket, computeIntradayMetrics(ts)]),
  );
  const bySetupType = Object.fromEntries(
    [...groupBy(trades, (t) => t.setupType)].map(([setup, ts]) => [setup, computeIntradayMetrics(ts)]),
  );
  const byRegime = Object.fromEntries(
    [...groupBy(trades, (t) => t.regime as string)].map(([regime, ts]) => [regime, computeIntradayMetrics(ts)]),
  );
  const byConfidence = Object.fromEntries(
    [...groupBy(trades, (t) => t.confidence as string)].map(([c, ts]) => [c, computeIntradayMetrics(ts)]),
  );
  const byExitReason = Object.fromEntries(
    [...groupBy(trades, (t) => t.exitReason as string)].map(([r, ts]) => [r, ts.length]),
  );
  return { overall, byScoreBucket, bySetupType, byRegime, byConfidence, byExitReason };
}

function fmtMetrics(m: ReturnType<typeof computeIntradayMetrics>): string {
  const pct = (v: number | null) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
  const r = (v: number | null) => v == null ? '—' : v.toFixed(2);
  return `n=${m.count}  win%=${pct(m.winRateNet)}  PF=${r(m.profitFactorNet)}  expectancy=${r(m.expectancyRNet)}R  avgCost=${m.avgCostAsPctOfRisk?.toFixed(1) ?? '—'}%ofRisk`;
}

async function main() {
  const [symbolsArg, fromArg, toArg, capitalArg] = process.argv.slice(2);
  if (!symbolsArg || !fromArg || !toArg) {
    console.error('Usage: runBacktest.ts SYMBOL1,SYMBOL2,... FROM_DATE TO_DATE [capital]');
    process.exit(1);
  }
  const symbols = [...new Set(symbolsArg.split(',').map((s) => s.trim().toUpperCase()))];
  const capital = Number(capitalArg ?? 100_000);
  const settings = { ...DEFAULT_SETTINGS, capital };
  const squareOffMinutes = parseSquareOffMinutes(settings.square_off_time);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const apiKey = process.env.KITE_API_KEY;
  const { data: session } = await supabase.from('kite_session').select('access_token').eq('id', 1).maybeSingle();
  const token = session?.access_token as string | undefined;
  if (!apiKey || !token) throw new Error('No Kite session — connect Kite in the app first.');
  const ctx = { token, apiKey };

  console.log(`Intraday Backtest: ${symbols.length} symbols (${symbols.join(', ')}), ${fromArg}..${toArg}, capital=₹${capital}`);

  console.log('Resolving NIFTY/BANK NIFTY instrument tokens...');
  const idxQuotes = await kiteQuote([NIFTY_SYMBOL, BANKNIFTY_SYMBOL], ctx);
  const niftyToken = idxQuotes[NIFTY_SYMBOL]?.instrument_token;
  const bankNiftyToken = idxQuotes[BANKNIFTY_SYMBOL]?.instrument_token;
  if (!niftyToken || !bankNiftyToken) throw new Error('Could not resolve NIFTY/BANK NIFTY instrument tokens from Kite.');

  console.log('Loading symbol metadata (sector, instrument_token)...');
  const { data: stocksRows } = await supabase.from('stocks').select('symbol,sector,instrument_token').in('symbol', symbols);
  const metaBySymbol = new Map((stocksRows ?? []).map((r: any) => [r.symbol, r]));
  const testableSymbols = symbols.filter((s) => metaBySymbol.get(s)?.instrument_token);
  const missing = symbols.filter((s) => !testableSymbols.includes(s));
  if (missing.length) console.warn(`  No instrument_token for: ${missing.join(', ')} — skipping.`);
  if (testableSymbols.length === 0) throw new Error('No testable symbols (none have an instrument_token in `stocks`).');

  console.log('Loading trading-day calendar from daily_ohlcv...');
  const { data: dateRows } = await supabase.from('daily_ohlcv').select('date').gte('date', fromArg).lte('date', toArg).order('date', { ascending: true });
  const tradingDays = [...new Set((dateRows ?? []).map((r: any) => r.date as string))];
  console.log(`  ${tradingDays.length} trading days.`);
  if (tradingDays.length === 0) throw new Error('No trading days found in daily_ohlcv for that range.');

  console.log('Loading prior close/volume history for point-in-time universe context...');
  const bufferFrom = new Date(new Date(fromArg).getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [{ data: ohlcvHist }, { data: indHist }] = await Promise.all([
    supabase.from('daily_ohlcv').select('symbol,date,close').in('symbol', testableSymbols).gte('date', bufferFrom).lte('date', toArg).order('date', { ascending: true }),
    supabase.from('indicators').select('symbol,date,vol_avg20').in('symbol', testableSymbols).gte('date', bufferFrom).lte('date', toArg).order('date', { ascending: true }),
  ]);
  const closeHistBySymbol = new Map<string, DailyRow[]>();
  for (const r of (ohlcvHist ?? []) as any[]) {
    const list = closeHistBySymbol.get(r.symbol) ?? []; list.push({ symbol: r.symbol, date: r.date, close: r.close }); closeHistBySymbol.set(r.symbol, list);
  }
  const volHistBySymbol = new Map<string, DailyRow[]>();
  for (const r of (indHist ?? []) as any[]) {
    const list = volHistBySymbol.get(r.symbol) ?? []; list.push({ symbol: r.symbol, date: r.date, close: r.vol_avg20 }); volHistBySymbol.set(r.symbol, list);
  }

  console.log('Fetching NIFTY/BANK NIFTY daily closes (for point-in-time previous-close context)...');
  const dailyFrom = `${bufferFrom} 00:00:00`, dailyTo = `${toArg} 23:59:59`;
  const niftyDaily = await kiteHistorical(niftyToken, 'day', dailyFrom, dailyTo, ctx);
  await sleep(KITE_DELAY_MS);
  const bankNiftyDaily = await kiteHistorical(bankNiftyToken, 'day', dailyFrom, dailyTo, ctx);
  await sleep(KITE_DELAY_MS);
  const niftyCloseHist: DailyRow[] = niftyDaily.map((b: any) => ({ symbol: 'NIFTY', date: new Date(b.t).toISOString().slice(0, 10), close: b.c }));
  const bankNiftyCloseHist: DailyRow[] = bankNiftyDaily.map((b: any) => ({ symbol: 'BANKNIFTY', date: new Date(b.t).toISOString().slice(0, 10), close: b.c }));

  const allTrades: SimulatedIntradayTrade[] = [];
  let daysProcessed = 0, daysSkipped = 0;

  for (const date of tradingDays) {
    const from5m = `${date} 09:15:00`, to5m = `${date} 15:30:00`;
    const niftyPrevClose = prevValueBefore(niftyCloseHist, date);
    const bankNiftyPrevClose = prevValueBefore(bankNiftyCloseHist, date);
    if (niftyPrevClose == null || bankNiftyPrevClose == null) { daysSkipped++; continue; }

    let niftyBars: IntradayBar[], bankNiftyBars: IntradayBar[];
    try {
      niftyBars = await kiteHistorical(niftyToken, '5minute', from5m, to5m, ctx); await sleep(KITE_DELAY_MS);
      bankNiftyBars = await kiteHistorical(bankNiftyToken, '5minute', from5m, to5m, ctx); await sleep(KITE_DELAY_MS);
    } catch (e: any) { console.warn(`  ${date}: skipping (index candle fetch failed: ${e.message})`); daysSkipped++; continue; }
    if (niftyBars.length < MIN_ASOF_IDX + 1 || bankNiftyBars.length < MIN_ASOF_IDX + 1) { daysSkipped++; continue; }

    const niftyVwap = computeSessionVWAP(niftyBars);
    const bankNiftyVwap = computeSessionVWAP(bankNiftyBars);

    const symbolDays = new Map<string, SymbolDayContext>();
    for (const symbol of testableSymbols) {
      const meta = metaBySymbol.get(symbol);
      const prevClose = prevValueBefore(closeHistBySymbol.get(symbol), date);
      if (prevClose == null) continue;
      let bars: IntradayBar[];
      try {
        bars = await kiteHistorical(meta.instrument_token, '5minute', from5m, to5m, ctx);
        await sleep(KITE_DELAY_MS);
      } catch (e: any) { console.warn(`  ${date} ${symbol}: candle fetch failed (${e.message})`); continue; }
      if (bars.length < MIN_ASOF_IDX + 1) continue;

      const closes = bars.map((b) => b.c);
      let running = 0;
      const cumVol = bars.map((b) => (running += b.v));
      symbolDays.set(symbol, {
        bars, ema9: ema(closes, 9), ema20: ema(closes, 20), vwap: computeSessionVWAP(bars),
        prevClose, volAvg20: prevValueBefore(volHistBySymbol.get(symbol), date), sector: meta.sector ?? null, cumVol,
      });
    }
    if (symbolDays.size === 0) { daysSkipped++; continue; }

    const minBarCount = Math.min(niftyBars.length, bankNiftyBars.length, ...[...symbolDays.values()].map((d) => d.bars.length));
    const squareOffBarIdx = (() => {
      for (let i = 0; i < minBarCount; i++) if (istMinutesOfDay(niftyBars[i].t) >= squareOffMinutes) return i;
      return minBarCount - 1;
    })();

    const nextAsOfIdxBySymbol = new Map<string, number>();
    const wasConfirmedBySymbol = new Map<string, boolean>();
    for (const symbol of symbolDays.keys()) { nextAsOfIdxBySymbol.set(symbol, MIN_ASOF_IDX); wasConfirmedBySymbol.set(symbol, false); }

    for (let i = MIN_ASOF_IDX; i < minBarCount; i++) {
      const fakeNifty = { last_price: niftyBars[i].c, ohlc: { close: niftyPrevClose }, average_price: niftyVwap[i] };
      const fakeBankNifty = { last_price: bankNiftyBars[i].c, ohlc: { close: bankNiftyPrevClose }, average_price: bankNiftyVwap[i] };

      const entries: Array<{ sector: string | null; returnPct: number; aboveVwap: boolean }> = [];
      for (const [, d] of symbolDays) {
        const price = d.bars[i].c;
        entries.push({ sector: d.sector, returnPct: ((price - d.prevClose) / d.prevClose) * 100, aboveVwap: price > d.vwap[i] });
      }
      const pctStocksAboveVwap = (entries.filter((e) => e.aboveVwap).length / entries.length) * 100;
      const regimeInfo = regimeFromIndices(fakeNifty, fakeBankNifty, pctStocksAboveVwap);
      const sectorScoreMap = computeSectorScores(entries);

      for (const [symbol, d] of symbolDays) {
        const nextAsOfIdx = nextAsOfIdxBySymbol.get(symbol)!;
        if (i < nextAsOfIdx) continue;

        const price = d.bars[i].c;
        const returnPct = ((price - d.prevClose) / d.prevClose) * 100;
        const direction: Direction = returnPct >= 0 ? 'LONG' : 'SHORT';
        const expectedVol = (d.volAvg20 ?? 0) * sessionFractionElapsed(istMinutesOfDay(d.bars[i].t));
        const rvol = expectedVol > 0 ? d.cumVol[i] / expectedVol : null;
        const rankFactors = {
          relativeStrength: relativeStrengthScoreFor(returnPct, regimeInfo.niftyReturnPct),
          volume: rvolScoreFor(rvol),
          vwapPosition: vwapPositionScore(price, d.vwap[i]),
          regimeAlignment: regimeAlignmentScore(regimeInfo.regime, direction),
          sectorStrength: sectorScoreFor(d.sector, sectorScoreMap),
        };

        const barsSoFar = d.bars.slice(0, i + 1);
        const signal = evaluateIntradaySignal({ bars: barsSoFar, direction, regimeInfo, rankFactors, rvol, settings });
        const isConfirmed = signal.status === 'SIGNAL_CONFIRMED';
        const isNewSignal = isConfirmed && !wasConfirmedBySymbol.get(symbol);
        wasConfirmedBySymbol.set(symbol, isConfirmed);

        if (!isNewSignal || signal.entry == null || signal.stop == null || signal.target1 == null || signal.target2 == null) continue;

        const sizing = computePositionSize({
          capital: settings.capital, riskPct: settings.risk_pct_per_trade,
          entry: signal.entry, stop: signal.stop, maxCapitalAllocationPct: settings.max_capital_pct_per_trade,
        });
        if (!sizing.shares || sizing.shares <= 0) { wasConfirmedBySymbol.set(symbol, false); continue; }

        const exit = simulateIntradayExit(
          d.bars, i, direction, signal.setupType as any, signal.entry, signal.stop, signal.target1, signal.target2,
          d.vwap, Math.min(squareOffBarIdx, d.bars.length - 1),
        );

        const entryFill = applySlippage(signal.entry, direction, 'ENTRY');
        const exitFill = applySlippage(exit.exitPrice, direction, 'EXIT');
        const riskPerShare = Math.abs(signal.entry - signal.stop);
        const signedMoveGross = direction === 'LONG' ? exit.exitPrice - signal.entry : signal.entry - exit.exitPrice;
        const signedMoveNet = direction === 'LONG' ? exitFill - entryFill : entryFill - exitFill;
        const costs = computeIntradayRoundTripCosts(entryFill, exitFill, sizing.shares, direction);
        const pnlGross = signedMoveGross * sizing.shares;
        const pnlNet = signedMoveNet * sizing.shares - costs;
        const riskAmount = riskPerShare * sizing.shares;

        allTrades.push({
          symbol, sector: d.sector, date, direction, setupType: signal.setupType as any, score: signal.score,
          confidence: signal.confidence as any, regime: regimeInfo.regime as any,
          entryTime: d.bars[i].t, entryPrice: signal.entry, stop: signal.stop, target1: signal.target1, target2: signal.target2,
          shares: sizing.shares, exitTime: d.bars[exit.exitIdx].t, exitPrice: exit.exitPrice, exitReason: exit.exitReason,
          riskPerShare, rMultipleGross: signedMoveGross / riskPerShare, rMultipleNet: riskAmount > 0 ? pnlNet / riskAmount : 0,
          pnlGross, pnlNet, costs,
        });

        nextAsOfIdxBySymbol.set(symbol, exit.exitIdx + 1);
        wasConfirmedBySymbol.set(symbol, false);
      }
    }

    daysProcessed++;
    if (daysProcessed % 5 === 0 || daysProcessed === tradingDays.length) {
      console.log(`  ${date}: ${daysProcessed}/${tradingDays.length} days processed, ${allTrades.length} trades so far.`);
    }
  }

  console.log(`\nDone: ${daysProcessed} days processed, ${daysSkipped} skipped (no data), ${allTrades.length} simulated trades.\n`);

  const summary = summarize(allTrades);
  console.log('=== Overall ===');
  console.log(' ', fmtMetrics(summary.overall));
  console.log(`  Gross vs net expectancy: ${summary.overall.expectancyRGross?.toFixed(2) ?? '—'}R gross -> ${summary.overall.expectancyRNet?.toFixed(2) ?? '—'}R net`);

  console.log('\n=== By score bucket ===');
  for (const [bucket, m] of Object.entries(summary.byScoreBucket)) console.log(`  ${bucket.padEnd(6)} ${fmtMetrics(m)}`);

  console.log('\n=== By setup type ===');
  for (const [setup, m] of Object.entries(summary.bySetupType)) console.log(`  ${setup.padEnd(22)} ${fmtMetrics(m)}`);

  console.log('\n=== By regime ===');
  for (const [regime, m] of Object.entries(summary.byRegime)) console.log(`  ${regime.padEnd(16)} ${fmtMetrics(m)}`);

  console.log('\n=== By confidence ===');
  for (const [c, m] of Object.entries(summary.byConfidence)) console.log(`  ${c.padEnd(8)} ${fmtMetrics(m)}`);

  console.log('\n=== Exit reasons ===');
  for (const [reason, n] of Object.entries(summary.byExitReason)) console.log(`  ${reason.padEnd(16)} ${n}`);

  console.log('\nWriting run summary to intraday_backtest_runs (best-effort)...');
  try {
    const { error } = await supabase.from('intraday_backtest_runs').insert({
      symbols: testableSymbols, from_date: fromArg, to_date: toArg, capital,
      params: { minAsOfIdx: MIN_ASOF_IDX, squareOffTime: settings.square_off_time },
      summary: { daysProcessed, daysSkipped, tradeCount: allTrades.length, ...summary },
    });
    if (error) console.warn(`  Could not persist (run: intraday/schema.sql's intraday_backtest_runs migration?): ${error.message}`);
    else console.log('  Saved.');
  } catch (e: any) {
    console.warn(`  Could not persist: ${e.message}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
