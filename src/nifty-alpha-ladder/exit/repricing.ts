/**
 * Definition 9.5 — exit pricing and chase. Eq (9.2): escalating buffer
 * schedule Φx(i), floored by the late-session schedule Φℓ(i) after 15:20.
 */
import { THETA } from '../parameters.ts';

export function exitRepricingBuffer(iteration: number, schedule = THETA.EXIT_REPRICING_SCHEDULE): number {
  if (iteration < 5) return schedule.lt5;
  if (iteration < 12) return schedule.lt12;
  return schedule.ge12;
}

export function lateSessionFloor(iteration: number, schedule = THETA.LATE_SESSION_STRETCH_SCHEDULE): number {
  if (iteration < 5) return schedule.lt5;
  if (iteration < 12) return schedule.lt12;
  return schedule.ge12;
}

/** Φ̃(i) = max(Φx(i), 1{t>=15:20}·Φℓ(i)) — Eq (9.2). */
export function effectiveRepricingBuffer(iteration: number, isPastSafetyNetTime: boolean): number {
  const base = exitRepricingBuffer(iteration);
  if (!isPastSafetyNetTime) return base;
  return Math.max(base, lateSessionFloor(iteration));
}
