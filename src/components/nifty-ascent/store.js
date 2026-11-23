/**
 * NIFTY ASCENT browser store — Phase 2: deterministic SIMULATION replay only.
 * Every number on screen comes from the real strategy engine running over a
 * synthetic fixture; nothing here talks to Kite or the server.
 */
import { useSyncExternalStore } from "react";
import { FIXTURES } from "../../nifty-ascent/sim/fixtures.ts";
import { Replay } from "../../nifty-ascent/sim/market.ts";
import { DEFAULT_EXECUTION, barStart } from "../../nifty-ascent/core/rules.ts";
import { AscentEngine } from "../../nifty-ascent/core/engine.ts";

export const SPEEDS = [1, 10, 60, 300];
const listeners = new Set();
const PREF = "nifty-ascent-prefs";

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF) || "{}"); } catch { return {}; }
}
function savePrefs(p) { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch { /* ignore */ } }

const prefs = loadPrefs();
const initialFixture = FIXTURES.some((f) => f.id === prefs.fixtureId) ? prefs.fixtureId : FIXTURES[0].id;

export const S = {
  version: 0,
  fixtureId: initialFixture,
  replay: null,
  playing: false,
  speed: SPEEDS.includes(prefs.speed) ? prefs.speed : 60,
  exec: { ...DEFAULT_EXECUTION },
  execVersion: 1,
  overlays: { or: true, bands: true, prev: true, williams: true, markers: true, ...(prefs.overlays ?? {}) },
  runs: null,
  /** Live server status (observe-only service). Read-only; null until the first poll. */
  live: null,
  /** SIMULATION (replay in this browser) or LIVE (read-only mirror of the server engine). Never mixed. */
  source: prefs.source === "LIVE" ? "LIVE" : "SIMULATION",
  mirror: null,
  mirrorError: null,
  liveHistory: null,
};

/** The engine and clock the workspaces display: the replay, or the read-only live mirror. */
export function view(s = S) {
  if (s.source === "LIVE") return { live: true, engine: s.mirror, now: s.live?.serverTime ?? Date.now() };
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
const hmToMs = (hm) => { const [h, m] = hm.split(":").map(Number); return barStart(fixture().date, h * 60 + m); };

function load(jump) {
  S.replay = new Replay(fixture(), { exec: S.exec, startRunning: true });
  if (jump) S.replay.stepTo(hmToMs(jump));
}

let raf = 0, lastT = 0;
function loop(t) {
  raf = 0;
  if (!S.playing || !S.replay) return;
  const dt = lastT ? Math.min(250, t - lastT) : 16;
  lastT = t;
  S.replay.stepTo(S.replay.t + dt * S.speed);
  if (S.replay.done) S.playing = false;
  emit();
  if (S.playing) raf = requestAnimationFrame(loop);
}

/** Every fixture run to the end with the current execution settings (Journal / Analytics). */
function computeRuns() {
  S.runs = { execVersion: S.execVersion, list: FIXTURES.map((f) => ({ fixture: f, engine: new Replay(f, { exec: S.exec }).runToEnd() })) };
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
  toEnd() { S.playing = false; S.replay.runToEnd(); emit(true); },
  control(action) { S.replay.engine.control(action, S.replay.t); emit(true); },
  setOverlay(k, v) { S.overlays = { ...S.overlays, [k]: v }; savePrefs({ ...loadPrefs(), overlays: S.overlays }); emit(true); },
  setExec(patch) {
    S.exec = { ...S.exec, ...patch, version: `EXEC-${S.execVersion + 1}` };
    S.execVersion++;
    const t = S.replay.t;
    load(); S.replay.stepTo(t);
    S.runs = null;
    emit(true);
  },
  resetExec() { S.exec = { ...DEFAULT_EXECUTION }; S.execVersion++; const t = S.replay.t; load(); S.replay.stepTo(t); S.runs = null; emit(true); },
  runs() {
    if (!S.runs || S.runs.execVersion !== S.execVersion) computeRuns();
    return S.runs.list;
  },
  fixture,
  setSource(src) {
    S.source = src === "LIVE" ? "LIVE" : "SIMULATION";
    if (S.source === "LIVE") S.playing = false;
    savePrefs({ ...loadPrefs(), source: S.source });
    if (livePoll) { pollLive(); schedule(); }
    emit(true);
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
