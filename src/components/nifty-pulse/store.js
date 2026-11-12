/**
 * NIFTY PULSE client store. Two sources, one snapshot shape:
 *
 *   SIMULATION — the deterministic replay runs in the browser.
 *   LIVE       — the server's live PAPER engine (real NIFTY prices from the
 *                shared Kite stream) is mirrored by polling
 *                /api/nifty-pulse once a second. The browser never sees
 *                Kite credentials and there is no order path anywhere.
 *
 * In LIVE mode a local PulseEngine instance is used purely as a mirror
 * (its fields are overwritten from the server; it never steps), so every
 * workspace reads the same object shape in both modes.
 *
 * Performance: the engine steps outside React. Components subscribe with
 * `usePulse(selector)` and re-render only when their selected value changes
 * (Object.is), at most once per UI frame batch (≤ 4 Hz at high replay speed).
 */
import { useSyncExternalStore } from "react";
import { Replay } from "../../nifty-pulse/sim/replay.ts";
import { PRESETS, DEFAULT_PRESET_ID, deriveVersion, validateConfig } from "../../nifty-pulse/core/config.ts";
import { computeAnalytics } from "../../nifty-pulse/core/analytics.ts";
import { PulseEngine } from "../../nifty-pulse/core/engine.ts";
import { chainFromWire } from "../../nifty-pulse/live/liveChain.ts";
import { sessionOpenMs, sessionCloseMs } from "../../nifty-pulse/sim/market.ts";

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

const API = "/api/nifty-pulse";
const STATUS = ["FRESH", "HELD", "STALE", "NO_DATA"];
const MAX_TIMELINE = 6000;

// ── LIVE mirror ────────────────────────────────────────────────────────
function newLive() {
  return {
    enabled: null, // null = not yet known
    reason: null,
    error: null,
    sid: null,
    engine: new PulseEngine(PRESETS[0], { dataMode: "LIVE_PAPER", running: false }),
    chain: null,
    meta: null,
    serverNow: null,
    lastOkAt: null,
    notice: null,
    busy: false,
    history: null,
  };
}

function applyLive(L, r) {
  L.enabled = !!r.enabled;
  L.reason = r.reason ?? null;
  L.error = null;
  if (!r.enabled) return;
  const w = r.engine;
  let e = L.engine;
  if (r.reset || L.sid !== r.sid) {
    e = new PulseEngine(w.config, { dataMode: "LIVE_PAPER", running: false });
    L.engine = e;
    L.sid = r.sid;
  }
  e.config = w.config;
  e.running = w.running;
  e.killSwitch = w.killSwitch;
  e.now = w.now;
  e.indicators = w.indicators;
  e.signal = w.signal;
  e.episode = w.episode;
  e.position = w.position;
  if (w.trades) e.trades.splice(0, e.trades.length, ...w.trades);
  if (w.lastCandidates) e.lastCandidates = w.lastCandidates;
  e.lastCandidatesAt = w.lastCandidatesAt;
  e.lastRejection = w.lastRejection;
  e.lastExitAt = w.lastExitAt;
  e.realizedToday = w.realizedToday;
  e.validRun = w.validRun;
  e.latencies.splice(0, e.latencies.length, ...w.latencies);
  Object.assign(e.stats, w.stats);
  for (const [t, price, st, ticks, ageMs, exchTs] of w.samples) {
    const status = STATUS[st] ?? "NO_DATA";
    e.samples.push({ t, price, status, valid: status === "FRESH" || status === "HELD", ticks, ageMs, exchTs });
  }
  if (w.timeline.length) { e.timeline.push(...w.timeline); if (e.timeline.length > MAX_TIMELINE) e.timeline.splice(0, e.timeline.length - MAX_TIMELINE); }
  if (w.decisions.length) { e.decisions.push(...w.decisions); if (e.decisions.length > 500) e.decisions.splice(0, e.decisions.length - 500); }
  L.chain = r.chain ? chainFromWire(r.chain) : null;
  L.serverNow = r.serverNow;
  L.meta = { market: r.market, feed: r.feed, instruments: r.instruments, loop: r.loop, recorder: r.recorder, store: r.store, sessionDay: r.sessionDay, configId: r.configId };
  L.lastOkAt = Date.now();
}

async function pollLive() {
  const L = state.live;
  if (L.busy) return;
  L.busy = true;
  try {
    const e = L.engine;
    const q = new URLSearchParams({ resource: "snapshot" });
    if (L.sid) {
      q.set("sid", L.sid);
      const last = e.samples[e.samples.length - 1];
      if (last) q.set("s", String(last.t));
      const ev = e.timeline[e.timeline.length - 1];
      if (ev) q.set("e", String(ev.seq));
      const d = e.decisions[e.decisions.length - 1];
      if (d) q.set("d", String(d.at));
      q.set("tc", String(e.trades.length));
      if (e.lastCandidatesAt != null) q.set("c", String(e.lastCandidatesAt));
    }
    const res = await fetch(`${API}?${q}`, { credentials: "same-origin", cache: "no-store" });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(res.ok ? "Live service unavailable on this server" : `HTTP ${res.status}`); }
    if (!res.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
    if (state.source === "LIVE") applyLive(L, body);
  } catch (err) {
    L.error = String(err?.message ?? err);
    if (L.enabled == null) L.enabled = false;
  } finally {
    L.busy = false;
    if (state.source === "LIVE") emit(true);
  }
}

async function postLive(resource, body) {
  try {
    const res = await fetch(`${API}?resource=${resource}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const r = await res.json().catch(() => ({}));
    state.live.notice = r.ok ? null : r.message ?? `Request failed (HTTP ${res.status})`;
  } catch (err) {
    state.live.notice = String(err?.message ?? err);
  }
  await pollLive();
}

/** Same key format Settings uses: preset id, or id@version for user versions. */
function liveConfigKey() {
  const c = state.live.engine.config;
  return c.immutable ? c.id : `${c.id}@${c.version}`;
}

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
    source: prefs.source === "SIMULATION" ? "SIMULATION" : "LIVE",
    live: newLive(),
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

function persist() { saveJson(PREFS_KEY, { seed: state.seed, configId: state.configId, speed: state.speed, source: state.source }); }

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
  if (state.source === "LIVE") {
    void pollLive();
    timer = setInterval(() => { void pollLive(); }, 1000);
    return;
  }
  if (!state.playing) return;
  const interval = state.speed <= 4 ? 1000 / state.speed : 250;
  const perTick = state.speed <= 4 ? 1 : Math.round(state.speed / 4);
  timer = setInterval(() => {
    const n = state.replay.advance(perTick);
    if (state.replay.done) { state.playing = false; clearInterval(timer); timer = null; }
    if (n || !state.playing) emit(state.speed <= 4);
  }, interval);
}

/** The active source, normalised: engine + clock + chain. */
function src() {
  if (state.source === "LIVE") {
    const L = state.live;
    const day = L.meta?.sessionDay ?? new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    return {
      engine: L.engine,
      now: L.serverNow ?? Date.now(),
      openMs: sessionOpenMs(day),
      closeMs: sessionCloseMs(day),
      done: false,
      marketOpen: !!L.meta?.market?.open,
      chain: () => L.chain,
    };
  }
  const r = state.replay;
  return { engine: r.engine, now: r.now, openMs: r.openMs, closeMs: r.closeMs, done: r.done, marketOpen: r.now >= r.openMs && r.now < r.closeMs, chain: () => r.chain() };
}

/** Derived, render-ready values. Arrays are shared references (not copied). */
function makeSnap() {
  const r = src();
  const e = r.engine;
  const live = state.source === "LIVE";
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
  const marketOpen = r.marketOpen;
  const riskStatus = e.killSwitch ? "KILL" : lossUsed >= cfg.maxDailyLoss ? "LIMIT" : tradesToday >= cfg.maxTradesPerDay ? "CAPPED" : "OK";
  return {
    v: state.version,
    mode: live ? "LIVE" : "SIMULATION",
    tag: live ? "LIVE" : "SIM",
    live: live ? { enabled: state.live.enabled, reason: state.live.reason, error: state.live.error, notice: state.live.notice, lastOkAt: state.live.lastOkAt, ...(state.live.meta ?? {}) } : null,
    seed: state.seed,
    date: live ? state.live.meta?.sessionDay ?? null : SIM_DATE,
    playing: state.playing,
    speed: state.speed,
    done: r.done,
    now: r.now,
    openMs: r.openMs,
    closeMs: r.closeMs,
    marketOpen,
    config: cfg,
    configs: allConfigs(),
    activeConfigId: live ? liveConfigKey() : state.configId,
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
  get engine() { init(); return src().engine; },
  get replay() { init(); return state.replay; },
  /** Current option chain; null in LIVE mode until instruments and prices are known. */
  chain() { init(); return src().chain(); },
  get source() { init(); return state.source; },
  setSource(m) {
    init();
    const next = m === "LIVE" ? "LIVE" : "SIMULATION";
    if (next === state.source) return;
    state.source = next;
    if (next === "LIVE") state.live = newLive();
    persist();
    schedule();
    emit(true);
  },
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
    if (state.source === "LIVE") {
      const cfg = configFor(configId);
      return postLive("config", cfg.immutable ? { configId: cfg.id } : { config: cfg });
    }
    state.configId = configId;
    persist();
    const at = state.replay.now;
    state.replay = buildReplay(state.seed, configId, at);
    emit(true);
  },
  startEngine() { if (state.source === "LIVE") return postLive("control", { action: "start" }); state.replay.engine.start(state.replay.now); emit(true); },
  stopEngine() { if (state.source === "LIVE") return postLive("control", { action: "stop" }); state.replay.engine.stop(state.replay.now); emit(true); },
  setKill(on) { if (state.source === "LIVE") return postLive("control", { action: on ? "kill" : "release" }); state.replay.engine.setKillSwitch(on, state.replay.now); emit(true); },
  flatten() { if (state.source === "LIVE") return postLive("control", { action: "flatten" }); state.replay.engine.flatten(state.replay.now); emit(true); },
  /** Closed live paper trades across all stored sessions (needs the Phase 4 migration). */
  async liveHistory() {
    const res = await fetch(`${API}?resource=history`, { credentials: "same-origin", cache: "no-store" });
    const body = await res.json();
    return { trades: body.trades ?? [], store: body.store ?? null, enabled: !!body.enabled };
  },
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
  activeConfigId() { return state.source === "LIVE" ? liveConfigKey() : state.configId; },
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
