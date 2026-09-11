/**
 * Populates market_regime.nifty_close from NIFTY's own daily close history —
 * which this project already has, sitting in public/chain_bundle.json (built
 * for the options side), rather than fetching it again from anywhere. Each
 * expiry entry in that bundle only carries a lookback window of spot prices,
 * not a continuous series, but weekly expiries are close enough together
 * that their windows overlap: merging every expiry's `spot` dict gives a
 * complete daily series with zero conflicting values between overlapping
 * windows (verified directly against NSE's holiday calendar before relying
 * on this).
 *
 * This is what relative-strength calculations (spec §14) read "NIFTY's
 * price N sessions ago" from, and it's the seed for the Market Regime
 * dashboard (spec §3) — the other regime fields (EMA/breadth/VIX) get
 * filled in by a later pass once there's a reason to compute them daily
 * rather than backfill them once.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types \
 *     src/swing/scripts/seedNiftyClose.ts
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

interface ChainBundle {
  expiries: Record<string, { spot?: Record<string, number> }>;
}

export function mergeNiftySpotFromBundle(bundle: ChainBundle): Map<string, number> {
  const merged = new Map<string, number>();
  for (const expiry of Object.values(bundle.expiries)) {
    for (const [date, value] of Object.entries(expiry.spot ?? {})) {
      const existing = merged.get(date);
      if (existing != null && Math.abs(existing - value) > 1e-6) {
        console.warn(`  conflicting NIFTY close on ${date}: ${existing} vs ${value} — keeping the first`);
        continue;
      }
      merged.set(date, value);
    }
  }
  return merged;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const bundlePath = process.argv[2] ?? 'public/chain_bundle.json';
  const bundle: ChainBundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const merged = mergeNiftySpotFromBundle(bundle);
  console.log(`Merged ${merged.size} distinct NIFTY close dates from ${bundlePath}.`);

  const rows = [...merged.entries()].map(([date, nifty_close]) => ({ date, nifty_close }));
  // Supabase batches large upserts fine, but a few thousand rows in one
  // request is still worth chunking to stay well under any request-size
  // ceiling rather than finding one the hard way.
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from('market_regime').upsert(chunk, { onConflict: 'date' });
    if (error) throw error;
    written += chunk.length;
    console.log(`  ${written}/${rows.length}`);
  }

  console.log(`Done. ${written} dates upserted into market_regime.nifty_close.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
