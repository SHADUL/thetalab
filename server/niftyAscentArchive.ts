/**
 * Persistent NIFTY ASCENT observe-only archive on the VM, OUTSIDE the
 * replaceable application release folder (deploy.sh swaps /opt/thetalab/app).
 * docker-compose bind-mounts /opt/thetalab/data/nifty-ascent → /data/nifty-ascent.
 *
 * Layout under <dir>:
 *   reports/<YYYY-MM-DD>.json           end-of-session observation report
 *   events/<YYYY-MM-DD>.ndjson          decisions, data-quality, subscription and health lines
 *   ticks/<YYYY-MM-DD>/<HH>.ndjson.gz   OPTIONAL raw evidence (NIFTY_ASCENT_RECORD_TICKS=on)
 *        ["I", token, exchTs, recvTs, ltp]
 *        ["O", token, exchTs, recvTs, ltp, bid, ask, volume, lastTradeTs, lastTradedQty, traded]
 *
 * Guards (every minute): reports/events older than RETENTION_DAYS and tick days
 * older than TICK_RETENTION_DAYS are deleted; if the archive exceeds MAX_MB the
 * oldest tick days are deleted (never today) and tick recording pauses if still
 * over; if the disk has less than MIN_FREE_MB free, ticks and events pause (the
 * small end-of-day report is still written while ≥ 50 MB is free). Only market
 * data and engine decisions are written — never credentials.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const MB = 1024 * 1024;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface ArchiveOptions {
  dir: string;
  retentionDays: number;
  tickRetentionDays: number;
  maxBytes: number;
  minFreeBytes: number;
  recordTicks: boolean;
  now?: () => number;
  freeBytes?: (dir: string) => Promise<number>;
}

export function archiveOptionsFromEnv(): ArchiveOptions {
  const num = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    dir: process.env.NIFTY_ASCENT_DATA_DIR || '/data/nifty-ascent',
    retentionDays: num('NIFTY_ASCENT_RETENTION_DAYS', 90),
    tickRetentionDays: num('NIFTY_ASCENT_TICK_RETENTION_DAYS', 14),
    maxBytes: num('NIFTY_ASCENT_MAX_MB', 1024) * MB,
    minFreeBytes: num('NIFTY_ASCENT_MIN_FREE_MB', 5120) * MB,
    recordTicks: process.env.NIFTY_ASCENT_RECORD_TICKS === 'on',
  };
}

const ist = (ms: number) => { const s = new Date(ms + 330 * 60_000).toISOString(); return { day: s.slice(0, 10), hour: s.slice(11, 13) }; };
const daysAgo = (day: string, now: number) => (Date.parse(`${ist(now).day}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;

async function sizeOf(p: string): Promise<number> {
  const st = await fsp.stat(p).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let t = 0;
  for (const n of await fsp.readdir(p)) t += await sizeOf(path.join(p, n));
  return t;
}

export class ObserveArchive {
  private o: ArchiveOptions;
  private now: () => number;
  private gz: { key: string; stream: zlib.Gzip; file: fs.WriteStream } | null = null;
  ready = false;
  ticksPaused: string | null = null;
  eventsPaused: string | null = null;
  lastError: string | null = null;
  ticksWritten = 0;
  eventsWritten = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(o: ArchiveOptions) { this.o = o; this.now = o.now ?? Date.now; }

  /** Creates the folders and runs the first guard pass; never throws (archive is best-effort). */
  async start(): Promise<boolean> {
    try {
      for (const sub of ['reports', 'events', 'ticks']) await fsp.mkdir(path.join(this.o.dir, sub), { recursive: true });
      const probe = path.join(this.o.dir, '.write-test');
      await fsp.writeFile(probe, 'ok'); await fsp.rm(probe);
      this.ready = true;
      await this.guard();
      this.timer = setInterval(() => { this.guard().catch((e) => { this.lastError = e.message; }); }, 60_000);
      (this.timer as any).unref?.();
    } catch (e) { this.ready = false; this.lastError = (e as Error).message; }
    return this.ready;
  }

  async stop() { if (this.timer) clearInterval(this.timer); await this.closeGz(); }

  private free(): Promise<number> {
    if (this.o.freeBytes) return this.o.freeBytes(this.o.dir);
    return fsp.statfs(this.o.dir).then((s) => Number(s.bavail) * Number(s.bsize));
  }

  /** Retention, size cap and free-space checks. */
  async guard() {
    if (!this.ready) return;
    const now = this.now(), today = ist(now).day;
    for (const sub of ['reports', 'events']) {
      for (const f of await fsp.readdir(path.join(this.o.dir, sub)).catch(() => [] as string[])) {
        const day = f.slice(0, 10);
        if (DAY.test(day) && daysAgo(day, now) > this.o.retentionDays) await fsp.rm(path.join(this.o.dir, sub, f), { force: true });
      }
    }
    const tickDir = path.join(this.o.dir, 'ticks');
    let days = (await fsp.readdir(tickDir).catch(() => [] as string[])).filter((d) => DAY.test(d)).sort();
    for (const d of days) if (daysAgo(d, now) > this.o.tickRetentionDays) await fsp.rm(path.join(tickDir, d), { recursive: true, force: true });
    days = (await fsp.readdir(tickDir).catch(() => [] as string[])).filter((d) => DAY.test(d)).sort();
    let total = await sizeOf(this.o.dir);
    for (const d of days) {
      if (total <= this.o.maxBytes || d === today) break;
      total -= await sizeOf(path.join(tickDir, d));
      await fsp.rm(path.join(tickDir, d), { recursive: true, force: true });
    }
    const free = await this.free().catch(() => Infinity);
    this.eventsPaused = free < this.o.minFreeBytes ? `only ${Math.round(free / MB)} MB free on disk` : null;
    this.ticksPaused = this.eventsPaused ?? (total > this.o.maxBytes ? `archive over ${Math.round(this.o.maxBytes / MB)} MB cap` : null);
    if (this.ticksPaused) await this.closeGz();
  }

  event(line: string) {
    if (!this.ready || this.eventsPaused) return;
    try {
      fs.appendFileSync(path.join(this.o.dir, 'events', `${ist(this.now()).day}.ndjson`), `${JSON.stringify({ at: new Date(this.now()).toISOString(), msg: line })}\n`);
      this.eventsWritten++;
    } catch (e) { this.lastError = (e as Error).message; }
  }

  async report(date: string, report: unknown) {
    if (!this.ready) return;
    const free = await this.free().catch(() => Infinity);
    if (free < 50 * MB) { this.lastError = 'report not written: disk almost full'; return; }
    await fsp.writeFile(path.join(this.o.dir, 'reports', `${date}.json`), JSON.stringify(report, null, 2));
  }

  tick(row: unknown[], exchTs: number) {
    if (!this.ready || !this.o.recordTicks || this.ticksPaused) return;
    const { day, hour } = ist(exchTs);
    const key = `${day}/${hour}`;
    if (this.gz?.key !== key) {
      void this.closeGz();
      const dir = path.join(this.o.dir, 'ticks', day);
      fs.mkdirSync(dir, { recursive: true });
      const file = fs.createWriteStream(path.join(dir, `${hour}.ndjson.gz`), { flags: 'a' });
      const stream = zlib.createGzip();
      stream.pipe(file);
      this.gz = { key, stream, file };
    }
    this.gz!.stream.write(`${JSON.stringify(row)}\n`);
    this.ticksWritten++;
  }

  private closeGz(): Promise<void> {
    const g = this.gz;
    this.gz = null;
    if (!g) return Promise.resolve();
    return new Promise((res) => { g.file.on('close', () => res()); g.stream.end(); });
  }

  status() {
    return { dir: this.o.dir, ready: this.ready, recordTicks: this.o.recordTicks, ticksPaused: this.ticksPaused, eventsPaused: this.eventsPaused, ticksWritten: this.ticksWritten, eventsWritten: this.eventsWritten, lastError: this.lastError };
  }
}
