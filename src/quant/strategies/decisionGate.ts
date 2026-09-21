/**
 * Turns a trade quality score into an actionable classification
 * (NO_TRADE / WATCH / TRADE_CANDIDATE / HIGH_CONVICTION) and a
 * human-readable explanation citing the actual numbers behind the
 * decision — never a canned string. This is Phase 8 (threshold
 * classification) combined with the "explainability" requirement (every
 * automated trade, or non-trade, must have a stated reason), scoped
 * strictly to those two things: it does NOT implement position sizing,
 * risk-limit checks, or execution-quality checks (Phase 13's other
 * independent conditions) — those are separate, not-yet-built layers.
 *
 * Thresholds default to the spec's own example bands (70/80/90) but are
 * NOT validated — "these thresholds must be configurable and validated
 * through backtesting" is the spec's own instruction, and no backtest
 * engine exists for this module yet. Treat the defaults as a starting
 * point to argue with, the same posture regimeSelect.ts's skew threshold
 * and tradeQualityScore.ts's weights already take.
 */
import { selectBestExpiry, type ExpiryEvaluation } from './expirySelector.ts';

export type TradeAction = 'NO_TRADE' | 'WATCH' | 'TRADE_CANDIDATE' | 'HIGH_CONVICTION';

export interface DecisionThresholds {
  /** Score below this -> NO_TRADE. */
  noTradeBelow: number;
  /** Score below this (and >= noTradeBelow) -> WATCH. */
  watchBelow: number;
  /** Score at or above this -> HIGH_CONVICTION. Between watchBelow and this -> TRADE_CANDIDATE. */
  highConvictionAtOrAbove: number;
}

/** Provisional — see this file's header. */
export const DEFAULT_DECISION_THRESHOLDS: DecisionThresholds = {
  noTradeBelow: 70,
  watchBelow: 80,
  highConvictionAtOrAbove: 90,
};

export function classifyTradeQuality(score: number, thresholds: DecisionThresholds = DEFAULT_DECISION_THRESHOLDS): TradeAction {
  if (score < thresholds.noTradeBelow) return 'NO_TRADE';
  if (score < thresholds.watchBelow) return 'WATCH';
  if (score < thresholds.highConvictionAtOrAbove) return 'TRADE_CANDIDATE';
  return 'HIGH_CONVICTION';
}

export interface TradeDecision {
  action: TradeAction;
  /** Null only when nothing was eligible at all (every expiry skipped or unpriceable) — a genuine "nothing to evaluate", not an error. */
  expiryEvaluation: ExpiryEvaluation | null;
  /** Multi-line, human-readable. Always cites real numbers when the data exists, and says so plainly when it doesn't. */
  explanation: string;
}

function fmtPct(x: number | null, digits = 0): string {
  return x === null ? 'n/a' : `${(x * 100).toFixed(digits)}%`;
}

function fmtNum(x: number | null, digits = 2): string {
  return x === null ? 'n/a' : x.toFixed(digits);
}

function liquidityLabel(score: number | null): string {
  if (score === null) return 'n/a';
  if (score >= 80) return 'High';
  if (score >= 50) return 'Moderate';
  return 'Low';
}

function describeCandidate(evaluation: ExpiryEvaluation): string {
  const best = evaluation.best!;
  const { raw, score } = best.qualityScore;
  const legs = best.result.legs.map((l) => `${l.side} ${l.strike}${l.right}`).join(' / ');

  const lines = [
    `${evaluation.strategyLabel.toUpperCase()} — expiry in ${evaluation.dte}d`,
    `Legs: ${legs}`,
    `Bias: ${evaluation.bias} — ${evaluation.biasReason}`,
    `Premium Edge (IV vs realized vol): ${raw.premiumEdgePct === null ? 'n/a — no historical closes supplied' : `${raw.premiumEdgePct >= 0 ? '+' : ''}${raw.premiumEdgePct.toFixed(1)}% ${raw.premiumEdgePct >= 0 ? '(implied move richer than history)' : '(implied move below what typically realizes — weak setup)'}`}`,
    `IV Rank: ${raw.ivRank === null ? 'n/a — no history supplied' : raw.ivRank.toFixed(0)}`,
    `Probability of profit (model-implied): ${fmtPct(raw.pop)}`,
    `Strike safety: ${raw.strikeSafetySigma === null ? 'n/a' : `${raw.strikeSafetySigma.toFixed(2)}σ from forward`}`,
    `Risk/Reward: ${fmtNum(raw.riskReward)} (max profit ₹${best.result.maxProfit.toFixed(0)} / max loss ₹${best.result.maxLoss.toFixed(0)})`,
    `Expected value per unit of risk: ${best.evPerUnitRisk === null ? 'n/a' : best.evPerUnitRisk.toFixed(2)}` +
      (best.expectedValue !== null ? ` (EV ₹${best.expectedValue.toFixed(0)})` : ''),
    `Liquidity: ${liquidityLabel(best.qualityScore.components.liquidity)}` +
      (raw.avgSpreadPct !== null ? ` (avg spread ${fmtPct(raw.avgSpreadPct, 1)}` : ' (spread n/a — settlement-only data')  +
      `, min OI ${raw.minOpenInterest ?? 'n/a'})`,
    `Margin efficiency: ${raw.marginEfficiency === null ? 'not evaluated — no live margin figure supplied' : fmtPct(raw.marginEfficiency)}`,
    `Trade Quality Score: ${score.toFixed(0)}/100` +
      (best.qualityScore.missingComponents.length
        ? ` (excluded, not penalized: ${best.qualityScore.missingComponents.join(', ')})`
        : ''),
  ];
  return lines.join('\n');
}

/**
 * Picks the best-ranked expiry (via expirySelector.ts's own EV-per-risk
 * ranking), classifies its trade quality score against the given
 * thresholds, and builds the explanation. Genuinely returns NO_TRADE, with
 * the real skip reasons cited, when nothing was eligible — never forces a
 * pick because a threshold happened to be crossed by something thin.
 */
export function decideTrade(
  evaluations: ExpiryEvaluation[],
  thresholds: DecisionThresholds = DEFAULT_DECISION_THRESHOLDS,
): TradeDecision {
  const best = selectBestExpiry(evaluations);
  if (!best) {
    const reasons = evaluations
      .map((e) => `${e.dte}d: ${e.skipReason ?? 'no eligible candidate'}`)
      .join('\n  ');
    return {
      action: 'NO_TRADE',
      expiryEvaluation: null,
      explanation: `NO TRADE\nReason: no eligible expiry today.\n  ${reasons || '(no expiries were evaluated)'}`,
    };
  }

  const action = classifyTradeQuality(best.best!.qualityScore.score, thresholds);
  const header = action === 'NO_TRADE'
    ? `NO TRADE\nReason: trade quality score ${best.best!.qualityScore.score.toFixed(0)} is below the configured threshold (${thresholds.noTradeBelow}).`
    : `${action.replace('_', ' ')}`;

  return {
    action,
    expiryEvaluation: best,
    explanation: `${header}\n\n${describeCandidate(best)}`,
  };
}
