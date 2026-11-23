/**
 * NIFTY ASCENT browser store — Phase 2: deterministic SIMULATION replay only.
 * Every number on screen comes from the real strategy engine running over a
 * synthetic fixture; nothing here talks to Kite or the server.
 */
import { useSyncExternalStore } from "react";
import { FIXTURES } from "../../nifty-ascent/sim/fixtures.ts";
import { Replay } from "../../nifty-ascent/sim/market.ts";
import { histReplay } from "../../nifty-ascent/sim/historical.ts";
import { DEFAULT_EXECUTION, LIVE_PAPER_EXECUTION, barStart } from "../../nifty-ascent/core/rules.ts";
import { AscentEngine } from "../../nifty-ascent/core/engine.ts";

export const SPEEDS = [1, 10, 60, 300];
const listeners = new Set();
const PREF = "nifty-ascent-prefs";

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF) || "{}"); } catch { return {}; }
}
function savePrefs(p) { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* ignore */ } }

const prefs = loadPrefs();
/** Default execution settings per source: BACKTEST mirrors live paper (EXEC-2, ₹20,000); SIMULATION keeps EXEC-1 (₹15,000). */
export const defaultExec = (src) => ({ ...(src === "BACKTEST" ? LIVE_PAPER_EXECUTION : DEFAULT_EXECUTION) });
const initialSource = ["LIVE", "BACKTEST"].includes(prefs.source) ? prefs.source : "SIMULATION";
const initialFixture = FIXTURES.some((f) => f.id === prefs.fixtureId) ? prefs.fixtureId : FIXTURES[0].id;

export const S = {
  version: 0,
  fixtureId: initialFixture,
  replay: null,
  playing: false,
  speed: SPEEDS.includes(prefs.speed) ? prefs.speed : 60,
  /** Settings of the source on screen (SIMULATION or BACKTEST). Each source keeps its own copy. */
  exec: defaultExec(initialSource),
  execBySource: {},
  execVersion: 1,
  overlays: { or: true, bands: true, prev: true, williams: true, markers: true, ...(prefs.overlays ?? {}) },
  runs: null,
  /** Live server status (observe-only service). Read-only; null until the first poll. */
  live: null,
  /** SIMULATION (replay in this browser) or LIVE (read-only mirror of the server engine). Never mixed. */
  source: initialSource,
  /** BACKTEST: real NIFTY 1-minute data (Kite) with MODELLED option prices. Never mixed with sim or live. */
  bt: { month: null, days: [], daysError: null, loadingDays: false, date: null, data: null, loading: false, error: null, results: {}, running: false, progress: null },
  mirror: null,
  mirrorError: null,
  liveHistory: null,
};

/** The engine and clock the workspaces display: the replay, or the read-only live mirror. */
export function view(s = S) {
  if (s.source === "LIVE") return { live: true, engine: s.mirror, now: s.live?.serverTime ?? Date.now() };
  if (s.source === "BACKTEST") return { live: false, backtest: true, engine: s.bt.data ? s.replay.engine : null, now: s.replay.t };
  return { live: false, engine: s.replay.engine, now: s.replay.t };
}

let lastEmit = 0, pendingEmit = false;
function emit(force = false) {
  const now = performance.now();
  if (!force && now - lastEmit < 110) {
    if (!pendingEmit) { pendingEmit = true; setTimeout(() => { pendingEmit = false; emit(true); }, 110); }
    return;
  }
  lastEmit = now;
  S.version++;
  for (const l of listeners) l();
}

const fixture = () => FIXTURES.find((f) => f.id === S.fixtureId);
const hmToMs = (hm) => { const [h, m] = hm.split(":").map(Number); return barStart(S.replay?.sc.date ?? fixture().date, h * 60 + m); };

/** The replay being shown: a real historical day in BACKTEST (when loaded), otherwise the synthetic fixture. */
function factory() {
  if (S.source === "BACKTEST" && S.bt.data) return histReplay(S.bt.data, { exec: S.exec, startRunning: true });
  return new Replay(fixture(), { exec: S.exec, startRunning: true });
}
function load(jump) {
  S.replay = factory();
  if (jump) S.replay.stepTo(hmToMs(jump));
}

async function getJson(url) {
  const r = await fetch(url, { credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || `HTTP ${r.status}`);
  return j;
}
/** Execution settings used for BACKTEST runs, whichever source is on screen. */
export const btExec = () => (S.source === "BACKTEST" ? S.exec : S.execBySource.BACKTEST ?? defaultExec("BACKTEST"));
function histDay(h) {
  if (h?.kind !== "NIFTY_ASCENT_HIST_DAY" || !Array.isArray(h.bars)) throw new Error("the server did not return backtest data for this day");
  return h;
}
/** Compact per-day backtest result (the engine is kept for analytics). */
function summarise(e) {
  return {
    engine: e, outcome: e.outcome, gap: e.gap ? { pct: e.gap.pct, dir: e.gap.direction, pts: e.gap.points } : null,
    standDown: e.standDown?.reason ?? null, handover: !!e.handover, signal: e.signal ? { bot: e.signal.bot, right: e.signal.right, bar: e.signal.bar } : null,
    trade: e.trade, rejected: e.entryOrder?.status === "REJECTED" ? e.entryOrder.rejectReason : null,
  };
}

let raf = 0, lastT = 0;
function loop(t) {
  raf = 0;
  if (!S.playing || !S.replay) return;
  const dt = lastT ? Math.min(250, t - lastT) : 16;
  lastT = t;
  S.replay.stepTo(S.replay.t + dt * S.speed);
  if (S.replay.done) { S.playing = false; ascent.btRecordCurrent(); }
  emit();
  if (S.playing) raf = requestAnimationFrame(loop);
}

/** Every fixture run to the end with the current execution settings (Journal / Analytics). */
function computeRuns() {
  const exec = S.source === "SIMULATION" ? S.exec : S.execBySource.SIMULATION ?? defaultExec("SIMULATION");
  S.runs = { execVersion: S.execVersion, list: FIXTURES.map((f) => ({ fixture: f, engine: new Replay(f, { exec }).runToEnd() })) };
}

export const ascent = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  select(id, jump = "09:14") {
    S.fixtureId = id; S.playing = false; load(jump);
    savePrefs({ ...loadPrefs(), fixtureId: id });
    emit(true);
  },
  play() {
    if (!S.replay || S.replay.done) return;
    S.playing = true; lastT = 0;
    if (!raf) raf = requestAnimationFrame(loop);
    emit(true);
  },
  pause() { S.playing = false; emit(true); },
  setSpeed(x) { S.speed = x; savePrefs({ ...loadPrefs(), speed: x }); emit(true); },
  jumpTo(hm) {
    const ms = hmToMs(hm);
    if (ms < S.replay.t) load();
    S.replay.stepTo(ms);
    emit(true);
  },
  restart() { S.playing = false; load(); emit(true); },
  toEnd() { S.playing = false; S.replay.runToEnd(); ascent.btRecordCurrent(); emit(true); },
  control(action) { S.replay.engine.control(action, S.replay.t); emit(true); },
  setOverlay(k, v) { S.overlays = { ...S.overlays, [k]: v }; savePrefs({ ...loadPrefs(), overlays: S.overlays }); emit(true); },
  setExec(patch) {
    S.exec = { ...S.exec, ...patch, version: `${defaultExec(S.source).version}-custom${S.execVersion}` };
    S.execVersion++;
    const t = S.replay.t;
    load(); S.replay.stepTo(t);
    S.runs = null; S.bt.results = {};
    emit(true);
  },
  resetExec() { S.exec = defaultExec(S.source); S.execVersion++; const t = S.replay.t; load(); S.replay.stepTo(t); S.runs = null; S.bt.results = {}; emit(true); },
  runs() {
    if (!S.runs || S.runs.execVersion !== S.execVersion) computeRuns();
    return S.runs.list;
  },
  fixture,
  setSource(src) {
    const prev = S.source;
    S.source = ["LIVE", "BACKTEST"].includes(src) ? src : "SIMULATION";
    S.playing = false;
    if (prev !== "LIVE") S.execBySource[prev] = S.exec;
    if (S.source !== "LIVE" && prev !== S.source) { S.exec = S.execBySource[S.source] ?? defaultExec(S.source); S.execVersion++; S.runs = null; }
    if (prev !== S.source && S.source !== "LIVE") load("09:14");
    if (S.source === "BACKTEST" && !S.bt.month) ascent.btLoadMonth(lastMonths()[0]);
    savePrefs({ ...loadPrefs(), source: S.source });
    if (livePoll) { pollLive(); schedule(); }
    emit(true);
  },
  /* ---------------- BACKTEST (real data, modelled options) ---------------- */
  async btLoadMonth(month) {
    S.bt = { ...S.bt, month, days: [], daysError: null, loadingDays: true };
    emit(true);
    try {
      const days = (await getJson(`/api/nifty-ascent?resource=hist-days&month=${month}`)).days;
      if (!Array.isArray(days)) throw new Error("the server did not return a day list (is the backtest API available?)");
      S.bt.days = days;
    }
    catch (e) { S.bt.daysError = e.message; }
    S.bt.loadingDays = false;
    emit(true);
  },
  async btOpenDay(date, jump = "09:14") {
    S.bt = { ...S.bt, date, loading: true, error: null };
    S.playing = false;
    emit(true);
    try {
      S.bt.data = histDay(await getJson(`/api/nifty-ascent?resource=hist-day&date=${date}`));
      const d = S.bt.days.find((x) => x.date === date); if (d) d.cached = true;
      load(jump);
    } catch (e) { S.bt.error = e.message; S.bt.data = null; }
    S.bt.loading = false;
    emit(true);
  },
  /** Run every day of the loaded month to the end (sequentially; data cached on the server after the first fetch). */
  async btRunAll() {
    if (S.bt.running) return;
    S.bt.running = true;
    const days = S.bt.days.map((d) => d.date);
    for (let i = 0; i < days.length; i++) {
      if (!S.bt.running) break;
      const date = days[i];
      S.bt.progress = { i: i + 1, n: days.length, date };
      emit(true);
      try {
        const h = histDay(await getJson(`/api/nifty-ascent?resource=hist-day&date=${date}`));
        const d = S.bt.days.find((x) => x.date === date); if (d) d.cached = true;
        S.bt.results = { ...S.bt.results, [date]: summarise(histReplay(h, { exec: btExec(), startRunning: true }).runToEnd()) };
      } catch (e) {
        S.bt.results = { ...S.bt.results, [date]: { error: e.message } };
      }
      emit(true);
      await new Promise((r) => setTimeout(r, 0));
    }
    S.bt.running = false; S.bt.progress = null;
    emit(true);
  },
  btStop() { S.bt.running = false; emit(true); },
  btRecordCurrent() {
    if (S.source === "BACKTEST" && S.bt.data && S.replay.done) { S.bt.results = { ...S.bt.results, [S.bt.date]: summarise(S.replay.engine) }; emit(true); }
  },
  liveControl: (action) => post("control", { action }),
  setAutoStart: (enabled) => post("auto-start", { enabled }),
  async loadLiveHistory() {
    try {
      const r = await fetch("/api/nifty-ascent?resource=history", { credentials: "same-origin" });
      S.liveHistory = r.ok ? await r.json() : { trades: [], reason: `HTTP ${r.status}` };
    } catch (e) { S.liveHistory = { trades: [], reason: e.message }; }
    emit(true);
  },
};

load(prefs.fixtureId ? "09:14" : "11:45");

/* Live server status — polled every 10 s while the section is open. Never used as replay data. */
let livePoll = 0;
/** Rebuilds a READ-ONLY engine copy from the server snapshot (same restore code as server recovery). */
function buildMirror(m, serverTime) {
  if (!m) { S.mirror = null; return; }
  try {
    const e = AscentEngine.restore({ date: m.snapshot.date, prev: m.prev, instruments: m.instruments, exec: m.exec, startRunning: false }, m.snapshot, serverTime);
    e.events.splice(0, e.events.length, ...m.events);
    for (const q of m.quotes) e.lastQuote.set(q.token, q);
    S.mirror = e; S.mirrorError = null;
  } catch (err) { S.mirror = null; S.mirrorError = err.message; }
}
let pollBusy = false;
async function pollLive() {
  if (pollBusy) return;
  pollBusy = true;
  const res = S.source === "LIVE" ? "snapshot" : "status";
  try {
    const r = await fetch(`/api/nifty-ascent?resource=${res}`, { credentials: "same-origin" });
    const j = r.ok ? await r.json() : null;
    S.live = j ? { ...j, fetchedAt: Date.now() } : { enabled: false, livePaper: "NOT_ENABLED", reason: `status ${r.status}`, error: true, fetchedAt: Date.now() };
    if (res === "snapshot") buildMirror(j?.mirror ?? null, j?.serverTime ?? Date.now());
  } catch {
    S.live = { enabled: false, livePaper: "NOT_ENABLED", reason: "status unavailable", error: true, fetchedAt: Date.now() };
  } finally { pollBusy = false; }
  emit(true);
}
function schedule() {
  clearInterval(livePoll);
  livePoll = setInterval(pollLive, S.source === "LIVE" ? 3_000 : 10_000);
}
export function startLivePolling() {
  if (livePoll) return () => {};
  pollLive(); schedule();
  return () => { clearInterval(livePoll); livePoll = 0; };
}
async function post(resource, body) {
  try {
    const r = await fetch(`/api/nifty-ascent?resource=${resource}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    await pollLive();
    return { ok: r.ok && j.ok !== false, message: j.message ?? j.error ?? `HTTP ${r.status}` };
  } catch (e) { return { ok: false, message: e.message }; }
}

export function useAscent() {
  useSyncExternalStore(ascent.subscribe, () => S.version, () => S.version);
  return S;
}

/** The current IST month and the five before it (YYYY-MM), newest first. */
export function lastMonths(n = 6) {
  const d = new Date(Date.now() + 330 * 60_000);
  const out = [];
  for (let i = 0; i < n; i++) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); out.push(x.toISOString().slice(0, 7)); }
  return out;
}
