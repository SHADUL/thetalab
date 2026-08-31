/**
 * The session's ATM IV: average of call and put IV at the strike nearest
 * the forward, falling back to whichever side actually solved if only one
 * did. Shared by anything that needs a single "where is IV right now" read
 * — the strategy engine's POP calc, the Market Regime display, IV rank.
 */
import { isUsable } from '../types.ts';
import type { EnrichedSlice } from '../types.ts';

export function atmIvOf(slice: EnrichedSlice): number | null {
  if (slice.atmStrike === null) return null;
  const usable = slice.quotes.filter(isUsable);
  const call = usable.find((q) => q.quote.strike === slice.atmStrike && q.quote.right === 'CE');
  const put = usable.find((q) => q.quote.strike === slice.atmStrike && q.quote.right === 'PE');
  if (call?.iv != null && put?.iv != null) return (call.iv + put.iv) / 2;
  return call?.iv ?? put?.iv ?? null;
}
