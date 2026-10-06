/**
 * Prospective report for the order-flow OBSERVE experiment. Run:
 *   node --experimental-strip-types src/quant/scripts/orderFlowReport.mts
 * (needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment).
 * Reports actual realized P&L of CLOSED trades by MATCH / CONFLICT group for
 * both variants. No counterfactual P&L is computed.
 */
import { createClient } from '@supabase/supabase-js';
import { summarizeOrderFlow, type ObservedTrade } from '../analytics/orderFlowReport.ts';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const { data: links } = await supabase.from('options_order_flow_position_link').select('*');
const trades: ObservedTrade[] = [];
let open = 0, noObservation = 0;
for (const l of links ?? []) {
  const { data: pos } = await supabase.from('options_autotrade_positions').select('status,realized_pnl,updated_at').eq('id', l.position_id).maybeSingle();
  if (!pos) continue;
  if (pos.status !== 'CLOSED') { open++; continue; }
  const { data: obs } = await supabase.from('options_order_flow_confirmation_log').select('rr_direction,match_raw,match_alpha_d')
    .eq('scan_id', l.scan_id).eq('symbol', l.symbol).eq('expiry', l.expiry).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!obs) { noObservation++; continue; }
  trades.push({ rrDirection: obs.rr_direction, matchA: obs.match_raw, matchB: obs.match_alpha_d, pnl: Number(pos.realized_pnl) || 0, closedAtMs: Date.parse(pos.updated_at) });
}
const r = summarizeOrderFlow(trades);
console.log(`closed observed trades: ${r.tradeCount} (still open: ${open}, closed without an observation row: ${noObservation})`);
for (const [name, v] of [['A: raw d1/d2', r.variantA], ['B: Alpha Ladder final D', r.variantB]] as const) {
  console.log(`\n== Variant ${name} ==`);
  console.log(`RR bearish with bullish order-flow conflict: ${v.rrBearishWithBullishFlowConflict}`);
  console.log(`RR bullish with bearish order-flow conflict: ${v.rrBullishWithBearishFlowConflict}`);
  for (const g of ['MATCH', 'CONFLICT', 'NOT_COMPARABLE'] as const) {
    const s = v.groups[g];
    console.log(`${g.padEnd(15)} n=${s.n} pnl=${Math.round(s.pnl)} win=${s.winRatePct === null ? '-' : s.winRatePct.toFixed(0) + '%'} expectancy=${s.expectancy === null ? '-' : Math.round(s.expectancy)} PF=${s.profitFactor === null ? '-' : s.profitFactor.toFixed(2)} maxDD=${Math.round(s.maxDrawdown)}`);
  }
}
