/**
 * Definition 8.1/8.2 — monitor-leg target ladder and target-hit detection.
 * SHADOW never places a futures order (§31 of the Milestone 3
 * instructions) — this is purely logical/simulated, driven by the real
 * futures tick stream, and is enough to drive the option structure's exit.
 * F0 is never mutated once set.
 */
import type { Direction } from '../types.ts';
import type { Weekday } from '../calendar/signalCalendar.ts';

export interface MonitorState {
  direction: Direction;
  f0: number;
}

/** 300 points Wed-Fri, 400 points Mon-Tue (spec §9/§30). */
export function targetDistance(weekday: Weekday): number {
  return weekday === 'Monday' || weekday === 'Tuesday' ? 400 : 300;
}

/** F̂(t) = F0 + D·(300 or 400) — Eq (8.1). */
export function effectiveTarget(state: MonitorState, weekday: Weekday): number {
  return state.f0 + state.direction * targetDistance(weekday);
}

/** E_tgt condition: D·(F_t − F̂(t)) >= 0 — Eq (8.2). True the instant the future has moved AT LEAST the target distance in the favourable direction. */
export function targetHit(state: MonitorState, currentFuture: number, weekday: Weekday): boolean {
  const target = effectiveTarget(state, weekday);
  return state.direction * (currentFuture - target) >= 0;
}

/** Progress toward the target, in points travelled vs. points required — for the UI's progress bar. Clamped to [0, distance] since overshoot still reads as "target reached", not >100%. */
export function targetProgress(state: MonitorState, currentFuture: number, weekday: Weekday): { travelled: number; distance: number } {
  const distance = targetDistance(weekday);
  const travelled = Math.max(0, Math.min(distance, state.direction * (currentFuture - state.f0)));
  return { travelled, distance };
}
