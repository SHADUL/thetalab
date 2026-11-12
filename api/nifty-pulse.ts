/**
 * NIFTY PULSE live paper API (self-hosted server only; behind middleware.ts).
 *
 *   GET  ?resource=snapshot&sid=&s=&e=&d=&tc=&c=  incremental engine state
 *   GET  ?resource=history                          closed live paper trades (all sessions)
 *   POST ?resource=control  { action: start|stop|kill|release|flatten }
 *   POST ?resource=config   { configId } | { config }
 *
 * Paper only: there is no broker or order code behind any of these. No
 * credentials are ever included in a response.
 */
import { getNiftyPulse } from '../server/niftyPulse.ts';
import type { ControlAction } from '../src/nifty-pulse/live/service.ts';

interface Req { method?: string; query: Record<string, unknown>; body?: any }
interface Res { status(n: number): Res; json(b: unknown): void; setHeader(k: string, v: string): void }

const ACTIONS = new Set<ControlAction>(['start', 'stop', 'kill', 'release', 'flatten']);
const num = (v: unknown) => (v == null || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store');
  const resource = String(req.query.resource ?? 'snapshot');
  const { service, store, disabledReason } = getNiftyPulse();
  if (!service) {
    res.status(200).json({ enabled: false, reason: disabledReason ?? 'not running' });
    return;
  }
  try {
    if (req.method === 'GET' && resource === 'snapshot') {
      const q = req.query;
      res.status(200).json({ enabled: true, ...service.snapshot({ sid: typeof q.sid === 'string' ? q.sid : undefined, s: num(q.s), e: num(q.e), d: num(q.d), tc: num(q.tc), c: num(q.c) }) });
      return;
    }
    if (req.method === 'GET' && resource === 'history') {
      res.status(200).json({ enabled: true, trades: store ? await store.history(Math.min(Number(req.query.limit) || 500, 2000)) : [], store: store?.status() ?? { enabled: false } });
      return;
    }
    if (req.method === 'POST' && resource === 'control') {
      const action = String(req.body?.action ?? '') as ControlAction;
      if (!ACTIONS.has(action)) { res.status(400).json({ error: 'bad_action' }); return; }
      const r = service.control(action);
      res.status(r.ok ? 200 : 409).json(r);
      return;
    }
    if (req.method === 'POST' && resource === 'config') {
      const r = service.setConfig({ configId: typeof req.body?.configId === 'string' ? req.body.configId : undefined, config: req.body?.config });
      res.status(r.ok ? 200 : 409).json(r);
      return;
    }
    res.status(404).json({ error: 'not_found' });
  } catch (err: any) {
    console.error('nifty-pulse failed:', err?.message);
    res.status(500).json({ error: 'internal_error' });
  }
}
