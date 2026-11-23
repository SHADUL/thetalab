/**
 * NIFTY ASCENT browser store — Phase 2: deterministic SIMULATION replay only.
 * Every number on screen comes from the real strategy engine running over a
 * synthetic fixture; nothing here talks to Kite or the server.
 */
import { useSyncExternalStore } from "react";
import { FIXTURES } from "../../nifty-ascent/sim/fixtures.ts";
import { Replay } from "../../nifty-ascent/sim/market.ts";
import { DEFAULT_EXECUTION, barStart } from "../../nifty-ascent/core/rules.ts";

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
};

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
};

load(prefs.fixtureId ? "09:14" : "11:45");

export function useAscent() {
  useSyncExternalStore(ascent.subscribe, () => S.version, () => S.version);
  return S;
}
