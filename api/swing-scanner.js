/**
 * Serves ranked results for whichever scanning strategy is asked for —
 * `?strategy=momentum` (default, the original weighted Swing Score under
 * a preset) or `?strategy=structure` (the fixed rule-based scan). Both are
 * a straight read of what the batch scripts already computed
 * (computeIndicators/computeSwingScores for momentum,
 * computeWeeklyOhlcv/computeStructureScores for structure). Nothing here
 * recomputes anything: re-deriving indicators or trade plans per request
 * would mean re-fetching full price history for the whole universe on
 * every page load, which is exactly the "hundreds of separate API calls"
 * spec §54 says to avoid. One endpoint for both rather than a second file,
 * to stay under Vercel Hobby's 12-serverless-function cap.
 */
import { createClient } from '@supabase/supabase-js';

const VALID_PRESETS = new Set(['balanced', 'momentum', 'breakout', 'early_breakout', 'pullback', 'aggressive']);

async function handleMomentum(supabase, req, res) {
  const preset = String(req.query.preset || 'balanced').toLowerCase();
  if (!VALID_PRESETS.has(preset)) {
    res.status(400).json({ error: 'bad_request', message: `Unknown preset "${preset}".` });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

  try {
    const { data: latestRow, error: latestErr } = await supabase
      .from('swing_scores').select('date').eq('preset', preset)
      .order('date', { ascending: false }).limit(1).maybeSingle();
    if (latestErr) throw latestErr;
    if (!latestRow) { res.status(200).json({ date: null, preset, stocks: [] }); return; }
    const date = latestRow.date;

    const { data: scores, error: scoresErr } = await supabase
      .from('swing_scores')
      .select(`symbol, swing_score, setup_type, entry_status, extension_risk,
        trend_score, momentum_score, relative_strength_score, setup_score,
        volume_score, sector_score, volatility_score, risk_reward_score,
        entry, stop, target, risk_reward`)
      .eq('date', date).eq('preset', preset)
      .order('swing_score', { ascending: false }).limit(limit);
    if (scoresErr) throw scoresErr;

    const symbols = scores.map((s) => s.symbol);
    const [{ data: stocksData, error: stocksErr }, { data: indicatorsData, error: indErr }] = await Promise.all([
      supabase.from('stocks').select('symbol,name,sector').in('symbol', symbols),
      supabase.from('indicators')
        .select('symbol,rs_vs_nifty_60d,vol_ratio,dist_52w_high_pct,dist_ath_pct,atr_pct,rsi14,adx14')
        .eq('date', date).in('symbol', symbols),
    ]);
    if (stocksErr) throw stocksErr;
    if (indErr) throw indErr;

    const stocksBySymbol = new Map(stocksData.map((s) => [s.symbol, s]));
    const indBySymbol = new Map(indicatorsData.map((r) => [r.symbol, r]));

    const results = scores.map((s) => {
      const meta = stocksBySymbol.get(s.symbol);
      const ind = indBySymbol.get(s.symbol) ?? {};
      return {
        symbol: s.symbol, name: meta?.name ?? s.symbol, sector: meta?.sector ?? null,
        price: s.entry, swingScore: s.swing_score, setupType: s.setup_type,
        entryStatus: s.entry_status, extensionRisk: s.extension_risk,
        stop: s.stop, target: s.target, riskReward: s.risk_reward,
        relativeStrength60d: ind.rs_vs_nifty_60d ?? null, volRatio: ind.vol_ratio ?? null,
        dist52wHighPct: ind.dist_52w_high_pct ?? null, distAthPct: ind.dist_ath_pct ?? null,
        atrPct: ind.atr_pct ?? null, rsi14: ind.rsi14 ?? null, adx14: ind.adx14 ?? null,
        factors: {
          trend: s.trend_score, momentum: s.momentum_score, relativeStrength: s.relative_strength_score,
          setup: s.setup_score, volume: s.volume_score, sector: s.sector_score,
          volatility: s.volatility_score, riskReward: s.risk_reward_score,
        },
      };
    });

    res.status(200).json({ date, preset, stocks: results });
  } catch (err) {
    res.status(502).json({ error: 'supabase_error', message: err.message });
  }
}

async function handleStructure(supabase, req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

  try {
    const { data: latestRow, error: latestErr } = await supabase
      .from('structure_scores').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
    if (latestErr) throw latestErr;
    if (!latestRow) { res.status(200).json({ date: null, stocks: [] }); return; }
    const date = latestRow.date;

    const { data: scores, error: scoresErr } = await supabase
      .from('structure_scores')
      .select(`symbol, score, close,
        gate_price_floor, gate_liquidity, gate_near_52w_high, gate_above_ema20, gate_weekly_rsi_ceiling, gate_weekly_higher_high,
        proximity_score, trend_score, weekly_momentum_score, weekly_breakout_score,
        pct_of_52w_high, pct_above_ema20, weekly_rsi14, weekly_high, prev_weekly_high`)
      .eq('date', date).eq('passes_all', true)
      .order('score', { ascending: false }).limit(limit);
    if (scoresErr) throw scoresErr;

    const symbols = scores.map((s) => s.symbol);
    const { data: stocksData, error: stocksErr } = symbols.length
      ? await supabase.from('stocks').select('symbol,name,sector').in('symbol', symbols)
      : { data: [], error: null };
    if (stocksErr) throw stocksErr;
    const stocksBySymbol = new Map(stocksData.map((s) => [s.symbol, s]));

    const results = scores.map((s) => {
      const meta = stocksBySymbol.get(s.symbol);
      return {
        symbol: s.symbol, name: meta?.name ?? s.symbol, sector: meta?.sector ?? null,
        price: s.close, score: s.score,
        gates: {
          priceFloor: s.gate_price_floor, liquidity: s.gate_liquidity, near52wHigh: s.gate_near_52w_high,
          aboveDailyEma20: s.gate_above_ema20, weeklyRsiCeiling: s.gate_weekly_rsi_ceiling, weeklyHigherHigh: s.gate_weekly_higher_high,
        },
        pctOf52wHigh: s.pct_of_52w_high, pctAboveEma20: s.pct_above_ema20,
        weeklyRsi14: s.weekly_rsi14, weeklyHigh: s.weekly_high, prevWeeklyHigh: s.prev_weekly_high,
        factors: {
          proximity: s.proximity_score, trend: s.trend_score,
          weeklyMomentum: s.weekly_momentum_score, weeklyBreakout: s.weekly_breakout_score,
        },
      };
    });

    res.status(200).json({ date, stocks: results });
  } catch (err) {
    res.status(502).json({ error: 'supabase_error', message: err.message });
  }
}

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    res.status(500).json({ error: 'server_misconfigured', message: 'Supabase is not configured.' });
    return;
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const strategy = String(req.query.strategy || 'momentum').toLowerCase();
  if (strategy === 'structure') { await handleStructure(supabase, req, res); return; }
  if (strategy === 'momentum') { await handleMomentum(supabase, req, res); return; }
  res.status(400).json({ error: 'bad_request', message: `Unknown strategy "${strategy}".` });
}
