/**
 * LIVE ORDERS API (self-hosted server only; behind middleware.ts login).
 *
 *   GET  ?resource=status[&reconcile=1]   server switch, arm state, limits, today's and recent real positions
 *                                          (reconcile=1 also compares our open records with Zerodha's net quantity)
 *   POST ?resource=arm       { strategy, armed: boolean, confirm?: 'ARM LIVE' }   arming needs the phrase
 *   POST ?resource=settings  { strategy, settings: {...} }                          live limits (validated)
 *   POST ?resource=flatten   { strategy }   close real positions now AND disarm
 *
 * strategy = NIFTY_ASCENT | NAKED_SELL. Nothing is ever armed automatically. No credentials are returned.
 */
import { getLive, liveEnabled } from '../server/liveOrders/index.ts';
import { liveOrdersOn } from '../server/liveOrders/kiteBroker.ts';
import { ARM_PHRASE, LIVE_SETTINGS_SPEC, validateLiveSettings } from '../src/live-orders/control.ts';
import { expectedNet, type Strategy } from '../src/live-orders/runner.ts';
import { getNiftyAscent } from '../server/niftyAscent.ts';

interface Req { method?: string; query: Record<string, unknown>; body?: any }
interface Res { status(n: number): Res; json(b: unknown): void; setHeader(k: string, v: string): void }
const STRATS: Strategy[] = ['NIFTY_ASCENT', 'NAKED_SELL'];
const istDate = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store');
  const resource = String(req.query.resource ?? 'status');
  const live = getLive();
  if (!live) { res.status(req.method === 'GET' ? 200 : 409).json({ configured: false, serverSwitch: liveOrdersOn(), message: 'live order service not configured on this server' }); return; }
  try {
    if (req.method === 'GET' && resource === 'status') {
      const out: Record<string, unknown> = {};
      for (const s of STRATS) {
        const control = await live.refresh(s);
        const [today, recent] = await Promise.all([live.store.forDate(s, istDate()), live.store.recent(s, 50)]);
        let reconcile: unknown = null;
        if (req.query.reconcile === '1') {
          const exp = expectedNet(await live.store.active(s));
          reconcile = await Promise.all([...exp.values()].map(async (x) => {
            const broker = await live.broker.netQty(x.exchange, x.tradingsymbol).catch(() => null);
            return { ...x, broker, match: broker === x.qty };
          }));
        }
        out[s] = { control, spec: LIVE_SETTINGS_SPEC[s], today, recent, reconcile };
      }
      const asc = getNiftyAscent().liveMirror;
      res.status(200).json({ configured: true, serverSwitch: liveOrdersOn(), enabled: liveEnabled(), migration: live.store.migration, armPhrase: ARM_PHRASE, ascentMirror: asc ? { attemptedToday: asc.attempted, lastSkip: asc.lastSkip } : null, strategies: out });
      return;
    }
    if (req.method !== 'POST') { res.status(404).json({ error: 'not_found' }); return; }
    const strategy = String(req.body?.strategy ?? '') as Strategy;
    if (!STRATS.includes(strategy)) { res.status(400).json({ ok: false, message: 'strategy must be NIFTY_ASCENT or NAKED_SELL' }); return; }

    if (resource === 'arm') {
      const armed = req.body?.armed;
      if (typeof armed !== 'boolean') { res.status(400).json({ ok: false, message: 'armed must be true or false' }); return; }
      if (armed) {
        if (!liveOrdersOn()) { res.status(409).json({ ok: false, message: 'the server switch LIVE_ORDERS is off — real orders cannot be armed' }); return; }
        if (req.body?.confirm !== ARM_PHRASE) { res.status(400).json({ ok: false, message: `type "${ARM_PHRASE}" to arm real orders` }); return; }
        if (strategy === 'NIFTY_ASCENT' && !getNiftyAscent().liveMirror) { res.status(409).json({ ok: false, message: 'NIFTY ASCENT live paper is not running on this server (NIFTY_ASCENT=paper needed)' }); return; }
      }
      const c = await live.control.save(strategy, { armed, armedAt: armed ? new Date().toISOString() : null });
      await live.refresh(strategy);
      console.log(`[live-orders] ${strategy} ${armed ? 'ARMED — real orders enabled' : 'disarmed'}`);
      res.status(200).json({ ok: true, control: c, message: armed ? `${strategy} LIVE armed — real orders will be sent on the next signal` : `${strategy} LIVE disarmed — no new real entries (an open real position is still managed)` });
      return;
    }
    if (resource === 'settings') {
      const cur = await live.refresh(strategy);
      const v = validateLiveSettings(strategy, req.body?.settings, cur.settings);
      if (!v.ok) { res.status(400).json(v); return; }
      const c = await live.control.save(strategy, { settings: v.value });
      await live.refresh(strategy);
      console.log(`[live-orders] ${strategy} live settings saved ${JSON.stringify(v.value)}`);
      res.status(200).json({ ok: true, control: c });
      return;
    }
    if (resource === 'flatten') {
      await live.control.save(strategy, { armed: false, armedAt: null });
      await live.refresh(strategy);
      let message: string;
      if (strategy === 'NIFTY_ASCENT') {
        const { liveMirror, service } = getNiftyAscent();
        message = liveMirror ? await liveMirror.flatten(service?.engine ?? null) : 'NIFTY ASCENT live mirror is not running';
      } else {
        const ns = await import('./naked-sell.ts');
        message = await ns.flattenLive(ns.makeClient());
      }
      console.log(`[live-orders] ${strategy} FLATTEN LIVE: ${message}`);
      res.status(200).json({ ok: true, message: `disarmed · ${message}` });
      return;
    }
    res.status(404).json({ error: 'not_found' });
  } catch (err: any) {
    console.error('live-orders api failed:', err?.message);
    res.status(500).json({ ok: false, message: String(err?.message ?? 'failed').slice(0, 200) });
  }
}
