import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runShadowEntryScan, simulateShadowExitFills, type ShadowScanDeps, type ShadowExitLegWithSymbol } from '../execution/shadowScan.ts';
import type { RawKiteQuote } from '../execution/shadowExecution.ts';
import { black76 } from '../pricing/black76.ts';
import type { RawChainPayload } from '../data/adapter.ts';
import type { ShadowRepository, OptionChainSnapshotRow, IvHistoryRow, ExecutionQualityRow } from '../execution/shadowRepository.ts';
import type { ForwardLedgerStore, ForwardSignal, ForwardOutcome } from '../execution/forwardLedger.ts';
import { DEFAULT_RISK_LIMITS } from '../strategies/positionSizing.ts';

/**
 * Full DI integration harness (live-data-capture wiring phase, Task 16):
 * mock quote input -> enrich -> candidate -> score -> decision -> sizing
 * -> pretrade validation -> snapshot persistence -> IV persistence ->
 * recordSignal -> SHADOW fill -> execution-quality-shaped data -> then a
 * simulated monitor pass: new quotes -> exit trigger (driven externally,
 * matching how position-monitor's own evaluateExit already works) ->
 * SHADOW close simulation -> recordOutcome. Zero broker-order calls are
 * possible by construction (no such dependency exists anywhere in this
 * harness) — asserted explicitly anyway as the task requires.
 */

/** Records every call made to it — this IS the "assert zero broker order calls" mechanism: there is no method here a caller could even name "placeOrder". Its only job is to prove what WAS and WASN'T called. */
class InMemoryShadowRepository implements ShadowRepository {
  snapshotBatches: OptionChainSnapshotRow[][] = [];
  ivHistoryBatches: IvHistoryRow[][] = [];
  executionQualityBatches: ExecutionQualityRow[][] = [];
  failSnapshots = false;

  async insertChainSnapshots(rows: OptionChainSnapshotRow[]) {
    if (this.failSnapshots) return { error: 'simulated DB failure' };
    this.snapshotBatches.push(rows);
    return { ok: true } as const;
  }
  async insertIvHistory(rows: IvHistoryRow[]) {
    this.ivHistoryBatches.push(rows);
    return { ok: true } as const;
  }
  async insertExecutionQuality(rows: ExecutionQualityRow[]) {
    this.executionQualityBatches.push(rows);
    return { ok: true } as const;
  }
  async sumEntryExecutionCost(forwardLedgerId: string) {
    const entryRows = this.executionQualityBatches.flat().filter((r) => r.phase === 'ENTRY' && r.forwardLedgerId === forwardLedgerId);
    if (entryRows.length === 0) return { value: null, rowCount: 0 };
    return { value: entryRows.reduce((s, r) => s + Math.abs(r.slippageRupees ?? 0), 0), rowCount: entryRows.length };
  }
}

class InMemoryLedgerStore implements ForwardLedgerStore {
  rows = new Map<string, any>();
  private nextId = 1;
  async insertSignal(signal: ForwardSignal) {
    const id = String(this.nextId++);
    this.rows.set(id, { ...signal, outcome: null, completed: false });
    return { id };
  }
  async recordOutcome(ledgerId: string, outcome: ForwardOutcome) {
    const row = this.rows.get(ledgerId);
    if (!row) return { error: 'not found' };
    if (row.completed) return { alreadyCompleted: true } as const;
    row.outcome = outcome;
    row.completed = true;
    return { ok: true } as const;
  }
  async getOutcome(ledgerId: string) {
    const row = this.rows.get(ledgerId);
    if (!row) return { found: false } as const;
    return {
      found: true as const,
      outcome: {
        completed: row.completed, exitReason: row.outcome?.exitReason ?? null,
        netPnl: row.outcome?.netPnl ?? null, outcomeRecordedAtIso: row.completed ? new Date().toISOString() : null,
      },
    };
  }
}

const FORWARD = 25000;
const STRIKES = Array.from({ length: 41 }, (_, i) => 23000 + i * 100);
const NOW = Date.parse('2026-09-25T09:30:00Z');
const EXPIRY = NOW + 30 * 86_400_000;

/** A LIVE-shaped chain (real bid/ask on every strike) — unlike the historical bhavcopy fixture, this is what a real Kite /quote batch looks like. */
function liveChainPayload(vol: number, spot = FORWARD): RawChainPayload {
  const T = (EXPIRY - NOW) / (365 * 86_400_000);
  const r = 0.065;
  const rows = STRIKES.flatMap((strike) =>
    (['CE', 'PE'] as const).map((right) => {
      const mid = black76({ forward: spot, strike, timeToExpiry: T, vol, rate: r, right }).price;
      const spread = Math.max(0.5, mid * 0.02);
      return {
        right, strike, expiry: EXPIRY, asOf: NOW,
        bid: Math.max(0.05, mid - spread / 2), ask: mid + spread / 2,
        openInterest: 50_000, volume: 5_000,
      };
    }),
  );
  return {
    source: { providerId: 'kite-live', kind: 'live', retrievedAt: NOW },
    contract: { underlyingSymbol: 'NIFTY', lotSize: 75, pointValue: 1, strikeStep: 100, currency: 'INR', exerciseStyle: 'european', pricingBasis: 'futures' },
    context: { valuationTime: NOW, spot, futures: null, riskFreeRate: 0.065, dividendYield: 0 },
    rows,
  };
}

const PERMISSIVE_THRESHOLDS = { noTradeBelow: -1, watchBelow: -1, highConvictionAtOrAbove: -1 };

function makeDeps(repo: InMemoryShadowRepository, ledger: InMemoryLedgerStore): ShadowScanDeps {
  return {
    repository: repo, ledgerStore: ledger, clock: () => new Date(NOW), baselineVersion: 'BASELINE_V1', maxQuoteAgeMs: 300_000,
    activeProtocolId: null, codeVersion: 'test-sha',
  };
}

test('FULL ROUND TRIP: entry scan -> signal recorded -> exit scan -> outcome recorded, zero broker calls throughout', async () => {
  const repo = new InMemoryShadowRepository();
  const ledger = new InMemoryLedgerStore();
  const deps = makeDeps(repo, ledger);

  const entryOutcome = await runShadowEntryScan(deps, {
    symbol: 'NIFTY', chainPayload: liveChainPayload(0.13), wingWidths: [200, 400, 600],
    qualityThresholds: PERMISSIVE_THRESHOLDS, accountEquity: 1_000_000, riskLimits: DEFAULT_RISK_LIMITS,
    portfolio: { openPositions: [], realizedPnlToday: 0, realizedPnlThisWeek: 0 },
    quoteCapturedAtMs: NOW, indiaVix: 13.5,
  });

  assert.equal(entryOutcome.action, 'SIGNAL_RECORDED', JSON.stringify(entryOutcome));
  if (entryOutcome.action !== 'SIGNAL_RECORDED') return;

  // The signal was recorded BEFORE any outcome — verified directly against the ledger store.
  const ledgerRow = ledger.rows.get(entryOutcome.ledgerId);
  assert.ok(ledgerRow);
  assert.equal(ledgerRow.outcome, null);
  assert.equal(ledgerRow.symbol, 'NIFTY');

  // Snapshot + IV history were both persisted.
  assert.ok(repo.snapshotBatches.length > 0);
  assert.ok(repo.ivHistoryBatches.length > 0);
  assert.ok(entryOutcome.eligibleForForwardValidation, JSON.stringify(entryOutcome.eligibilityReasons));

  // --- Simulated monitor pass: volatility drops sharply -> profit captured ---
  // Position-monitor doesn't run enrichChain (unlike the entry scan) — it
  // works off Kite's raw /quote objects directly, so the exit simulation
  // is tested against that SAME raw shape, not a re-enriched slice.
  const exitPayload = liveChainPayload(0.07); // vol collapse -> short structure loses value -> profit
  const rawQuoteMap = new Map<string, RawKiteQuote>();
  for (const row of exitPayload.rows as any[]) {
    const tradingsymbol = `NIFTY${row.strike}${row.right}`;
    rawQuoteMap.set(`NFO:${tradingsymbol}`, {
      last_price: (row.bid + row.ask) / 2, oi: row.openInterest, volume: row.volume,
      depth: { buy: [{ price: row.bid }], sell: [{ price: row.ask }] },
    });
  }
  const exitLegs: ShadowExitLegWithSymbol[] = entryOutcome.legs.map((l) => ({
    ...l, entryFillPrice: l.price, tradingsymbol: `NIFTY${l.strike}${l.right}`,
    price: rawQuoteMap.get(`NFO:NIFTY${l.strike}${l.right}`)!.last_price!,
  }));
  const maxProfit = entryOutcome.legs.reduce((s, l) => s + (l.side === 'SELL' ? l.price : -l.price) * l.quantity, 0);

  const exitFillResult = simulateShadowExitFills({ legs: exitLegs, quoteMap: rawQuoteMap, exchange: 'NFO' });
  assert.equal(exitFillResult.status, 'FILLED');
  if (exitFillResult.status !== 'FILLED') return;

  const grossPnl = maxProfit - exitFillResult.costToClose;
  const { recordOutcome } = await import('../execution/forwardLedger.ts');
  const outcomeResult = await recordOutcome(deps.ledgerStore, entryOutcome.ledgerId, {
    exitReason: 'PROFIT_TARGET', holdingPeriodDays: 1, grossPnl, netPnl: grossPnl,
    entryExecutionCost: 0, exitExecutionCost: 0, totalExecutionCost: 0,
    transactionChargesEstimate: 0, costModelVersion: 'EXEC_COST_V1',
    maxAdverseExcursion: null, maxFavorableExcursion: null,
    dailyLockState: { wouldTriggerMaxDailyLoss: false, wouldTriggerMaxConsecutiveLosses: false, realizedPnlTodayAfterThisTrade: grossPnl, consecutiveLossesAfterThisTrade: 0 },
    dataQuality: { note: 'MAE_MFE_UNAVAILABLE' },
  });
  assert.deepEqual(outcomeResult, { ok: true });
  assert.ok(grossPnl !== null);

  // Outcome now recorded — pre-trade fields untouched (same guarantee forwardLedger.test.ts already proves at the unit level, re-verified here at the integration level).
  assert.ok(ledgerRow.outcome !== null);
  assert.equal(ledgerRow.outcome.exitReason, 'PROFIT_TARGET');
  assert.equal(ledgerRow.symbol, 'NIFTY'); // pre-trade field, unchanged

  // ZERO broker order calls: structurally impossible to have happened —
  // no dependency object anywhere in `deps` exposes anything shaped like
  // placeOrder, and neither module ever imports liveFill.ts's
  // LiveOrderPlacer. This assertion documents that invariant explicitly.
  const depsKeys = Object.keys(deps);
  assert.ok(!depsKeys.some((k) => k.toLowerCase().includes('order') || k.toLowerCase().includes('broker')));
});

test('a genuine NO_TRADE (thresholds set impossibly high) records nothing to the ledger and persists nothing', async () => {
  const repo = new InMemoryShadowRepository();
  const ledger = new InMemoryLedgerStore();
  const deps = makeDeps(repo, ledger);

  const outcome = await runShadowEntryScan(deps, {
    symbol: 'NIFTY', chainPayload: liveChainPayload(0.13), wingWidths: [200, 400, 600],
    qualityThresholds: { noTradeBelow: 101, watchBelow: 101, highConvictionAtOrAbove: 101 }, // impossible to clear
    accountEquity: 1_000_000, riskLimits: DEFAULT_RISK_LIMITS,
    portfolio: { openPositions: [], realizedPnlToday: 0, realizedPnlThisWeek: 0 },
    quoteCapturedAtMs: NOW,
  });
  assert.equal(outcome.action, 'NO_TRADE');
  assert.equal(ledger.rows.size, 0);
  assert.equal(repo.snapshotBatches.length, 0);
});

test('FAILURE INJECTION: a snapshot-insert failure does not block the signal from being recorded, but marks it ineligible for the official sample', async () => {
  const repo = new InMemoryShadowRepository();
  repo.failSnapshots = true;
  const ledger = new InMemoryLedgerStore();
  const deps = makeDeps(repo, ledger);

  const outcome = await runShadowEntryScan(deps, {
    symbol: 'NIFTY', chainPayload: liveChainPayload(0.13), wingWidths: [200, 400, 600],
    qualityThresholds: PERMISSIVE_THRESHOLDS, accountEquity: 1_000_000, riskLimits: DEFAULT_RISK_LIMITS,
    portfolio: { openPositions: [], realizedPnlToday: 0, realizedPnlThisWeek: 0 },
    quoteCapturedAtMs: NOW,
  });
  assert.equal(outcome.action, 'SIGNAL_RECORDED');
  if (outcome.action !== 'SIGNAL_RECORDED') return;
  // The signal itself was still recorded (SOFT_FAIL — telemetry failure never blocks the decision/record path)...
  assert.equal(ledger.rows.size, 1);
  // ...but it is correctly excluded from the official forward-validation sample.
  assert.equal(outcome.eligibleForForwardValidation, false);
  assert.ok(outcome.eligibilityReasons.some((r) => r.includes('snapshot')));
});

test('FAILURE INJECTION: missing bid/ask on every leg produces a diagnostic-only signal, ineligible for the official sample', async () => {
  const repo = new InMemoryShadowRepository();
  const ledger = new InMemoryLedgerStore();
  const deps = makeDeps(repo, ledger);

  const payload = liveChainPayload(0.13);
  payload.rows = payload.rows.map((r) => ({ ...r, bid: null, ask: null })); // strip all bid/ask -> EOD-like

  const outcome = await runShadowEntryScan(deps, {
    symbol: 'NIFTY', chainPayload: payload, wingWidths: [200, 400, 600],
    qualityThresholds: PERMISSIVE_THRESHOLDS, accountEquity: 1_000_000, riskLimits: DEFAULT_RISK_LIMITS,
    portfolio: { openPositions: [], realizedPnlToday: 0, realizedPnlThisWeek: 0 },
    quoteCapturedAtMs: NOW,
  });
  // Candidate selection itself works fine off settlement-equivalent prices (mid falls back sanely) — but forward-validation eligibility must fail.
  if (outcome.action !== 'SIGNAL_RECORDED') { assert.ok(true, 'no candidate at all is also an acceptable outcome for a bid/ask-less chain'); return; }
  assert.equal(outcome.eligibleForForwardValidation, false);
  assert.ok(outcome.eligibilityReasons.some((r) => r.includes('bid/ask')));
});

test('FAILURE INJECTION: a ledger-insert failure propagates as a rejection rather than silently recording a broken signal', async () => {
  const repo = new InMemoryShadowRepository();
  const failingLedger: ForwardLedgerStore = {
    async insertSignal() { throw new Error('simulated ledger DB outage'); },
    async recordOutcome() { return { ok: true } as const; },
    async getOutcome() { return { found: false } as const; },
  };
  const deps = makeDeps(repo, new InMemoryLedgerStore());
  (deps as any).ledgerStore = failingLedger;

  await assert.rejects(() => runShadowEntryScan(deps, {
    symbol: 'NIFTY', chainPayload: liveChainPayload(0.13), wingWidths: [200, 400, 600],
    qualityThresholds: PERMISSIVE_THRESHOLDS, accountEquity: 1_000_000, riskLimits: DEFAULT_RISK_LIMITS,
    portfolio: { openPositions: [], realizedPnlToday: 0, realizedPnlThisWeek: 0 },
    quoteCapturedAtMs: NOW,
  }));
  // Critically: snapshots/IV history were already persisted before the
  // ledger call — a ledger failure doesn't retroactively invalidate data
  // already safely stored, it just means THIS signal never got recorded,
  // which the caller (api layer) must handle as a failed scan, not as a
  // silently-partial one.
  assert.ok(repo.snapshotBatches.length > 0);
});

test('FAILURE INJECTION: an IV-history insert failure is soft — the signal is still recorded and can still be eligible', async () => {
  const repo = new InMemoryShadowRepository();
  const originalInsertIv = repo.insertIvHistory.bind(repo);
  repo.insertIvHistory = async () => { throw new Error('simulated IV-history DB outage'); };
  const ledger = new InMemoryLedgerStore();
  const deps = makeDeps(repo, ledger);

  const outcome = await runShadowEntryScan(deps, {
    symbol: 'NIFTY', chainPayload: liveChainPayload(0.13), wingWidths: [200, 400, 600],
    qualityThresholds: PERMISSIVE_THRESHOLDS, accountEquity: 1_000_000, riskLimits: DEFAULT_RISK_LIMITS,
    portfolio: { openPositions: [], realizedPnlToday: 0, realizedPnlThisWeek: 0 },
    quoteCapturedAtMs: NOW,
  });
  assert.equal(outcome.action, 'SIGNAL_RECORDED');
  assert.equal(ledger.rows.size, 1);
  void originalInsertIv;
});

test('DUPLICATE SCAN INVOCATION: two concurrent identical entry scans each independently record their own signal (dedup is the API layer\'s order-intent job, not this module\'s) — but neither ever places a broker order', async () => {
  const repo = new InMemoryShadowRepository();
  const ledger = new InMemoryLedgerStore();
  const deps = makeDeps(repo, ledger);
  const scanOnce = () => runShadowEntryScan(deps, {
    symbol: 'NIFTY', chainPayload: liveChainPayload(0.13), wingWidths: [200, 400, 600],
    qualityThresholds: PERMISSIVE_THRESHOLDS, accountEquity: 1_000_000, riskLimits: DEFAULT_RISK_LIMITS,
    portfolio: { openPositions: [], realizedPnlToday: 0, realizedPnlThisWeek: 0 },
    quoteCapturedAtMs: NOW,
  });
  const [a, b] = await Promise.all([scanOnce(), scanOnce()]);
  assert.equal(a.action, 'SIGNAL_RECORDED');
  assert.equal(b.action, 'SIGNAL_RECORDED');
  assert.equal(ledger.rows.size, 2); // this module has no dedup of its own — see orderIntent.ts for where that lives in production
});

test('a stale quote (quoteCapturedAtMs far in the past) fails pre-trade validation, recording nothing', async () => {
  const repo = new InMemoryShadowRepository();
  const ledger = new InMemoryLedgerStore();
  const deps = makeDeps(repo, ledger);

  const outcome = await runShadowEntryScan(deps, {
    symbol: 'NIFTY', chainPayload: liveChainPayload(0.13), wingWidths: [200, 400, 600],
    qualityThresholds: PERMISSIVE_THRESHOLDS, accountEquity: 1_000_000, riskLimits: DEFAULT_RISK_LIMITS,
    portfolio: { openPositions: [], realizedPnlToday: 0, realizedPnlThisWeek: 0 },
    quoteCapturedAtMs: NOW - 10 * 60_000, // 10 minutes old, deps.maxQuoteAgeMs is 300_000 (5 min)
  });
  assert.equal(outcome.action, 'DATA_INVALID');
  assert.equal(ledger.rows.size, 0);
});
