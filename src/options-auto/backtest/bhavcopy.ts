/**
 * Historical multi-strike option chain data — the piece that didn't exist
 * anywhere in this codebase before now. Kite's own instrument dump only
 * ever lists currently-active-or-future contracts (confirmed empirically,
 * 2026-09-21: zero expired NIFTY option rows in a live /instruments/NFO
 * pull), so a long-expired strike's instrument_token is unrecoverable —
 * Kite's historical candle API can never be used to reconstruct a past
 * option chain. NSE and BSE's own daily F&O bhavcopy (the UDiFF format)
 * is the real, verified alternative: no auth, real settlement/OI/volume
 * per strike and expiry, confirmed accessible back to roughly early 2024
 * for both NIFTY/BANKNIFTY (NSE) and SENSEX (BSE).
 *
 * Settlement-only data (no bid/ask) — the exact same shape the quant
 * engine's enrichChain() already treats as its primary case (see its own
 * markPricePreference and every existing quant test's bhavcopyLikeChain()
 * fixture), so nothing new is needed there.
 */

export type HistoricalRight = 'CE' | 'PE';

export interface HistoricalOptionRow {
  right: HistoricalRight;
  strike: number;
  /** "YYYY-MM-DD", exactly NSE/BSE's own format. */
  expiry: string;
  settle: number;
  openInterest: number | null;
  volume: number | null;
}

export interface HistoricalChainDay {
  date: string;
  spot: number | null;
  /** From the bhavcopy's own NewBrdLotQty column — read per day rather than assumed, since it has changed historically (e.g. NIFTY 50 -> 65). */
  lotSize: number | null;
  rows: HistoricalOptionRow[];
}

const BHAVCOPY_EXCHANGE: Record<string, 'NSE' | 'BSE'> = {
  NIFTY: 'NSE',
  BANKNIFTY: 'NSE',
  SENSEX: 'BSE',
};

/** NSE serves a .zip; BSE serves the CSV directly — confirmed by fetching both live. */
export function bhavcopyUrl(symbol: string, dateISO: string): { url: string; zipped: boolean } {
  const exchange = BHAVCOPY_EXCHANGE[symbol];
  if (!exchange) throw new Error(`No bhavcopy source configured for symbol '${symbol}'.`);
  const compact = dateISO.replaceAll('-', '');
  return exchange === 'NSE'
    ? { url: `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${compact}_F_0000.csv.zip`, zipped: true }
    : { url: `https://www.bseindia.com/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_${compact}_F_0000.CSV`, zipped: false };
}

/**
 * Parses one day's UDiFF-format F&O bhavcopy CSV, filtered to one
 * underlying's CE/PE rows. Plain comma-split is safe here (unlike Kite's
 * instrument dump) — every UDiFF field is a short code or a number, no
 * free-text company name that could itself contain a comma.
 *
 * A settlement price of 0 means NSE/BSE didn't compute one for that row
 * that day (seen for genuinely dead/delisted strikes) — those rows are
 * dropped rather than kept with a fabricated price.
 */
export function parseUdiffBhavcopy(csvText: string, symbol: string, dateISO: string): HistoricalChainDay {
  const lines = csvText.split('\n');
  const rows: HistoricalOptionRow[] = [];
  let spot: number | null = null;
  let lotSize: number | null = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = line.split(',');
    if (cells.length < 29) continue;

    const ticker = cells[7]?.trim();
    if (ticker !== symbol) continue;
    const right = cells[12]?.trim();
    if (right !== 'CE' && right !== 'PE') continue;

    const strike = Number(cells[11]);
    const expiry = cells[9]?.trim();
    const settleRaw = Number(cells[21]);
    const closeRaw = Number(cells[17]);
    const settle = settleRaw > 0 ? settleRaw : closeRaw;
    const openInterestRaw = Number(cells[22]);
    const volumeRaw = Number(cells[24]);
    const underlyingRaw = Number(cells[20]);
    const lotSizeRaw = Number(cells[28]);

    if (!Number.isFinite(strike) || strike <= 0 || !expiry || !Number.isFinite(settle) || settle <= 0) continue;
    if (spot === null && Number.isFinite(underlyingRaw) && underlyingRaw > 0) spot = underlyingRaw;
    if (lotSize === null && Number.isFinite(lotSizeRaw) && lotSizeRaw > 0) lotSize = lotSizeRaw;

    rows.push({
      right, strike, expiry, settle,
      openInterest: Number.isFinite(openInterestRaw) ? openInterestRaw : null,
      volume: Number.isFinite(volumeRaw) ? volumeRaw : null,
    });
  }

  return { date: dateISO, spot, lotSize, rows };
}
