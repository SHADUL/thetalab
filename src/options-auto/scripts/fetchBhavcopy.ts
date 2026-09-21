/**
 * Fetches (and locally caches) one day's NSE/BSE F&O bhavcopy, then hands
 * it to bhavcopy.ts's pure parser. This is the one impure piece — network
 * + filesystem + `unzip` (NSE serves a .zip; BSE serves plain CSV, see
 * bhavcopyUrl()'s own comment) — kept separate from parsing so the parser
 * itself stays pure and unit-testable without any of this.
 *
 * Caches the raw CSV text to disk so re-running a backtest over the same
 * date range doesn't re-hit NSE/BSE's servers every time — both are free,
 * unauthenticated public archives, but hammering them repeatedly during
 * iterative backtest development would be an inconsiderate way to use
 * that. A missing day (weekend, exchange holiday) is cached as an empty
 * marker file so the 404 isn't re-attempted either.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bhavcopyUrl, parseUdiffBhavcopy, type HistoricalChainDay } from '../backtest/bhavcopy.ts';

const CACHE_DIR = join(import.meta.dirname, '..', 'backtest', '.bhavcopy-cache');
const MISSING_MARKER = '__MISSING__';

function cachePath(symbol: string, dateISO: string): string {
  return join(CACHE_DIR, `${symbol}_${dateISO}.csv`);
}

async function downloadCsvText(url: string, zipped: boolean): Promise<string | null> {
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Bhavcopy fetch failed: ${resp.status} for ${url}`);

  if (!zipped) return resp.text();

  const buf = Buffer.from(await resp.arrayBuffer());
  const tmpDir = join(tmpdir(), `bhavcopy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  const zipPath = join(tmpDir, 'bhav.zip');
  writeFileSync(zipPath, buf);
  try {
    execFileSync('unzip', ['-o', zipPath, '-d', tmpDir], { stdio: 'pipe' });
    const entries = execFileSync('unzip', ['-Z1', zipPath]).toString('utf8').trim().split('\n');
    const csvEntry = entries.find((e) => e.toLowerCase().endsWith('.csv'));
    if (!csvEntry) return null;
    return readFileSync(join(tmpDir, csvEntry), 'utf8');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Returns null when the day genuinely has no bhavcopy (weekend/holiday) — not an error. */
export async function fetchHistoricalChainDay(symbol: string, dateISO: string): Promise<HistoricalChainDay | null> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cache = cachePath(symbol, dateISO);

  let csvText: string | null;
  if (existsSync(cache)) {
    const cached = readFileSync(cache, 'utf8');
    csvText = cached === MISSING_MARKER ? null : cached;
  } else {
    const { url, zipped } = bhavcopyUrl(symbol, dateISO);
    csvText = await downloadCsvText(url, zipped);
    writeFileSync(cache, csvText ?? MISSING_MARKER);
  }

  if (csvText === null) return null;
  return parseUdiffBhavcopy(csvText, symbol, dateISO);
}
