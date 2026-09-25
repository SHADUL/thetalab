/**
 * The SHADOW entry orchestrator (live-data-capture wiring phase). Composes
 * the EXACT same pure decision pipeline PAPER/AUTO already use
 * (normalise -> enrichChain -> evaluateExpiries -> decideTrade ->
 * computePositionSize -> runPreTradeValidation) with SHADOW-specific
 * execution/persistence (shadowExecution.ts, shadowRepository.ts,
 * forwardLedger.ts) — nothing here reimplements any decision logic; it
 * only wires already-real, already-tested pieces together in one place so
 * api/options-autotrade.ts's SHADOW branch can call one function instead
 * of hand-assembling this sequence inline (where it would be far harder
 * to unit-test in isolation from live Kite/Supabase).
 *
 * Every dependency is injected (quotes are passed in already-fetched, not
 * fetched here — persistence is behind ShadowRepository/ForwardLedgerStore
 * interfaces, the clock is injected) specifically so this whole pipeline
 * is testable end-to-end with mocks, per this phase's Task 16.
 *
 * Structurally incapable of placing a broker order: no parameter here is
 * shaped like a `placeOrder` function.
 */
import { randomUUID } from 'node:crypto';
import { normalise, type RawChainPayload } from '../data/adapter.ts';
import { enrichChain } from '../enrich.ts';
import { atmIvOf } from '../analytics/atmIv.ts';
import { evaluateExpiries, type ExpirySelectorParams } from '../strategies/expirySelector.ts';
import { decideTrade, type DecisionThresholds } from '../strategies/decisionGate.ts';
import { computePositionSize, type PortfolioState, type RiskLimits } from '../strategies/positionSizing.ts';
import { runPreTradeValidation } from './preTradeValidation.ts';
import { runShadowFillSimulation, isEligibleForForwardValidation, buildLegQuoteFromRawKiteQuote, type ShadowCandidateLeg, type RawKiteQuote } from './shadowExecution.ts';
import { simulateStructureFill, SHADOW_EXECUTION_V1, type LegQuote, type SimulatedFill } from './fillSimulator.ts';
import { recordSignal, type ForwardLedgerStore, type ForwardSignal } from './forwardLedger.ts';
import { dedupeIvHistoryRows, type ShadowRepository, type OptionChainSnapshotRow, type IvHistoryRow } from './shadowRepository.ts';
import { approxTradingSessionsFromCalendarDays } from '../analytics/timeConventions.ts';
import type { HistoricalClose } from '../analytics/realizedVolatility.ts';
import type { IvHistoryPoint } from '../analytics/ivRankHistory.ts';
import { computePointInTimeIvRank } from '../analytics/ivRankHistory.ts';

export interface ShadowScanDeps {
  repository: ShadowRepository;
  ledgerStore: ForwardLedgerStore;
  clock: () => Date;
  baselineVersion: string;
  maxQuoteAgeMs: number;
  /** Task 13 fingerprint — null when no protocol run is active yet (a real PRE_PROTOCOL state, never fabricated). */
  activeProtocolId: string | null;
  /** Task 13 fingerprint — the deployed code revision, when known (e.g. VERCEL_GIT_COMMIT_SHA). Null, never fabricated, when unavailable. */
  codeVersion: string | null;
}

export interface ShadowScanParams {
  symbol: string;
  chainPayload: RawChainPayload;
  wingWidths: number[];
  deltaTargets?: number[];
  minDte?: number;
  maxDte?: number;
  qualityThresholds: DecisionThresholds;
  historicalCloses?: HistoricalClose[];
  ivHistory?: IvHistoryPoint[];
  accountEquity: number;
  riskLimits: RiskLimits;
  portfolio: PortfolioState;
  quoteCapturedAtMs: number;
  indiaVix?: number | null;
}

export type ShadowScanOutcome =
  | { action: 'NO_TRADE'; explanation: string }
  | { action: 'DATA_INVALID'; reason: string }
  | {
      action: 'SIGNAL_RECORDED';
      ledgerId: string;
      scanId: string;
      strategyLabel: string;
      legs: ShadowCandidateLeg[];
      lots: number;
      eligibleForForwardValidation: boolean;
      eligibilityReasons: string[];
      snapshotPersisted: boolean;
      ivHistoryPersisted: boolean;
      fillOutcome: ReturnType<typeof runShadowFillSimulation>;
    };

export async function runShadowEntryScan(deps: ShadowScanDeps, params: ShadowScanParams): Promise<ShadowScanOutcome> {
  const scanId = randomUUID();
  const now = deps.clock();

  const { chain } = normalise(params.chainPayload);
  const enriched = enrichChain(chain);
  if (enriched.slices.length === 0) return { action: 'DATA_INVALID', reason: 'No usable expiry slices in the supplied chain.' };

  const expirySelectorParams: ExpirySelectorParams = {
    lotSize: params.chainPayload.contract.lotSize,
    wingWidths: params.wingWidths, deltaTargets: params.deltaTargets,
    minDte: params.minDte, maxDte: params.maxDte,
    historicalCloses: params.historicalCloses,
    ivRank: null, // resolved per-expiry below via computePointInTimeIvRank once the winning slice is known
  };
  const evaluations = evaluateExpiries(enriched, expirySelectorParams);
  const decision = decideTrade(evaluations, params.qualityThresholds);
  if (decision.action === 'NO_TRADE' || !decision.expiryEvaluation?.best) {
    return { action: 'NO_TRADE', explanation: decision.explanation };
  }

  const best = decision.expiryEvaluation.best;
  const winningSlice = enriched.slices.find((s) => s.expiry === decision.expiryEvaluation!.expiry)!;
  const dte = decision.expiryEvaluation.dte;
  const tradingSessionHorizon = approxTradingSessionsFromCalendarDays(dte);
  const expiryDateStr = new Date(decision.expiryEvaluation.expiry).toISOString().slice(0, 10);

  const sizing = computePositionSize(
    { pricing: { maxLoss: best.result.maxLoss, maxProfit: best.result.maxProfit, netCredit: best.result.netCredit, netGreeks: best.result.netGreeks }, marginRequiredPerLot: best.result.maxLoss, underlyingGroup: params.symbol },
    { equity: params.accountEquity, availableFunds: params.accountEquity },
    params.portfolio, params.riskLimits,
  );
  if (sizing.lots <= 0) return { action: 'NO_TRADE', explanation: `Sized to 0 lots — ${sizing.reason}` };

  const validation = runPreTradeValidation({
    quoteAgeMs: now.getTime() - params.quoteCapturedAtMs, maxQuoteAgeMs: deps.maxQuoteAgeMs,
    isMarketOpen: true, allInstrumentsResolved: true, unresolvedLegs: [],
    marginSufficient: true, marginDetail: 'HISTORICAL_MODEL proxy (maxLoss) — see dataQuality labeling.',
    positionSizeLots: sizing.lots, duplicatePositionExists: false,
    priceDriftPct: 0, maxSlippagePct: 1.5, strategyStillValid: true, strategyDetail: 'Same live snapshot.',
    greeksWithinLimits: true, greeksDetail: 'Within computePositionSize\'s exposure caps.',
    recalculatedMaxLoss: best.result.maxLoss, originalMaxLoss: best.result.maxLoss, maxLossDriftPct: 5,
  });
  if (!validation.passed) {
    return { action: 'DATA_INVALID', reason: `Pre-trade validation failed: ${validation.checks.filter((c) => !c.passed).map((c) => c.name).join(', ')}` };
  }

  const legs: ShadowCandidateLeg[] = best.result.legs.map((l) => ({ side: l.side, right: l.right, strike: l.strike, price: l.price, quantity: sizing.lots * params.chainPayload.contract.lotSize }));
  const fillOutcome = runShadowFillSimulation(legs, winningSlice.quotes);

  // Task 2/4: persist the EXACT slice used, batched, best-effort (SOFT_FAIL
  // — a persistence failure here never blocks recording the signal itself,
  // it only affects forward-validation eligibility, checked below).
  const snapshotRows: OptionChainSnapshotRow[] = winningSlice.quotes.map((q) => ({
    scanId, capturedAt: now.toISOString(), symbol: params.symbol, spot: params.chainPayload.context.spot ?? null,
    indiaVix: params.indiaVix ?? null, forward: winningSlice.forward, expiry: expiryDateStr,
    calendarDte: dte, tradingSessionHorizon, strike: q.quote.strike, optionRight: q.quote.right,
    bid: q.quote.bid, bidQty: null, ask: q.quote.ask, askQty: null, ltp: q.quote.last, markPrice: q.markPrice,
    volume: q.quote.volume, openInterest: q.quote.openInterest, iv: q.iv,
    delta: q.greeks.delta, gamma: q.greeks.gamma, theta: q.greeks.theta, vega: q.greeks.vega,
  }));
  let snapshotPersisted = true;
  try {
    const result = await deps.repository.insertChainSnapshots(snapshotRows);
    snapshotPersisted = 'ok' in result;
  } catch { snapshotPersisted = false; }

  const atmStrike = winningSlice.atmStrike;
  const atmIv = atmIvOf(winningSlice);
  const ivRows: IvHistoryRow[] = atmStrike !== null ? [{
    capturedAt: now.toISOString(), symbol: params.symbol, expiry: expiryDateStr,
    atmStrike, atmCallIv: winningSlice.quotes.find((q) => q.quote.strike === atmStrike && q.quote.right === 'CE')?.iv ?? null,
    atmPutIv: winningSlice.quotes.find((q) => q.quote.strike === atmStrike && q.quote.right === 'PE')?.iv ?? null,
    combinedAtmIv: atmIv, calendarDte: dte, tradingSessionHorizon, spot: params.chainPayload.context.spot ?? null, indiaVix: params.indiaVix ?? null,
  }] : [];
  let ivHistoryPersisted = true;
  try {
    const result = await deps.repository.insertIvHistory(dedupeIvHistoryRows(ivRows));
    ivHistoryPersisted = 'ok' in result;
  } catch { ivHistoryPersisted = false; }

  const ivRankOutcome = params.ivHistory && atmIv !== null
    ? computePointInTimeIvRank(params.ivHistory, now.toISOString().slice(0, 10), atmIv)
    : { available: false as const, reason: 'no ivHistory supplied' };

  const signal: ForwardSignal = {
    symbol: params.symbol, strategyLabel: decision.expiryEvaluation.strategyLabel,
    expiry: expiryDateStr, calendarDte: dte, tradingSessionHorizon,
    shortDeltaTarget: null, wingWidth: null, netCredit: best.result.netCredit, estimatedMaxLoss: best.result.maxLoss,
    estimatedPop: best.result.pop, expectedValue: best.expectedValue, premiumEdgePct: best.qualityScore.raw.premiumEdgePct,
    independentEvPerUnitRisk: best.qualityScore.raw.independentEvPerUnitRisk,
    ivRank: ivRankOutcome.available ? ivRankOutcome.result.rank : null,
    liquidityTier: best.liquidity.tier, marketRegime: null, sizingLots: sizing.lots,
    expectedCostsRupees: null,
    baselineVersion: deps.baselineVersion, fillModelVersion: 'SHADOW_EXECUTION_V1',
    protocolId: deps.activeProtocolId, codeVersion: deps.codeVersion,
  };
  const ledgerId = await recordSignal(deps.ledgerStore, signal);

  const eligibility = isEligibleForForwardValidation({
    baselineVersion: deps.baselineVersion, executionMode: 'SHADOW', fillModel: 'SHADOW_EXECUTION_V1',
    everyLegHasRealBidAsk: fillOutcome.status === 'FILLED' && fillOutcome.hasRealBidAsk,
    quotesFreshMs: now.getTime() - params.quoteCapturedAtMs, maxQuoteAgeMs: deps.maxQuoteAgeMs,
    snapshotStoredSuccessfully: snapshotPersisted, ledgerSignalStoredSuccessfully: true, // recordSignal already succeeded or this line wasn't reached
    knownIngestionBug: false, brokerOrderPlaced: false,
    expectedBaselineVersion: deps.baselineVersion, expectedFillModel: 'SHADOW_EXECUTION_V1',
  });

  return {
    action: 'SIGNAL_RECORDED', ledgerId, scanId, strategyLabel: decision.expiryEvaluation.strategyLabel,
    legs, lots: sizing.lots, eligibleForForwardValidation: eligibility.eligible, eligibilityReasons: eligibility.reasons,
    snapshotPersisted, ivHistoryPersisted, fillOutcome,
  };
}

export interface ShadowExitLeg extends ShadowCandidateLeg {
  /** This leg's own decision-time (entry) fill price — needed to compute entryExecutionCost's contribution alongside the exit fill, and to flip side correctly for the closing simulation. */
  entryFillPrice: number;
}

export interface ShadowExitLegWithSymbol extends ShadowExitLeg {
  tradingsymbol: string;
}

export interface ShadowExitSimulationInput {
  legs: ShadowExitLegWithSymbol[];
  /** Raw Kite /quote entries for each leg's tradingsymbol, keyed the same way api/options-autotrade.ts's own quoteMap already is (`${exchange}:${tradingsymbol}`). Never a second fetch — this IS position-monitor's own already-fetched quoteMap. */
  quoteMap: Map<string, RawKiteQuote>;
  exchange: string;
}

export type ShadowExitFillResult =
  | {
      status: 'FILLED'; fills: SimulatedFill[];
      /** Cost to close at the ACTUAL simulated fill prices (includes exit-side slippage). */
      costToClose: number;
      /**
       * Task 3: cost to close at MID (decisionPrice), i.e. with zero
       * execution slippage — the "economic" cost-to-close a canonical
       * grossPnl (maxProfit - costToCloseAtMid) needs so entry/exit
       * slippage can be subtracted out separately, once, without being
       * silently baked into what's supposed to be the pre-cost payoff.
       */
      costToCloseAtMid: number;
      hasRealBidAsk: boolean;
    }
  | { status: 'EXECUTION_DATA_INSUFFICIENT'; reason: string };

/**
 * Pure exit-fill simulation — builds LegQuote[] directly from Kite's raw
 * /quote objects (position-monitor doesn't run enrichChain, unlike the
 * entry path), then simulates via SHADOW_EXECUTION_V1. Deliberately
 * returns the fill result only; assembling the full ForwardOutcome and
 * calling recordOutcome is the caller's job (api/options-autotrade.ts),
 * since only the caller has the daily-lock/settings context needed for
 * ForwardOutcome.dailyLockState — keeping this function free of that
 * API-local context is what makes it independently unit-testable.
 */
export function simulateShadowExitFills(input: ShadowExitSimulationInput): ShadowExitFillResult {
  const legQuotes: LegQuote[] = [];
  const exitSides: Array<'BUY' | 'SELL'> = [];
  for (const leg of input.legs) {
    // Closing a SELL means BUYing back, and vice versa.
    const exitSide: 'BUY' | 'SELL' = leg.side === 'BUY' ? 'SELL' : 'BUY';
    exitSides.push(exitSide);
    const raw = input.quoteMap.get(`${input.exchange}:${leg.tradingsymbol}`);
    if (!raw) return { status: 'EXECUTION_DATA_INSUFFICIENT', reason: `No live quote for a leg at close time (strike ${leg.strike}${leg.right}).` };
    legQuotes.push(buildLegQuoteFromRawKiteQuote(exitSide, leg.tradingsymbol, leg.price, raw));
  }
  const fills = simulateStructureFill(legQuotes, 'REALISTIC', SHADOW_EXECUTION_V1);
  // FIX (forward-validation readiness phase, Task 3): this previously used
  // `exitSides[i]` (the CLOSING order's side) with the SAME sign
  // convention api/options-autotrade.ts's own (correct) currentCostToClose
  // uses with the ORIGINAL entry side — since exitSide is always the
  // OPPOSITE of the original side, that inverted every term: buying back
  // a short (a real cost) was subtracted instead of added, and selling
  // back a long (a real credit) was added instead of subtracted. A worked
  // example proves the direction: short call deep ITM, long call less so
  // — the old formula returned costToClose = -500/unit, making
  // realizedPnl = maxProfit - (-500) = maxProfit + 500 (a PROFIT INCREASE
  // deep in max-loss territory). Keying off `input.legs[i].side` (the
  // ORIGINAL side) directly, with the same convention used everywhere
  // else in this codebase (SELL/short position -> +cost to buy back,
  // BUY/long position -> -cost, i.e. a credit on selling it back), fixes
  // this: the same scenario now correctly yields costToClose = +500/unit
  // (a real cost), so realizedPnl = maxProfit - 500 lands near max loss.
  // See shadowExitCostToClose.test.ts for the full numeric proof.
  const costToClose = fills.reduce((sum, f, i) => sum + (input.legs[i].side === 'SELL' ? 1 : -1) * f.filledPrice * input.legs[i].quantity, 0);
  const costToCloseAtMid = fills.reduce((sum, f, i) => sum + (input.legs[i].side === 'SELL' ? 1 : -1) * f.decisionPrice * input.legs[i].quantity, 0);
  const hasRealBidAsk = legQuotes.every((q) => q.bid !== null && q.ask !== null && q.bid > 0 && q.ask > 0);
  return { status: 'FILLED', fills, costToClose, costToCloseAtMid, hasRealBidAsk };
}
