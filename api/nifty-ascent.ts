/**
 * NIFTY ASCENT API (self-hosted server only; behind middleware.ts login).
 *
 *   GET  ?resource=status      live service status (read-only)
 *   GET  ?resource=snapshot    engine snapshot for the LIVE view (read-only)
 *   GET  ?resource=history     filled LIVE PAPER trades (read-only)
 *   POST ?resource=control     { action: START | STOP_ENTRIES | KILL | RELEASE }
 *   POST ?resource=auto-start  { enabled: boolean }
 *
 * PAPER ONLY. Controls only change the paper engine's state; there is no
 * broker or order code behind any endpoint, and in observe mode every
 * control is refused (LIVE PAPER — NOT ENABLED). No credentials are returned.
 */
import { getNiftyAscent } from '../server/niftyAscent.ts';
import type { ControlAction } from '../src/nifty-ascent/live/service.ts';

interface Req { method?: string; query: Record<string, unknown>; body?: any }
interface Res { status(n: number): Res; json(b: unknown): void; setHeader(k: string, v: string): void }
const ACTIONS = new Set<ControlAction>(['START', 'STOP_ENTRIES', 'KILL', 'RELEASE']);

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store');
  const resource = String(req.query.resource ?? 'status');
  const { service, archive, store } = getNiftyAscent();
  if (!service) {
    if (req.method === 'GET' && (resource === 'status' || resource === 'snapshot')) {
      res.status(200).json({ enabled: false, livePaper: 'NOT_ENABLED', reason: process.env.NIFTY_ASCENT ? 'starting or not configured' : 'NIFTY ASCENT live service is not enabled on this server' });
      return;
    }
    if (req.method === 'POST') { res.status(409).json({ ok: false, message: 'LIVE PAPER — NOT ENABLED' }); return; }
    res.status(404).json({ error: 'not_found' });
    return;
  }
  try {
    if (req.method === 'GET' && resource === 'status') { res.status(200).json(status(service, archive)); return; }
    if (req.method === 'GET' && resource === 'snapshot') { res.status(200).json({ ...status(service, archive), mirror: mirror(service) }); return; }
    if (req.method === 'GET' && resource === 'history') {
      if (!store) { res.status(200).json({ enabled: true, trades: [], reason: 'observe mode — no live paper trades' }); return; }
      res.status(200).json({ enabled: true, trades: await store.history(Math.min(Number(req.query.limit) || 500, 2000)) });
      return;
    }
    if (req.method === 'POST' && resource === 'control') {
      const action = String(req.body?.action ?? '') as ControlAction;
      if (!ACTIONS.has(action)) { res.status(400).json({ error: 'bad_action' }); return; }
      const r = await service.control(action);
      console.log(`[nifty-ascent] control ${action}: ${r.message}`);
      res.status(r.ok ? 200 : 409).json(r);
      return;
    }
    if (req.method === 'POST' && resource === 'auto-start') {
      if (typeof req.body?.enabled !== 'boolean') { res.status(400).json({ error: 'enabled must be boolean' }); return; }
      const r = await service.setAutoStart(req.body.enabled);
      res.status(r.ok ? 200 : 409).json(r);
      return;
    }
    res.status(404).json({ error: 'not_found' });
  } catch (err: any) {
    console.error('nifty-ascent api failed:', err?.message);
    res.status(500).json({ error: 'internal_error' });
  }
}

type Svc = NonNullable<ReturnType<typeof getNiftyAscent>['service']>;

function status(service: Svc, archive: ReturnType<typeof getNiftyAscent>['archive']) {
  const s = service.snapshot();
  const st = (s.stream ?? {}) as Record<string, unknown>;
  const livePaper = s.mode !== 'PAPER' ? 'NOT_ENABLED' : s.engine?.engineStatus === 'RUNNING' ? 'RUNNING' : 'READY_PAUSED';
  return {
    enabled: true, mode: s.mode, livePaper, date: s.date, serverTime: Date.now(), paper: s.paper,
    stream: { connected: st.connected ?? null, subscribed: st.subscribed ?? null, wanted: st.wanted ?? null, lastMessageAgoMs: st.lastMessageAgoMs ?? null, reconnects: st.reconnects ?? null },
    prep: s.prep ? { prevDate: s.prep.prev?.date ?? null, prevBars: s.prep.prev?.bars ?? null, prevClose1515: s.prep.prev?.close1515 ?? null, contracts: s.prep.instruments?.valid ?? null, expiries: s.prep.instruments?.expiries ?? null, errors: s.prep.errors } : null,
    engine: s.engine ? {
      state: s.engine.state, engineStatus: s.engine.engineStatus, outcome: s.engine.outcome, reference: s.engine.reference?.price ?? null,
      gap: s.engine.gap, orCollected: s.engine.orCollected, or: s.engine.or, gapFill: s.engine.gapFill, standDown: s.engine.standDown,
      williams: s.engine.williams, williamsEligible: s.engine.williamsEligible, handover: s.engine.handover, signal: s.engine.signal,
      positionsToday: s.engine.positionsToday, trade: s.engine.trade,
      wouldSelect: s.engine.wouldSelect && (s.engine.wouldSelect.ok ? { ok: true, tradingsymbol: s.engine.wouldSelect.instrument.tradingsymbol, strike: s.engine.wouldSelect.strike, expiry: s.engine.wouldSelect.expiry } : { ok: false, code: s.engine.wouldSelect.code }),
    } : null,
    bars: s.bars, presubscribed: s.presubscribed, tradeDetection: s.tradeDetection, archive: archive?.status() ?? null,
  };
}

/** Everything the browser needs to rebuild a READ-ONLY copy of the live engine for display. */
function mirror(service: Svc) {
  const e = service.engine;
  if (!e) return null;
  const toks = new Set<number>([...e.wantedTokens(), ...service.presubscribed]);
  if (e.trade) { const t = e.instruments.find((i) => i.tradingsymbol === e.trade!.tradingsymbol); if (t) toks.add(t.token); }
  if (e.entryOrder) toks.add(e.entryOrder.token);
  return {
    snapshot: e.serialize(), exec: e.exec, prev: e.prev,
    instruments: e.instruments.filter((i) => toks.has(i.token)),
    quotes: [...toks].map((t) => e.lastQuote.get(t)).filter(Boolean),
    events: e.events.slice(-300),
  };
}
