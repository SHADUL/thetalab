/**
 * Strategy A momentum signal — the four market rules only. Entry gating
 * (position, cooldown, limits, freshness, spread, risk) is applied by the
 * engine pipeline afterwards, so each rejection carries its own reason.
 *
 * "Rule agreement" is the count of the four momentum rules satisfied for a
 * direction. It is NOT a probability and the UI must never present it as one.
 */
import type { Indicators } from './indicators.ts';
import type { PulseConfig } from './config.ts';

export type Direction = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface RuleResult {
  key: 'R5' | 'R15' | 'MA' | 'CONFIRM';
  label: string;
  value: string;
  bull: boolean;
  bear: boolean;
  bullTarget: string;
  bearTarget: string;
}

export interface SignalResult {
  direction: Direction;
  rules: RuleResult[];
  bullAgree: number;
  bearAgree: number;
  /** Rules in the leading direction / total rules. */
  agreement: { count: number; of: number; side: 'BULLISH' | 'BEARISH' | null };
  reason: string;
}

const fmtPct = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(4)}%`;

export function evaluateSignal(ind: Indicators, c: PulseConfig): SignalResult {
  if (!ind.ready) {
    return { direction: 'NEUTRAL', rules: [], bullAgree: 0, bearAgree: 0, agreement: { count: 0, of: 4, side: null }, reason: ind.reason };
  }
  const rules: RuleResult[] = [
    {
      key: 'R5', label: `${c.shortReturnWindowSec}s return`, value: fmtPct(ind.r5),
      bull: ind.r5 > c.shortReturnThresholdPct, bear: ind.r5 < -c.shortReturnThresholdPct,
      bullTarget: `> +${c.shortReturnThresholdPct}%`, bearTarget: `< −${c.shortReturnThresholdPct}%`,
    },
    {
      key: 'R15', label: `${c.longReturnWindowSec}s return`, value: fmtPct(ind.r15),
      bull: ind.r15 > c.longReturnThresholdPct, bear: ind.r15 < -c.longReturnThresholdPct,
      bullTarget: `> +${c.longReturnThresholdPct}%`, bearTarget: `< −${c.longReturnThresholdPct}%`,
    },
    {
      key: 'MA', label: `Price vs MA${c.maWindowSec}`, value: `${ind.maDistance >= 0 ? '+' : ''}${ind.maDistance.toFixed(2)} pts`,
      bull: ind.price > ind.ma60, bear: ind.price < ind.ma60,
      bullTarget: 'above MA', bearTarget: 'below MA',
    },
    {
      key: 'CONFIRM', label: `${c.confirmMin}-of-${c.confirmLookback} confirmation`, value: `${ind.ups}↑ ${ind.downs}↓ ${ind.flats}→`,
      bull: ind.ups >= c.confirmMin, bear: ind.downs >= c.confirmMin,
      bullTarget: `≥ ${c.confirmMin} up`, bearTarget: `≥ ${c.confirmMin} down`,
    },
  ];
  const bullAgree = rules.filter((r) => r.bull).length;
  const bearAgree = rules.filter((r) => r.bear).length;
  const direction: Direction = bullAgree === 4 ? 'BULLISH' : bearAgree === 4 ? 'BEARISH' : 'NEUTRAL';
  const side = bullAgree === 0 && bearAgree === 0 ? null : bullAgree >= bearAgree ? 'BULLISH' : 'BEARISH';
  const count = side === 'BULLISH' ? bullAgree : side === 'BEARISH' ? bearAgree : 0;
  let reason: string;
  if (direction === 'BULLISH') reason = 'Bullish momentum: all four rules agree';
  else if (direction === 'BEARISH') reason = 'Bearish momentum: all four rules agree';
  else if (side) {
    const missing = rules.filter((r) => !(side === 'BULLISH' ? r.bull : r.bear)).map((r) => r.label);
    reason = `Momentum conditions not aligned — ${side.toLowerCase()} ${count}/4, missing: ${missing.join(', ')}`;
  } else reason = 'Momentum conditions not aligned — no rule active';
  return { direction, rules, bullAgree, bearAgree, agreement: { count, of: 4, side }, reason };
}
