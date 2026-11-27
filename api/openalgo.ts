/**
 * GET /api/openalgo — is the separately installed OpenAlgo up, and has its
 * first-time setup been done? (behind middleware.ts login)
 *
 * OpenAlgo (github.com/marketcalls/openalgo, AGPL-3.0) runs unmodified in its
 * own container (/opt/openalgo on the server). ThetaLab only links to it and
 * reads its public /auth/check-setup endpoint; it never sends orders through
 * it and never handles OpenAlgo or broker credentials.
 */
interface Req { method?: string }
interface Res { status(n: number): Res; json(b: unknown): void; setHeader(k: string, v: string): void }

export interface OpenAlgoView { up: boolean; needsSetup: boolean | null; url: string; checkedAt: number; error: string | null }

const INTERNAL = process.env.OPENALGO_INTERNAL_URL ?? 'http://openalgo-web:5000';
const PUBLIC = process.env.OPENALGO_PUBLIC_URL ?? 'https://openalgo.130-210-19-135.sslip.io';
const CACHE_MS = 15_000;
let last: OpenAlgoView | null = null;

export async function openAlgoStatus(nowMs = Date.now(), fetchFn: typeof fetch = fetch): Promise<OpenAlgoView> {
  if (last && nowMs - last.checkedAt < CACHE_MS) return last;
  try {
    const r = await fetchFn(`${INTERNAL}/auth/check-setup`, { signal: AbortSignal.timeout(4_000) });
    const j: any = await r.json().catch(() => null);
    last = { up: r.ok, needsSetup: typeof j?.needs_setup === 'boolean' ? j.needs_setup : null, url: PUBLIC, checkedAt: nowMs, error: r.ok ? null : `HTTP ${r.status}` };
  } catch (e) {
    last = { up: false, needsSetup: null, url: PUBLIC, checkedAt: nowMs, error: String((e as Error)?.message ?? 'unreachable').slice(0, 120) };
  }
  return last;
}

export default async function handler(req: Req, res: Res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  res.status(200).json(await openAlgoStatus());
}
