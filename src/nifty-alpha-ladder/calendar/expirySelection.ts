/**
 * Definition 3.1 — expiry selection. e*(d) = e2 if (e1−d) ≤ 1 calendar day
 * AND there is more than one listed expiry; e*(d) = e1 otherwise.
 */

const MS_PER_DAY = 86_400_000;

/** `listedExpiries` need not be sorted or pre-filtered; this filters to strictly-after `signalDate` and sorts ascending itself. */
export function selectExpiry(signalDate: Date, listedExpiries: Date[]): Date | null {
  const future = listedExpiries
    .filter((e) => e.getTime() > signalDate.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  if (future.length === 0) return null;
  const e1 = future[0];
  const e2 = future[1];
  const daysToE1 = (e1.getTime() - signalDate.getTime()) / MS_PER_DAY;
  if (daysToE1 <= 1 && e2) return e2;
  return e1;
}
