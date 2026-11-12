/**
 * Independent risk engine. Every candidate order is approved or rejected
 * here, separately from signal and spread selection, and the decision is
 * recorded with every individual check.
 *
 * Daily loss: a trade is approved only if its worst-case loss still fits in
 * what remains of the daily loss budget. Once realized losses reach the
 * limit, no further entries are possible that day.
 */
import type { PulseConfig } from './config.ts';
import type { SpreadCandidate } from './spreads.ts';

export interface RiskState {
  nowMs: number;
  engineRunning: boolean;
  killSwitch: boolean;
  openPositions: number;
  tradesToday: number;
  /** Realized net P&L today (negative = loss). */
  realizedToday: number;
  /** Epoch ms of the last close, null if none today. */
  lastExitAt: number | null;
  marketOpen: boolean;
  feedHealthy: boolean;
}

export interface RiskCheck { key: string; label: string; pass: boolean; detail: string }

export interface RiskDecision {
  approved: boolean;
  checks: RiskCheck[];
  reason: string | null;
}

const inr = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`;

/** Checks that don't depend on a specific candidate (can block before selection). */
export function preTradeChecks(s: RiskState, c: PulseConfig): RiskCheck[] {
  const out: RiskCheck[] = [];
  const add = (key: string, label: string, pass: boolean, detail: string) => out.push({ key, label, pass, detail });
  add('PAPER_ONLY', 'Paper-only execution', c.paperOnly === true, c.paperOnly === true ? 'Paper broker — no exchange orders' : 'Refused — config is not paper-only');
  add('KILL_SWITCH', 'Kill switch released', !s.killSwitch, s.killSwitch ? 'Kill switch engaged' : 'released');
  add('ENGINE', 'Engine running', s.engineRunning, s.engineRunning ? 'running' : 'Engine stopped — new entries blocked');
  add('MARKET', 'Entry window open', s.marketOpen, s.marketOpen ? 'open' : 'Outside entry window (09:15–15:25 IST)');
  add('FEED', 'Market data healthy', s.feedHealthy, s.feedHealthy ? 'fresh' : 'Market data stale or disconnected');
  const posOk = s.openPositions < c.maxConcurrentPositions;
  add('POSITIONS', 'Concurrent positions', posOk, posOk ? `${s.openPositions} open / max ${c.maxConcurrentPositions}` : `Position already open (${s.openPositions}/${c.maxConcurrentPositions})`);
  const countOk = s.tradesToday < c.maxTradesPerDay;
  add('TRADE_COUNT', 'Daily trade limit', countOk, countOk ? `${s.tradesToday} / ${c.maxTradesPerDay} today` : `Daily trade limit reached (${s.tradesToday}/${c.maxTradesPerDay})`);
  const cooldownLeft = s.lastExitAt == null ? 0 : Math.max(0, c.cooldownSec * 1000 - (s.nowMs - s.lastExitAt));
  add('COOLDOWN', 'Cooldown complete', cooldownLeft === 0, cooldownLeft === 0 ? 'complete' : `Cooldown active — ${Math.ceil(cooldownLeft / 1000)}s left`);
  const lossUsed = Math.max(0, -s.realizedToday);
  const lossOk = lossUsed < c.maxDailyLoss;
  add('DAILY_LOSS', 'Daily loss limit', lossOk, lossOk ? `${inr(lossUsed)} of ${inr(c.maxDailyLoss)} used` : `Daily loss limit reached — ${inr(lossUsed)} of ${inr(c.maxDailyLoss)}`);
  return out;
}

export function approveCandidate(cand: SpreadCandidate, s: RiskState, c: PulseConfig): RiskDecision {
  const checks = preTradeChecks(s, c);
  const add = (key: string, label: string, pass: boolean, detail: string) => checks.push({ key, label, pass, detail });
  add('CANDIDATE', 'Spread passes liquidity & pricing', cand.eligible, cand.eligible ? 'all checks pass' : cand.rejectReason ?? 'not eligible');
  if (cand.maxLoss != null) {
    add('MAX_LOSS', 'Max loss per trade', cand.maxLoss <= c.maxLossPerTrade, `${inr(cand.maxLoss)} (incl. ${inr(cand.roundTripCost ?? 0)} costs) vs ${inr(c.maxLossPerTrade)}`);
    const remaining = c.maxDailyLoss - Math.max(0, -s.realizedToday);
    add('DAILY_BUDGET', 'Fits remaining daily loss budget', cand.maxLoss <= remaining, `${inr(cand.maxLoss)} vs ${inr(Math.max(0, remaining))} remaining`);
  }
  if (cand.estMargin != null) {
    add('MARGIN', 'Margin allocation (estimate)', cand.estMargin <= c.maxMarginAllocation, `${inr(cand.estMargin)} est. vs ${inr(c.maxMarginAllocation)} — paper estimate, not broker-confirmed`);
  }
  const failed = checks.find((k) => !k.pass);
  const preKeys = new Set(['PAPER_ONLY', 'KILL_SWITCH', 'ENGINE', 'MARKET', 'FEED', 'POSITIONS', 'TRADE_COUNT', 'COOLDOWN', 'DAILY_LOSS']);
  const reason = !failed ? null : preKeys.has(failed.key) ? failed.detail : `${failed.label}: ${failed.detail}`;
  return { approved: !failed, checks, reason };
}

/**
 * Pick the first candidate the risk engine approves. When liquid spreads exist
 * but none fits the risk budget, the reason is the spec's exact message.
 */
export function selectApproved(cands: SpreadCandidate[], s: RiskState, c: PulseConfig): { chosen: SpreadCandidate | null; decision: RiskDecision | null; reason: string | null; evaluated: number } {
  const eligible = cands.filter((x) => x.eligible);
  if (!eligible.length) {
    const first = cands[0];
    const reason = !first ? 'Option spread unavailable' : /depth|spread|two_sided|bid & ask/i.test(first.rejectReason ?? '') ? `Insufficient bid/ask liquidity — ${first.rejectReason}` : (first.rejectReason ?? 'Option spread unavailable');
    return { chosen: null, decision: null, reason, evaluated: cands.length };
  }
  let firstDecision: RiskDecision | null = null;
  for (const cand of eligible) {
    const d = approveCandidate(cand, s, c);
    firstDecision ??= d;
    if (d.approved) return { chosen: cand, decision: d, reason: null, evaluated: cands.length };
  }
  const riskOnly = firstDecision!.checks.filter((k) => !k.pass).every((k) => k.key === 'MAX_LOSS' || k.key === 'DAILY_BUDGET' || k.key === 'MARGIN');
  return { chosen: null, decision: firstDecision, reason: riskOnly ? 'NO ELIGIBLE SPREAD WITHIN RISK LIMIT' : `Risk limit exceeded — ${firstDecision!.reason}`, evaluated: cands.length };
}
