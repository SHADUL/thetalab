/**
 * NIFTY PULSE client store — Phase 2 drives it from the deterministic
 * replay (SIMULATION). Phase 3 swaps the source for the server's live
 * paper engine; the snapshot shape stays the same so the workspaces don't
 * change.
 *
 * Performance: the engine steps outside React. Components subscribe with
 * `usePulse(selector)` and re-render only when their selected value changes
 * (Object.is), at most once per UI frame batch (≤ 4 Hz at high replay speed).
 */
import { useSyncExternalStore } from "react";
import { Replay } from "../../nifty-pulse/sim/replay.ts";
import { PRESETS, DEFAULT_PRESET_ID, deriveVersion, validateConfig } from "../../nifty-pulse/core/config.ts";
import { computeAnalytics } from "../../nifty-pulse/core/analytics.ts";

export const SIM_DATE = "2026-11-13";
const PREFS_KEY = "niftyPulse.prefs";
const CUSTOM_KEY = "niftyPulse.customConfigs";

function loadJson(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function saveJson(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode etc. */ }
}

function loadCustom() {
  const raw = loadJson(CUSTOM_KEY, []);
  const out = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (c && c.paperOnly === true && !validateConfig(c).length) out.push(Object.freeze({ ...c, immutable: false, paperOnly: true }));
  }
  return out;
}

const listeners = new Set();
let state = null;
let timer = null;
let lastEmit = 0;
let pendingEmit = false;

function allConfigs() { return [...PRESETS, ...state.custom]; }
function configFor(id) { return allConfigs().find((c) => `${c.id}@${c.version}` === id || c.id === id) ?? PRESETS[0]; }

function buildReplay(seed, configId, startAt) {
  const replay = new Replay({ seed, date: SIM_DATE, config: configFor(configId) });
  replay.advanceTo(startAt ?? Date.parse(`${SIM_DATE}T10:05:00+05:30`));
  return replay;
}

function init() {
  if (state) return;
  const prefs = loadJson(PREFS_KEY, {});
  const custom = loadCustom();
  state = {
    seed: Number.isInteger(prefs.seed) ? prefs.seed : 42,
    configId: typeof prefs.configId === "string" ? prefs.configId : DEFAULT_PRESET_ID,
    speed: [1, 2, 5, 20, 60].includes(prefs.speed) ? prefs.speed : 1,
    playing: true,
    custom,
    replay: null,
    version: 0,
    snap: null,
    analyticsMulti: null,
  };
  state.replay = buildReplay(state.seed, state.configId);
  state.snap = makeSnap();
  schedule();
}

function persist() { saveJson(PREFS_KEY, { seed: state.seed, configId: state.configId, speed: state.speed }); }

function emit(force = false) {
  const now = performance.now();
  if (!force && now - lastEmit < 240) {
    if (!pendingEmit) { pendingEmit = true; setTimeout(() => { pendingEmit = false; emit(true); }, 250); }
    return;
  }
  lastEmit = now;
  state.version++;
  state.snap = makeSnap();
  for (const l of listeners) l();
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (!state.playing) return;
  const interval = state.speed <= 4 ? 1000 / state.speed : 250;
  const perTick = state.speed <= 4 ? 1 : Math.round(state.speed / 4);
  timer = setInterval(() => {
    const n = state.replay.advance(perTick);
    if (state.replay.done) { state.playing = false; clearInterval(timer); timer = null; }
    if (n || !state.playing) emit(state.speed <= 4);
  }, interval);
}

/** Derived, render-ready values. Arrays are shared references (not copied). */
function makeSnap() {
  const r = state.replay;
  const e = r.engine;
  const samples = e.samples;
  const last = samples[samples.length - 1] ?? null;
  const first = samples.find((s) => s.price != null) ?? null;
  const pos = e.position;
  const unreal = pos?.mark?.markedNet ?? null;
  let fresh = 0, held = 0, stale = 0, ticks60 = 0;
  for (let i = Math.max(0, samples.length - 60); i < samples.length; i++) {
    const s = samples[i];
    if (s.status === "FRESH") fresh++; else if (s.status === "HELD") held++; else stale++;
    ticks60 += s.ticks;
  }
  const lat = e.latencies;
  const latAvg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null;
  const latMax = lat.length ? Math.max(...lat) : null;
  const lastTick = e.samples.length ? findLastTickAt(samples) : null;
  const cfg = e.config;
  const lossUsed = Math.max(0, -e.realizedToday);
  const tradesToday = e.trades.length + (pos ? 1 : 0);
  const marketOpen = r.now >= r.openMs && r.now < r.closeMs;
  const riskStatus = e.killSwitch ? "KILL" : lossUsed >= cfg.maxDailyLoss ? "LIMIT" : tradesToday >= cfg.maxTradesPerDay ? "CAPPED" : "OK";
  return {
    v: state.version,
    mode: "SIMULATION",
    seed: state.seed,
    date: SIM_DATE,
    playing: state.playing,
    speed: state.speed,
    done: r.done,
    now: r.now,
    openMs: r.openMs,
    closeMs: r.closeMs,
    marketOpen,
    config: cfg,
    configs: allConfigs(),
    price: last?.price ?? null,
    dayOpen: first?.price ?? null,
    changePct: last?.price != null && first?.price ? (last.price / first.price - 1) * 100 : null,
    sample: last,
    lastTickAt: lastTick,
    dataAgeMs: last?.ageMs ?? null,
    feed: { fresh, held, stale, ticks60, latAvg, latMax, gaps: e.stats.feedGaps, accepted: e.stats.ticksAccepted, dropped: e.stats.ticksDropped },
    indicators: e.indicators,
    signal: e.signal,
    episode: e.episode,
    statusReason: e.statusReason(),
    running: e.running,
    killSwitch: e.killSwitch,
    position: pos,
    trades: e.trades,
    tradesCount: e.trades.length,
    tradesToday,
    realized: e.realizedToday,
    unrealized: unreal,
    lossUsed,
    cooldownLeft: e.cooldownLeftSec(),
    lastRejection: e.lastRejection,
    riskStatus,
    timelineLen: e.timeline.length,
    stats: e.stats,
  };
}

function findLastTickAt(samples) {
  for (let i = samples.length - 1; i >= 0 && i > samples.length - 600; i--) if (samples[i].ticks > 0) return samples[i].t - (samples[i].ageMs ?? 0);
  return null;
}

// ── Public API ─────────────────────────────────────────────────────────
export const pulse = {
  subscribe(l) { init(); listeners.add(l); return () => listeners.delete(l); },
  get snap() { init(); return state.snap; },
  get engine() { init(); return state.replay.engine; },
  get replay() { init(); return state.replay; },
  chain() { init(); return state.replay.chain(); },
  play() { state.playing = !state.replay.done; schedule(); emit(true); },
  pause() { state.playing = false; schedule(); emit(true); },
  setSpeed(s) { state.speed = s; persist(); schedule(); emit(true); },
  step(n = 1) { state.replay.advance(n); emit(true); },
  jumpTo(hhmm) {
    const target = Date.parse(`${SIM_DATE}T${hhmm}:00+05:30`);
    if (target < state.replay.now) state.replay = buildReplay(state.seed, state.configId, target);
    else state.replay.advanceTo(target);
    emit(true);
  },
  restart(seed = state.seed) {
    state.seed = seed;
    persist();
    state.replay = buildReplay(seed, state.configId, Date.parse(`${SIM_DATE}T09:15:00+05:30`));
    state.playing = true;
    schedule();
    emit(true);
  },
  /** Switch the active config. Rebuilds the replay so every trade runs under exactly one config. */
  activate(configId) {
    state.configId = configId;
    persist();
    const at = state.replay.now;
    state.replay = buildReplay(state.seed, configId, at);
    emit(true);
  },
  startEngine() { state.replay.engine.start(state.replay.now); emit(true); },
  stopEngine() { state.replay.engine.stop(state.replay.now); emit(true); },
  setKill(on) { state.replay.engine.setKillSwitch(on, state.replay.now); emit(true); },
  flatten() { state.replay.engine.flatten(state.replay.now); emit(true); },
  saveVersion(base, changes, name) {
    const nextVersion = 1 + Math.max(1, ...allConfigs().filter((c) => (c.parentId ?? c.id) === (base.parentId ?? base.id)).map((c) => c.version));
    const v = deriveVersion(base, changes, nextVersion, name);
    state.custom = [...state.custom, v];
    saveJson(CUSTOM_KEY, state.custom);
    emit(true);
    return v;
  },
  deleteVersion(v) {
    state.custom = state.custom.filter((c) => !(c.id === v.id && c.version === v.version));
    saveJson(CUSTOM_KEY, state.custom);
    if (state.configId === `${v.id}@${v.version}`) this.activate(DEFAULT_PRESET_ID);
    emit(true);
  },
  activeConfigId() { return state.configId; },
  /** Multi-session simulation analytics, computed in chunks so the UI stays responsive. */
  runMultiSession(count, onProgress) {
    const cfg = configFor(state.configId);
    const trades = [];
    const stats = { episodes: 0, attempts: 0, entries: 0, rejections: 0 };
    let i = 0;
    return new Promise((resolve) => {
      const dates = [];
      let d = new Date(`${SIM_DATE}T00:00:00Z`);
      while (dates.length < count) { const wd = d.getUTCDay(); if (wd >= 1 && wd <= 5) dates.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() - 86_400_000); }
      dates.reverse();
      const next = () => {
        if (i >= count) {
          const a = computeAnalytics(trades, stats);
          state.analyticsMulti = { configKey: `${cfg.id}@v${cfg.version}`, count, analytics: a, trades };
          resolve(state.analyticsMulti);
          return;
        }
        const rp = new Replay({ seed: state.seed * 1000 + i + 1, date: dates[i], config: cfg });
        rp.runToEnd();
        trades.push(...rp.engine.trades);
        for (const k of Object.keys(stats)) stats[k] += rp.engine.stats[k];
        i++;
        onProgress?.(i / count);
        setTimeout(next, 0);
      };
      next();
    });
  },
  get analyticsMulti() { return state?.analyticsMulti ?? null; },
};

/** Subscribe to a slice of the snapshot. */
export function usePulse(selector) {
  const get = () => selector(pulse.snap);
  return useSyncExternalStore(pulse.subscribe, get, get);
}
