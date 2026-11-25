/**
 * GET /api/kite-status — is the Kite login valid? (behind middleware.ts login)
 * Returns { ok, checkedAt, obtainedAt, alert, message }; never the token.
 */
import { kiteLoginStatus } from '../server/kiteLogin.ts';

interface Req { method?: string }
interface Res { status(n: number): Res; json(b: unknown): void; setHeader(k: string, v: string): void }

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  try { res.status(200).json(await kiteLoginStatus()); }
  catch { res.status(200).json({ ok: null, checkedAt: null, obtainedAt: null, alert: false, message: null }); }
}
