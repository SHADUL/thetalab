/* Model-generated sample chain — for demonstrating the interface only.
   These are not market prices and must not be used for analysis. */
import { bs } from "./options";

export function makeDemo() {
  const expiry = "2026-04-28";
  const dates = ["2026-04-07","2026-04-08","2026-04-09","2026-04-10","2026-04-13","2026-04-15",
    "2026-04-16","2026-04-17","2026-04-20","2026-04-21","2026-04-22","2026-04-23","2026-04-24",
    "2026-04-27","2026-04-28"];
  const spots = [24010,23880,23960,24050,23606,23710,23640,23820,23900,23770,23840,23950,24020,23960,24080];
  const strikes = []; for (let k = 22500; k <= 25500; k += 50) strikes.push(k);
  const chain = {}, spot = {};
  dates.forEach((d, i) => {
    spot[d] = spots[i];
    const T = Math.max((new Date(expiry) - new Date(d)) / 86400000, 0.35) / 365;
    const row = {};
    strikes.forEach((k) => {
      const m = Math.abs(k - spots[i]) / spots[i];
      const v = 0.115 + 9 * m * m;
      row[String(k)] = {
        c: +Math.max(bs(spots[i], k, T, v, true), 0.05).toFixed(2),
        p: +Math.max(bs(spots[i], k, T, v, false), 0.05).toFixed(2),
      };
    });
    chain[d] = row;
  });
  return { symbol: "NIFTY (sample)", source: "model-generated",
    expiries: { [expiry]: { dates, spot, strikes, chain } } };
}
