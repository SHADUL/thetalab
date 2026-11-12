/**
 * Self-hosted runtime (Oracle VM) replacing Vercel: serves the built SPA and
 * mounts the existing /api/* handlers unchanged. The handlers are written
 * against Vercel's Node signature (req.query, req.body, res.status().json()),
 * which Express provides natively. The access gate is the SAME middleware.ts
 * Vercel ran, adapted from Express's request to a Web Request.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import gate from '../middleware.ts';
import { installKiteThrottle } from './kiteThrottle.ts';
import { startNakedSellScheduler } from './nakedSellScheduler.ts';
import { startLogRetention } from './logRetention.ts';

// Before any handler loads: every Kite GET in this process shares one pacing queue.
installKiteThrottle();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const PORT = Number(process.env.PORT) || 3100;

// Every Vercel function this project deploys; nothing else under /api is routable.
const API_MODULES: Record<string, string> = {
  'options-autotrade': 'api/options-autotrade.ts',
  intraday: 'api/intraday.js',
  'kite-callback': 'api/kite-callback.js',
  'kite-chain': 'api/kite-chain.js',
  'kite-market-data': 'api/kite-market-data.js',
  'swing-autotrade-tick': 'api/swing-autotrade-tick.js',
  'swing-autotrade': 'api/swing-autotrade.js',
  'swing-scanner': 'api/swing-scanner.js',
  'swing-seed-universe': 'api/swing-seed-universe.js',
  'swing-settings': 'api/swing-settings.js',
  'swing-watchlist': 'api/swing-watchlist.js',
  'swing-india': 'api/swing-india.ts',
  'naked-sell': 'api/naked-sell.ts',
};
const loaded = new Map<string, (req: any, res: any) => unknown>();
async function handlerFor(name: string) {
  if (!loaded.has(name)) loaded.set(name, (await import(path.join(root, API_MODULES[name]))).default);
  return loaded.get(name)!;
}

const app = express();
app.set('trust proxy', true);

// Access log for API calls only: method, path + resource, status, duration.
// Never logs headers, bodies or other query params (tokens live there).
app.use('/api', (req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const r = typeof req.query.resource === 'string' ? `?resource=${req.query.resource}` : '';
    console.log(`${new Date().toISOString()} ${req.method} ${req.baseUrl}${req.path}${r} ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});
app.disable('x-powered-by');

// Access gate — middleware.ts, unchanged: returns a Response to block, undefined to allow.
app.use(async (req, res, next) => {
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const blocked = await gate(new Request(`${req.protocol}://${req.get('host')}${req.originalUrl}`, { method: 'GET', headers }));
    if (!blocked) return next();
    res.status(blocked.status);
    blocked.headers.forEach((v, k) => res.setHeader(k, v));
    res.send(Buffer.from(await blocked.arrayBuffer()));
  } catch (err) {
    next(err);
  }
});

app.use('/api', express.json({ limit: '5mb' }), express.urlencoded({ extended: true }), express.text());
app.all('/api/:name', async (req, res, next) => {
  if (!Object.hasOwn(API_MODULES, req.params.name)) { res.status(404).json({ error: 'not_found' }); return; }
  try {
    await (await handlerFor(req.params.name))(req, res);
  } catch (err) {
    next(err);
  }
});

app.use(express.static(dist, { index: false, maxAge: '1h' }));
// SPA fallback (vercel.json's rewrite): every non-API GET serves index.html.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(dist, 'index.html'));
});

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('request failed:', err?.message);
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`thetalab listening on :${PORT}`);
  startNakedSellScheduler();
  startLogRetention();
});
