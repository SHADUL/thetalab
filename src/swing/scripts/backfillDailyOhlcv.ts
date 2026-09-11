/**
 * Backfills daily OHLCV for the Swing Scanner universe from NSE's own
 * equity bhavcopy — not Kite. Kite's access token expires every ~20h and
 * can only be refreshed by an interactive login (redirect to Zerodha,
 * credentials, 2FA), which rules it out for an unattended nightly job
 * outright; automating that login would mean storing an actual account
 * password rather than an API key, a categorically riskier secret this
 * project isn't taking on. NSE's bhavcopy needs no auth at all — the same
 * credential-free source the options pipeline already uses for the
 * underlying index.
 *
 * Resumable by construction: it reads the latest date already in
 * daily_ohlcv and starts the day after, so a killed or re-run job picks up
 * exactly where it left off rather than re-downloading months of history.
 * A missing bhavcopy file (weekends, holidays) is a 404, not an error —
 * every trading day genuinely has one.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types \
 *     src/swing/scripts/backfillDailyOhlcv.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
 */
import { createClient } from '@supabase/supabase-js';

const BHAVCOPY_BASE = 'https://nsearchives.nseindia.com/products/content';
const USER_AGENT = 'Mozilla/5.0 (compatible; thetalab-swing-backfill/1.0)';
const MONTH: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function fmtDDMMYYYY(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`;
}
function fmtISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

interface BhavRow {
  symbol: string;
  date: string;
  open: number; high: number; low: number; close: number; volume: number;
}

/** NSE's own header has a leading space on every column after the first
 *  (" SERIES", " DATE1", ...) — trim rather than hard-code the exact
 *  spacing, which has changed before without notice. */
export function parseBhavcopy(text: string): BhavRow[] {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',').map((c) => c.trim());
  const idx = (name: string) => header.indexOf(name);
  const iSym = idx('SYMBOL'), iSeries = idx('SERIES'), iDate = idx('DATE1'),
    iOpen = idx('OPEN_PRICE'), iHigh = idx('HIGH_PRICE'), iLow = idx('LOW_PRICE'),
    iClose = idx('CLOSE_PRICE'), iVol = idx('TTL_TRD_QNTY');

  const rows: BhavRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = lines[i].split(',').map((c) => c.trim());
    if (cells.length < header.length || cells[iSeries] !== 'EQ') continue;
    const [dd, mon, yyyy] = cells[iDate].split('-');
    rows.push({
      symbol: cells[iSym], date: `${yyyy}-${MONTH[mon]}-${dd}`,
      open: Number(cells[iOpen]), high: Number(cells[iHigh]), low: Number(cells[iLow]),
      close: Number(cells[iClose]), volume: Number(cells[iVol]),
    });
  }
  return rows;
}

async function fetchBhavcopy(date: Date): Promise<BhavRow[] | null> {
  const url = `${BHAVCOPY_BASE}/sec_bhavdata_full_${fmtDDMMYYYY(date)}.csv`;
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) return null;
  return parseBhavcopy(await resp.text());
}

/** True when NSE served an earlier trading day's file back instead of the
 *  requested date — see the call site in the backfill loop. An empty
 *  `rows` (a genuinely empty-but-200 response) is never stale by this
 *  definition; that's a separate, already-handled case. */
export function isStaleResponse(rows: BhavRow[], requestedIso: string): boolean {
  return rows.length > 0 && rows[0].date !== requestedIso;
}

function argVal(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: stocks, error: stocksErr } = await supabase.from('stocks').select('symbol').eq('active', true);
  if (stocksErr) throw stocksErr;
  const universe = new Set((stocks ?? []).map((s: { symbol: string }) => s.symbol));
  if (universe.size === 0) throw new Error('stocks table is empty — run the universe seed first.');

  const defaultFrom = fmtISO(addDays(new Date(), -3 * 365));
  let from = new Date(argVal('--from', defaultFrom));
  const to = new Date(argVal('--to', fmtISO(new Date())));

  const explicitFrom = process.argv.includes('--from');
  if (!explicitFrom) {
    const { data: latest } = await supabase
      .from('daily_ohlcv').select('date').order('date', { ascending: false }).limit(1).maybeSingle();
    if (latest?.date) from = addDays(new Date(latest.date), 1);
  }

  console.log(`Universe: ${universe.size} symbols. Backfilling ${fmtISO(from)} -> ${fmtISO(to)}.`);

  let daysWithData = 0, daysWithoutData = 0, rowsUpserted = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const iso = fmtISO(d);
    const rows = await fetchBhavcopy(d);
    if (!rows) { daysWithoutData++; continue; }

    // NSE's archive doesn't cleanly 404 every non-trading day — on some
    // weekends/holidays it serves the *previous* trading day's file back
    // with a 200. The content's own DATE1 field gives that away even
    // though the request URL and HTTP status don't; matching against it
    // is what makes this loop idempotent rather than silently re-writing
    // (harmlessly, but wastefully, and confusingly in the logs) a date
    // already covered by the day it actually belongs to.
    if (isStaleResponse(rows, iso)) { daysWithoutData++; continue; }

    const filtered = rows
      .filter((r) => universe.has(r.symbol))
      .map((r) => ({ symbol: r.symbol, date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
    if (filtered.length === 0) { daysWithoutData++; continue; }

    const { error } = await supabase.from('daily_ohlcv').upsert(filtered, { onConflict: 'symbol,date' });
    if (error) { console.error(`  ${iso}: upsert failed — ${error.message}`); continue; }

    daysWithData++;
    rowsUpserted += filtered.length;
    console.log(`  ${iso}: ${filtered.length} symbols`);
    // NSE's static archive has no documented rate limit, but a short pause
    // keeps this a good citizen rather than hammering their servers.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(`Done. ${daysWithData} trading days written, ${daysWithoutData} non-trading days skipped, ${rowsUpserted} rows upserted.`);
}

// Only run when executed directly (`node ... backfillDailyOhlcv.ts`), not
// when imported — parseBhavcopy is exported for testing, and importing it
// shouldn't have the side effect of kicking off a real backfill.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
