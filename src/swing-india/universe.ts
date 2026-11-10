/**
 * Scan universe: the Nifty 100 (Nifty 50 + Nifty Next 50) as of late 2025.
 * Index membership changes twice a year; any symbol not present in the
 * `stocks` table (Nifty 500 master) is simply skipped by the API, so a
 * stale name here costs nothing. Large caps only, which stands in for the
 * skill's ₹5,000 cr market-cap floor (no market-cap feed is available).
 */
export const NIFTY100: string[] = [
  // Nifty 50
  'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK', 'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV',
  'BEL', 'BHARTIARTL', 'CIPLA', 'COALINDIA', 'DRREDDY', 'EICHERMOT', 'ETERNAL', 'GRASIM', 'HCLTECH', 'HDFCBANK',
  'HDFCLIFE', 'HEROMOTOCO', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK', 'INDIGO', 'INFY', 'ITC', 'JIOFIN', 'JSWSTEEL',
  'KOTAKBANK', 'LT', 'M&M', 'MARUTI', 'MAXHEALTH', 'NESTLEIND', 'NTPC', 'ONGC', 'POWERGRID', 'RELIANCE',
  'SBILIFE', 'SBIN', 'SHRIRAMFIN', 'SUNPHARMA', 'TATACONSUM', 'TMPV', 'TATASTEEL', 'TCS', 'TECHM', 'TITAN',
  'TRENT', 'ULTRACEMCO', 'WIPRO',
  // Nifty Next 50
  'ABB', 'ADANIENSOL', 'ADANIGREEN', 'ADANIPOWER', 'AMBUJACEM', 'BAJAJHLDNG', 'BAJAJHFL', 'BANKBARODA', 'BOSCHLTD',
  'BPCL', 'BRITANNIA', 'CANBK', 'CGPOWER', 'CHOLAFIN', 'DABUR', 'DIVISLAB', 'DLF', 'DMART', 'GAIL', 'GODREJCP',
  'HAL', 'HAVELLS', 'HINDZINC', 'HYUNDAI', 'ICICIGI', 'ICICIPRULI', 'IOC', 'IRFC', 'JINDALSTEL', 'JSWENERGY',
  'LICI', 'LODHA', 'LTIM', 'MOTHERSON', 'NAUKRI', 'PFC', 'PIDILITIND', 'PNB', 'RECLTD', 'SHREECEM', 'SIEMENS',
  'SOLARINDS', 'SWIGGY', 'TATAPOWER', 'TMCV', 'TORNTPHARM', 'TVSMOTOR', 'UNITDSPR', 'VBL', 'VEDL', 'ZYDUSLIFE',
  'ENRIN',
];
