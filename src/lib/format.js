export const inr = (v) => {
  if (v == null || Number.isNaN(v)) return "—";
  const a = Math.abs(v), sg = v < 0 ? "−" : "";
  if (a >= 1e7) return `${sg}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sg}₹${(a / 1e5).toFixed(2)}L`;
  return `${sg}₹${Math.round(a).toLocaleString("en-IN")}`;
};
export const sgn = (v) =>
  v == null || Number.isNaN(v) ? "—" : (v > 0 ? "+" : "") + inr(v);
/* Compact counts on the Indian scale — open interest, volume. No currency
   symbol: these are contract quantities, not money. */
export const cnt = (v) => {
  if (v == null || Number.isNaN(v)) return "—";
  const a = Math.abs(v), sg = v < 0 ? "−" : "";
  if (a >= 1e7) return `${sg}${(a / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${sg}${(a / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${sg}${(a / 1e3).toFixed(1)}K`;
  return `${sg}${Math.round(a)}`;
};
export const scnt = (v) =>
  v == null || Number.isNaN(v) ? "—" : (v > 0 ? "+" : "") + cnt(v);

export const fm = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
export const fi = (v) => (v == null || Number.isNaN(v) ? "—" : Math.round(v).toLocaleString("en-IN"));
export const cx = (...a) => a.filter(Boolean).join(" ");
