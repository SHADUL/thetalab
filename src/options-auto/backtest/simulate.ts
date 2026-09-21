/**
 * Walks a symbol's historical bhavcopy day-by-day through the EXACT
 * production decision pipeline (normalise -> enrichChain -> evaluateExpiries
 * -> decideTrade) and the EXACT production exit engine (evaluateExit) —
 * no reimplementation, same discipline as src/swing's and src/intraday's
 * own backtests reusing their live scanner/exit functions directly, so
 * there is no second "backtest version" of this logic to drift out of
 * sync with what's actually live.
 *
 * One position at a time, deliberately: this backtest doesn't attempt
 * concurrent-position capital allocation. That's a real, stated
 * simplification — but a deliberate one, because it's exactly what makes
 * a genuine chronological equity curve (and therefore real drawdown,
 * Sharpe/Sortino, Monte Carlo) honest to compute here, unlike swing's and
 * intraday's signal-level backtests, which explicitly cannot support
 * those metrics because they have no single coherent portfolio (see
 * src/swing/backtest/metrics.ts's and src/intraday/backtest/metrics.ts's
 * own stated reasoning for excluding them). See metrics.ts for that.
 *
 * Point-in-time discipline: signal generation at day i only ever sees
 * that day's own bhavcopy — the SAME data a live paper-scan on that
 * historical date would have seen (settlement/OI/volume, no bid/ask,
 * which is exactly what enrichChain() already treats as its baseline
 * case). Re-quoting an open position's legs on day i+1, i+2, ... is the
 * one place allowed to "look forward" relative to the entry day — the
 * same discipline swing's simulateTrade() and intraday's
 * simulateIntradayExit() already establish for their own one-place-only
 * forward look.
 */
import { normalise, type RawChainPayload } from '../../quant/data/adapter.ts';
import { enrichChain } from '../../quant/enrich.ts';
import { evaluateExpiries } from '../../quant/strategies/expirySelector.ts';
import { decideTrade, DEFAULT_DECISION_THRESHOLDS, type DecisionThresholds } from '../../quant/strategies/decisionGate.ts';
import { evaluateExit, DEFAULT_EXIT_PARAMS, type ShortStrike } from '../../quant/execution/exitEngine.ts';
import { computeRoundTripLegCharges } from './costs.ts';
import type { HistoricalChainDay } from './bhavcopy.ts';

export interface SimulatedLeg {
  side: 'BUY' | 'SELL';
  right: 'CE' | 'PE';
  strike: number;
  entryPrice: number;
  exitPrice: number | null;
}

export interface SimulatedTrade {
  symbol: string;
  strategyLabel: string;
  entryDate: string;
  exitDate: string | null;
  expiry: string;
  legs: SimulatedLeg[];
  qualityScore: number;
  entryDte: number;
  /** Per ONE lot (this backtest always sizes 1 lot — see header). */
  maxProfit: number;
  maxLoss: number;
  /** ExitReason from exitEngine.ts, or 'DATA_END' when the backtest window ran out before any real exit condition triggered — never counted as a genuine win/loss. */
  exitReason: string | null;
  /** (maxProfit - exitCostToClose), price-only, before charges. Null only for a DATA_END trade with no valid re-quote at all. */
  grossPnl: number | null;
  charges: number | null;
  netPnl: number | null;
}

export interface SimulateParams {
  wingWidths: number[];
  deltaTargets?: number[];
  minDte?: number;
  maxDte?: number;
  qualityThresholds?: DecisionThresholds;
  exitParams?: {
    profitTargetPct?: number;
    stopLossCreditMultiple?: number;
    timeExitDte?: number;
    strikeBreachBufferPct?: number;
  };
}

interface OpenTrade {
  strategyLabel: string;
  entryDate: string;
  expiry: string;
  legs: SimulatedLeg[];
  qualityScore: number;
  entryDte: number;
  maxProfit: number;
  maxLoss: number;
  lotSize: number;
}

function buildChainPayload(day: HistoricalChainDay, symbol: string): RawChainPayload | null {
  if (!day.spot || day.rows.length === 0) return null;
  const valuationTime = Date.parse(`${day.date}T15:30:00+05:30`);
  const step = inferStrikeStep([...new Set(day.rows.map((r) => r.strike))].sort((a, b) => a - b));
  return {
    source: { providerId: 'nse-bse-bhavcopy', kind: 'eod', retrievedAt: valuationTime },
    contract: {
      underlyingSymbol: symbol,
      lotSize: day.lotSize && day.lotSize > 0 ? day.lotSize : 1,
      pointValue: 1,
      strikeStep: step,
      currency: 'INR',
      exerciseStyle: 'european',
      pricingBasis: 'futures',
    },
    context: { valuationTime, spot: day.spot, futures: null, riskFreeRate: 0.065, dividendYield: 0 },
    rows: day.rows.map((r) => ({
      right: r.right, strike: r.strike, expiry: Date.parse(`${r.expiry}T15:30:00+05:30`), asOf: valuationTime,
      settle: r.settle, openInterest: r.openInterest, volume: r.volume,
    })),
  };
}

function inferStrikeStep(sortedStrikes: number[]): number {
  let step = Infinity;
  for (let i = 1; i < sortedStrikes.length; i++) step = Math.min(step, sortedStrikes[i] - sortedStrikes[i - 1]);
  return Number.isFinite(step) && step > 0 ? step : 50;
}

function finalizeTrade(open: OpenTrade, symbol: string, exitDate: string, exitReason: string, currentCostToClose: number | null): SimulatedTrade {
  let grossPnl: number | null = null;
  let charges: number | null = null;
  let netPnl: number | null = null;

  // Only compute costs when every leg genuinely has a real exit price —
  // if even one is missing (a leg's quote wasn't found that day), the
  // whole trade's P&L is reported as unknown rather than partially
  // estimated from a mix of real and absent prices.
  const everyLegPriced = open.legs.every((l) => l.exitPrice !== null);
  if (currentCostToClose !== null && everyLegPriced) {
    grossPnl = open.maxProfit - currentCostToClose;
    charges = open.legs.reduce((sum, l) => {
      const entryTurnover = l.entryPrice * open.lotSize;
      const exitTurnover = l.exitPrice! * open.lotSize;
      return sum + computeRoundTripLegCharges(l.side, entryTurnover, exitTurnover);
    }, 0);
    netPnl = grossPnl - charges;
  }

  return {
    symbol, strategyLabel: open.strategyLabel, entryDate: open.entryDate, exitDate, expiry: open.expiry,
    legs: open.legs, qualityScore: open.qualityScore, entryDte: open.entryDte,
    maxProfit: open.maxProfit, maxLoss: open.maxLoss,
    exitReason, grossPnl, charges, netPnl,
  };
}

export function simulateSymbol(days: HistoricalChainDay[], symbol: string, params: SimulateParams): SimulatedTrade[] {
  const trades: SimulatedTrade[] = [];
  let open: OpenTrade | null = null;
  const thresholds = params.qualityThresholds ?? DEFAULT_DECISION_THRESHOLDS;
  const exitParams = { ...DEFAULT_EXIT_PARAMS, ...params.exitParams };

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const isLastDay = i === days.length - 1;

    if (open) {
      const rowsByKey = new Map(day.rows.map((r) => [`${r.strike}:${r.right}:${r.expiry}`, r]));
      let currentCostToClose = 0;
      let missing = false;
      for (const leg of open.legs) {
        const row = rowsByKey.get(`${leg.strike}:${leg.right}:${open.expiry}`);
        if (!row) { missing = true; break; }
        currentCostToClose += (leg.side === 'SELL' ? 1 : -1) * row.settle * open.lotSize;
      }

      if (!missing) {
        const dte = Math.round((Date.parse(`${open.expiry}T00:00:00Z`) - Date.parse(`${day.date}T00:00:00Z`)) / 86_400_000);
        const shortStrikes: ShortStrike[] = open.legs.filter((l) => l.side === 'SELL').map((l) => ({ strike: l.strike, right: l.right }));
        const decision = day.spot
          ? evaluateExit({ maxProfit: open.maxProfit, maxLoss: open.maxLoss, currentCostToClose, dte, underlyingPrice: day.spot, shortStrikes, ...exitParams })
          : null;

        if (decision?.action === 'CLOSE') {
          const legsWithExit = open.legs.map((l) => {
            const row = rowsByKey.get(`${l.strike}:${l.right}:${open!.expiry}`);
            return { ...l, exitPrice: row?.settle ?? null };
          });
          trades.push(finalizeTrade({ ...open, legs: legsWithExit }, symbol, day.date, decision.reason ?? 'UNKNOWN', currentCostToClose));
          open = null;
          continue;
        }
        if (isLastDay) {
          const legsWithExit = open.legs.map((l) => {
            const row = rowsByKey.get(`${l.strike}:${l.right}:${open!.expiry}`);
            return { ...l, exitPrice: row?.settle ?? null };
          });
          trades.push(finalizeTrade({ ...open, legs: legsWithExit }, symbol, day.date, 'DATA_END', currentCostToClose));
          open = null;
          continue;
        }
      } else if (isLastDay) {
        trades.push(finalizeTrade(open, symbol, day.date, 'DATA_END', null));
        open = null;
      }
      continue; // one position at a time — never also evaluate a new entry on a day a position is open
    }

    // No open position: try to enter.
    const payload = buildChainPayload(day, symbol);
    if (!payload) continue;
    const { chain } = normalise(payload);
    const enriched = enrichChain(chain);
    if (enriched.slices.length === 0) continue;

    const step = enriched.slices[0].quotes.length
      ? inferStrikeStep([...new Set(enriched.slices[0].quotes.map((q) => q.quote.strike))].sort((a, b) => a - b))
      : 50;
    const evaluations = evaluateExpiries(enriched, {
      wingWidths: params.wingWidths.length ? params.wingWidths : [2, 4, 6].map((m) => m * step),
      deltaTargets: params.deltaTargets,
      minDte: params.minDte, maxDte: params.maxDte,
      lotSize: 1, // priced per single contract here; day.lotSize applied when computing rupee P&L
      ivRank: null,
    });
    const decision = decideTrade(evaluations, thresholds);
    if (decision.action === 'NO_TRADE' || !decision.expiryEvaluation?.best) continue;

    const best = decision.expiryEvaluation.best;
    const lotSize = day.lotSize && day.lotSize > 0 ? day.lotSize : 1;
    open = {
      strategyLabel: decision.expiryEvaluation.strategyLabel,
      entryDate: day.date,
      expiry: new Date(decision.expiryEvaluation.expiry).toISOString().slice(0, 10),
      legs: best.result.legs.map((l) => ({ side: l.side, right: l.right, strike: l.strike, entryPrice: l.price, exitPrice: null })),
      qualityScore: best.qualityScore.score,
      entryDte: decision.expiryEvaluation.dte,
      maxProfit: best.result.maxProfit * lotSize,
      maxLoss: best.result.maxLoss * lotSize,
      lotSize,
    };
  }

  return trades;
}
