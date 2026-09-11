/**
 * Swing Scanner — indicator engine.
 *
 * Pure functions over plain OHLCV arrays, no fetching, no storage, no
 * knowledge of Kite or Supabase — those live in separate layers (data /
 * ranking) so this module stays testable and swappable on its own, the same
 * separation src/quant/data/adapter.ts already established for the options
 * side.
 *
 * Every function returns one value per input bar (`null` wherever the
 * lookback isn't satisfied yet) rather than trimming the array, so a caller
 * can always index an indicator series by the same position as the bars it
 * came from.
 */

/** One OHLCV session — matches the `{t,o,h,l,c,v}` shape already used by
 *  CandleChart / kiteClient elsewhere in this app. `t` is a date string
 *  ("YYYY-MM-DD") for daily/weekly bars, or an ISO datetime for intraday. */
export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
