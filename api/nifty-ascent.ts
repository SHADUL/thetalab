/**
 * NIFTY ASCENT API (self-hosted server only; behind middleware.ts login).
 *
 *   GET ?resource=status   live observe-only service status (read-only)
 *
 * Observe only: live paper execution is NOT enabled; there is no control,
 * broker or order code behind this endpoint. No credentials are returned.
 */
import { getNiftyAscent } from '../server/niftyAscent.ts';

interface Req { method?: string; query: Record<string, unknown> }
interface Res { status(n: number): Res; json(b: unknown): void; setHeader(k: string, v: string): void }

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store');
  const resource = String(req.query.resource ?? 'status');
  if (req.method !== 'GET' || resource !== 'status') { res.status(404).json({ error: 'not_found' }); return; }
  const { service, archive } = getNiftyAscent();
  if (!service) {
    res.status(200).json({ enabled: false, livePaper: 'NOT_ENABLED', reason: process.env.NIFTY_ASCENT === 'observe' ? 'starting or not configured' : 'NIFTY_ASCENT observe mode is not enabled on this server' });
    return;
  }
  try {
    const s = service.snapshot();
    const st = (s.stream ?? {}) as Record<string, unknown>;
    res.status(200).json({
      enabled: true, mode: s.mode, livePaper: 'NOT_ENABLED', date: s.date, serverTime: Date.now(),
      stream: { connected: st.connected ?? null, subscribed: st.subscribed ?? null, wanted: st.wanted ?? null, lastMessageAgoMs: st.lastMessageAgoMs ?? null, reconnects: st.reconnects ?? null },
      prep: s.prep ? { prevDate: s.prep.prev?.date ?? null, prevBars: s.prep.prev?.bars ?? null, prevClose1515: s.prep.prev?.close1515 ?? null, contracts: s.prep.instruments?.valid ?? null, expiries: s.prep.instruments?.expiries ?? null, errors: s.prep.errors } : null,
      engine: s.engine ? {
        state: s.engine.state, engineStatus: s.engine.engineStatus, outcome: s.engine.outcome, reference: s.engine.reference?.price ?? null,
        gap: s.engine.gap, orCollected: s.engine.orCollected, or: s.engine.or, gapFill: s.engine.gapFill, standDown: s.engine.standDown,
        williams: s.engine.williams, williamsEligible: s.engine.williamsEligible, handover: s.engine.handover, signal: s.engine.signal,
        wouldSelect: s.engine.wouldSelect && (s.engine.wouldSelect.ok ? { ok: true, tradingsymbol: s.engine.wouldSelect.instrument.tradingsymbol, strike: s.engine.wouldSelect.strike, expiry: s.engine.wouldSelect.expiry } : { ok: false, code: s.engine.wouldSelect.code }),
      } : null,
      bars: s.bars, presubscribed: s.presubscribed, tradeDetection: s.tradeDetection,
      archive: archive?.status() ?? null,
    });
  } catch (err: any) {
    console.error('nifty-ascent status failed:', err?.message);
    res.status(500).json({ error: 'internal_error' });
  }
}
