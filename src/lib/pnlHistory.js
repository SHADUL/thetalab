/**
 * One combined-P&L point per calendar day per instrument, recorded passively
 * whenever Portfolio successfully prices itself — not a background job, so a
 * day you never opened Portfolio on simply has no point. Keyed by symbol
 * because a NIFTY book and a SENSEX book have nothing to do with each other.
 */
const KEY = "thetalab-pnl-history-v1";

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); }
  catch { return {}; }
}

export function readPnlHistory(symbol) {
  const bySymbol = load()[symbol] || {};
  return Object.entries(bySymbol)
    .map(([date, pnl]) => ({ date, pnl }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function recordPnl(symbol, date, pnl) {
  const all = load();
  const bySymbol = all[symbol] ?? (all[symbol] = {});
  if (bySymbol[date] === pnl) return;
  bySymbol[date] = pnl;
  try { localStorage.setItem(KEY, JSON.stringify(all)); }
  catch { /* private mode — not worth interrupting for */ }
}
