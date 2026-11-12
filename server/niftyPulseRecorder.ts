/**
 * Optional NIFTY PULSE tick recorder — compressed files on the VM for future
 * replay. DISABLED unless NIFTY_PULSE_RECORD=on. Never writes to Supabase.
 *
 * Layout: <dir>/<YYYY-MM-DD IST>/<HH IST>.ndjson.gz, one gzip member per
 * open (appending after a restart is valid gzip). One JSON array per line:
 *   [kind, token, ltp, bid, ask, bidQty, askQty, volume, oi, exchTs, recvTs]
 * kind: "I" = NIFTY index, "O" = option.
 *
 * Guards (checked every minute and at each hourly rotation):
 *   • retention: day folders older than RETENTION_DAYS are deleted;
 *   • size cap: if the folder exceeds MAX_MB, oldest days are deleted
 *     (never today); if still over, recording pauses;
 *   • free space: if the disk has less than MIN_FREE_MB free, recording
 *     pauses (resumes automatically when space is back).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export interface RecorderOptions {
  dir: string;
  retentionDays: number;
  maxBytes: number;
  minFreeBytes: number;
  now?: () => number;
  /** Override for tests. */
  freeBytes?: (dir: string) => Promise<number>;
}

interface Q { token: number; ltp: number; bid: number | null; ask: number | null; depth?: { buy: Array<{ price: number; quantity: number }>; sell: Array<{ price: number; quantity: number }> } | null; volume?: number | null; oi?: number | null; receivedAt: number }

const MB = 1024 * 1024;
const CHECK_MS = 60_000;

function istParts(ms: number) {
  const iso = new Date(ms + 330 * 60_000).toISOString();
  return { day: iso.slice(0, 10), hour: iso.slice(11, 13) };
}

export function recorderOptionsFromEnv(root: string): RecorderOptions | null {
  if (process.env.NIFTY_PULSE_RECORD !== 'on') return null;
  const num = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    dir: process.env.NIFTY_PULSE_RECORD_DIR || path.join(root, 'data', 'nifty-pulse-ticks'),
    retentionDays: num('NIFTY_PULSE_RECORD_RETENTION_DAYS', 10),
    maxBytes: num('NIFTY_PULSE_RECORD_MAX_MB', 2048) * MB,
    minFreeBytes: num('NIFTY_PULSE_RECORD_MIN_FREE_MB', 5120) * MB,
  };
}

async function dirSize(d: string): Promise<number> {
  let total = 0;
  for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export class TickRecorder {
  readonly opts: RecorderOptions;
  private out: { key: string; gz: zlib.Gzip; file: fs.WriteStream } | null = null;
  private paused: string | null = null;
  private lines = 0;
  private dropped = 0;
  private lastError: string | null = null;
  private totalBytes = 0;
  private freeBytes: number | null = null;
  private lastCheck = 0;
  private checking = false;
  private deletedDays: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RecorderOptions) { this.opts = opts; }

  private now() { return this.opts.now ? this.opts.now() : Date.now(); }

  async start(): Promise<void> {
    await fsp.mkdir(this.opts.dir, { recursive: true });
    await this.check();
    this.timer = setInterval(() => { void this.check(); }, CHECK_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.close();
  }

  record(q: Q, exchTs: number | null, kind: 'INDEX' | 'OPTION'): void {
    if (this.paused) { this.dropped++; return; }
    try {
      const { day, hour } = istParts(q.receivedAt);
      const key = `${day}/${hour}`;
      if (this.out?.key !== key) this.open(key, day, hour);
      const bidQty = q.depth?.buy.find((l) => l.price === q.bid)?.quantity ?? null;
      const askQty = q.depth?.sell.find((l) => l.price === q.ask)?.quantity ?? null;
      const line = JSON.stringify([kind === 'INDEX' ? 'I' : 'O', q.token, q.ltp, q.bid, q.ask, bidQty, askQty, q.volume ?? null, q.oi ?? null, exchTs, q.receivedAt]);
      this.out!.gz.write(line + '\n');
      this.lines++;
    } catch (e) {
      this.dropped++;
      this.lastError = (e as Error).message;
    }
  }

  private open(key: string, day: string, hour: string) {
    void this.close();
    fs.mkdirSync(path.join(this.opts.dir, day), { recursive: true });
    const file = fs.createWriteStream(path.join(this.opts.dir, day, `${hour}.ndjson.gz`), { flags: 'a' });
    const gz = zlib.createGzip({ level: 6 });
    gz.pipe(file);
    file.on('error', (e) => { this.lastError = e.message; this.paused = `write error: ${e.message}`; });
    this.out = { key, gz, file };
    void this.check(true);
  }

  private close(): Promise<void> {
    const o = this.out;
    this.out = null;
    if (!o) return Promise.resolve();
    return new Promise((resolve) => { o.file.on('close', () => resolve()); o.gz.end(); });
  }

  /** Retention, size cap and free-space checks. */
  async check(force = false): Promise<void> {
    const now = this.now();
    if (this.checking || (!force && now - this.lastCheck < CHECK_MS / 2)) return;
    this.checking = true;
    this.lastCheck = now;
    try {
      const today = istParts(now).day;
      const cutoff = istParts(now - this.opts.retentionDays * 86_400_000).day;
      const days = (await fsp.readdir(this.opts.dir, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)).map((e) => e.name).sort();
      for (const d of days) if (d < cutoff && d !== today) await this.deleteDay(d);
      this.totalBytes = await dirSize(this.opts.dir);
      for (const d of days) {
        if (this.totalBytes <= this.opts.maxBytes) break;
        if (d === today || !fs.existsSync(path.join(this.opts.dir, d))) continue;
        await this.deleteDay(d);
        this.totalBytes = await dirSize(this.opts.dir);
      }
      this.freeBytes = await (this.opts.freeBytes ?? (async (d) => { const s = await fsp.statfs(d); return s.bavail * s.bsize; }))(this.opts.dir);
      const reasons: string[] = [];
      if (this.totalBytes > this.opts.maxBytes) reasons.push(`recordings use ${(this.totalBytes / MB).toFixed(0)} MB (cap ${(this.opts.maxBytes / MB).toFixed(0)} MB)`);
      if (this.freeBytes < this.opts.minFreeBytes) reasons.push(`only ${(this.freeBytes / MB).toFixed(0)} MB free on disk (minimum ${(this.opts.minFreeBytes / MB).toFixed(0)} MB)`);
      const wasPaused = this.paused;
      this.paused = reasons.length ? reasons.join('; ') : null;
      if (this.paused && !wasPaused) { console.warn(`[nifty-pulse-recorder] paused: ${this.paused}`); await this.close(); }
      if (!this.paused && wasPaused) console.log('[nifty-pulse-recorder] resumed');
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.checking = false;
    }
  }

  private async deleteDay(d: string) {
    await fsp.rm(path.join(this.opts.dir, d), { recursive: true, force: true });
    this.deletedDays.push(d);
    if (this.deletedDays.length > 20) this.deletedDays.shift();
    console.log(`[nifty-pulse-recorder] removed recordings for ${d}`);
  }

  status() {
    return {
      enabled: true,
      recording: !this.paused,
      paused: this.paused,
      linesThisProcess: this.lines,
      dropped: this.dropped,
      totalMb: Math.round((this.totalBytes / MB) * 10) / 10,
      freeMb: this.freeBytes == null ? null : Math.round(this.freeBytes / MB),
      maxMb: Math.round(this.opts.maxBytes / MB),
      minFreeMb: Math.round(this.opts.minFreeBytes / MB),
      retentionDays: this.opts.retentionDays,
      currentFile: this.out?.key ?? null,
      lastError: this.lastError,
      deletedDays: this.deletedDays.slice(-5),
    };
  }
}
