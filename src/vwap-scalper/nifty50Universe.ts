/**
 * The tradable universe for the VWAP 3σ scalper — NIFTY 50 constituents,
 * chosen specifically for this mean-reversion scalp because it needs
 * tight spreads and real volume (see this module's own README/commit
 * history) — thin names would make touch/rejection signals unfillable in
 * practice even if they fire cleanly on the chart.
 *
 * SOURCED, not guessed: pulled directly from NSE's own official
 * constituent list (archives.nseindia.com/content/indices/ind_nifty50list.csv)
 * on 2026-09-21. NIFTY 50 rebalances semi-annually (cut-off dates 31 Jan
 * and 31 Jul, per NSE's own index methodology) — this list should be
 * re-verified against that same URL at least that often, not assumed
 * permanent.
 */
export interface UniverseStock {
  symbol: string; // NSE tradingsymbol, e.g. "RELIANCE"
  companyName: string;
  industry: string;
}

export const NIFTY_50_LAST_VERIFIED = '2026-09-21';

export const NIFTY_50_UNIVERSE: UniverseStock[] = [
  { symbol: 'ADANIENT', companyName: "Adani Enterprises Ltd.", industry: 'Metals & Mining' },
  { symbol: 'ADANIPORTS', companyName: 'Adani Ports and Special Economic Zone Ltd.', industry: 'Services' },
  { symbol: 'APOLLOHOSP', companyName: 'Apollo Hospitals Enterprise Ltd.', industry: 'Healthcare' },
  { symbol: 'ASIANPAINT', companyName: 'Asian Paints Ltd.', industry: 'Consumer Durables' },
  { symbol: 'AXISBANK', companyName: 'Axis Bank Ltd.', industry: 'Financial Services' },
  { symbol: 'BAJAJ-AUTO', companyName: 'Bajaj Auto Ltd.', industry: 'Automobile and Auto Components' },
  { symbol: 'BAJFINANCE', companyName: 'Bajaj Finance Ltd.', industry: 'Financial Services' },
  { symbol: 'BAJAJFINSV', companyName: 'Bajaj Finserv Ltd.', industry: 'Financial Services' },
  { symbol: 'BEL', companyName: 'Bharat Electronics Ltd.', industry: 'Capital Goods' },
  { symbol: 'BHARTIARTL', companyName: 'Bharti Airtel Ltd.', industry: 'Telecommunication' },
  { symbol: 'CIPLA', companyName: 'Cipla Ltd.', industry: 'Healthcare' },
  { symbol: 'COALINDIA', companyName: 'Coal India Ltd.', industry: 'Oil Gas & Consumable Fuels' },
  { symbol: 'DRREDDY', companyName: "Dr. Reddy's Laboratories Ltd.", industry: 'Healthcare' },
  { symbol: 'EICHERMOT', companyName: 'Eicher Motors Ltd.', industry: 'Automobile and Auto Components' },
  { symbol: 'ETERNAL', companyName: 'Eternal Ltd.', industry: 'Consumer Services' },
  { symbol: 'GRASIM', companyName: 'Grasim Industries Ltd.', industry: 'Construction Materials' },
  { symbol: 'HCLTECH', companyName: 'HCL Technologies Ltd.', industry: 'Information Technology' },
  { symbol: 'HDFCBANK', companyName: 'HDFC Bank Ltd.', industry: 'Financial Services' },
  { symbol: 'HDFCLIFE', companyName: 'HDFC Life Insurance Company Ltd.', industry: 'Financial Services' },
  { symbol: 'HINDALCO', companyName: 'Hindalco Industries Ltd.', industry: 'Metals & Mining' },
  { symbol: 'HINDUNILVR', companyName: 'Hindustan Unilever Ltd.', industry: 'Fast Moving Consumer Goods' },
  { symbol: 'ICICIBANK', companyName: 'ICICI Bank Ltd.', industry: 'Financial Services' },
  { symbol: 'ITC', companyName: 'ITC Ltd.', industry: 'Fast Moving Consumer Goods' },
  { symbol: 'INFY', companyName: 'Infosys Ltd.', industry: 'Information Technology' },
  { symbol: 'INDIGO', companyName: 'InterGlobe Aviation Ltd.', industry: 'Services' },
  { symbol: 'JSWSTEEL', companyName: 'JSW Steel Ltd.', industry: 'Metals & Mining' },
  { symbol: 'JIOFIN', companyName: 'Jio Financial Services Ltd.', industry: 'Financial Services' },
  { symbol: 'KOTAKBANK', companyName: 'Kotak Mahindra Bank Ltd.', industry: 'Financial Services' },
  { symbol: 'LT', companyName: 'Larsen & Toubro Ltd.', industry: 'Construction' },
  { symbol: 'M&M', companyName: 'Mahindra & Mahindra Ltd.', industry: 'Automobile and Auto Components' },
  { symbol: 'MARUTI', companyName: 'Maruti Suzuki India Ltd.', industry: 'Automobile and Auto Components' },
  { symbol: 'MAXHEALTH', companyName: 'Max Healthcare Institute Ltd.', industry: 'Healthcare' },
  { symbol: 'NTPC', companyName: 'NTPC Ltd.', industry: 'Power' },
  { symbol: 'NESTLEIND', companyName: 'Nestle India Ltd.', industry: 'Fast Moving Consumer Goods' },
  { symbol: 'ONGC', companyName: 'Oil & Natural Gas Corporation Ltd.', industry: 'Oil Gas & Consumable Fuels' },
  { symbol: 'POWERGRID', companyName: 'Power Grid Corporation of India Ltd.', industry: 'Power' },
  { symbol: 'RELIANCE', companyName: 'Reliance Industries Ltd.', industry: 'Oil Gas & Consumable Fuels' },
  { symbol: 'SBILIFE', companyName: 'SBI Life Insurance Company Ltd.', industry: 'Financial Services' },
  { symbol: 'SHRIRAMFIN', companyName: 'Shriram Finance Ltd.', industry: 'Financial Services' },
  { symbol: 'SBIN', companyName: 'State Bank of India', industry: 'Financial Services' },
  { symbol: 'SUNPHARMA', companyName: 'Sun Pharmaceutical Industries Ltd.', industry: 'Healthcare' },
  { symbol: 'TCS', companyName: 'Tata Consultancy Services Ltd.', industry: 'Information Technology' },
  { symbol: 'TATACONSUM', companyName: 'Tata Consumer Products Ltd.', industry: 'Fast Moving Consumer Goods' },
  { symbol: 'TMPV', companyName: 'Tata Motors Passenger Vehicles Ltd.', industry: 'Automobile and Auto Components' },
  { symbol: 'TATASTEEL', companyName: 'Tata Steel Ltd.', industry: 'Metals & Mining' },
  { symbol: 'TECHM', companyName: 'Tech Mahindra Ltd.', industry: 'Information Technology' },
  { symbol: 'TITAN', companyName: 'Titan Company Ltd.', industry: 'Consumer Durables' },
  { symbol: 'TRENT', companyName: 'Trent Ltd.', industry: 'Consumer Services' },
  { symbol: 'ULTRACEMCO', companyName: 'UltraTech Cement Ltd.', industry: 'Construction Materials' },
  { symbol: 'WIPRO', companyName: 'Wipro Ltd.', industry: 'Information Technology' },
];
