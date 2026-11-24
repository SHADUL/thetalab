/** Minimal in-memory stand-in for the supabase-js query builder (tests only). */
type Row = Record<string, any>;
const cmp = (a: any, b: any) => (typeof a === 'number' || typeof b === 'number' ? Number(a) - Number(b) : String(a).localeCompare(String(b)));

export class FakeSupabase {
  tables = new Map<string, Row[]>();
  seq = 0;
  clock = () => new Date().toISOString();
  /** When false, naked_sell_positions rejects mode LIVE (migration not applied). */
  allowLive = true;
  rows(t: string) { if (!this.tables.has(t)) this.tables.set(t, []); return this.tables.get(t)!; }
  from(t: string) { return new Q(this, t); }
}

class Q {
  private f: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
  private payload: any;
  private ret = false;
  private ord: [string, boolean] | null = null;
  private lim: number | null = null;
  private one: 'maybe' | 'one' | null = null;
  private db: FakeSupabase;
  private t: string;
  constructor(db: FakeSupabase, t: string) { this.db = db; this.t = t; }
  select(_c?: string) { if (this.op !== 'select') this.ret = true; return this; }
  eq(c: string, v: any) { this.f.push((r) => String(r[c]) === String(v)); return this; }
  neq(c: string, v: any) { this.f.push((r) => String(r[c]) !== String(v)); return this; }
  gte(c: string, v: any) { this.f.push((r) => r[c] != null && cmp(r[c], v) >= 0); return this; }
  gt(c: string, v: any) { this.f.push((r) => r[c] != null && cmp(r[c], v) > 0); return this; }
  lte(c: string, v: any) { this.f.push((r) => r[c] != null && cmp(r[c], v) <= 0); return this; }
  lt(c: string, v: any) { this.f.push((r) => r[c] != null && cmp(r[c], v) < 0); return this; }
  in(c: string, v: any[]) { this.f.push((r) => v.map(String).includes(String(r[c]))); return this; }
  not(c: string, _op: 'in', list: string) { const v = list.slice(1, -1).split(','); this.f.push((r) => !v.includes(String(r[c]))); return this; }
  order(c: string, o: { ascending?: boolean } = {}) { this.ord = [c, o.ascending !== false]; return this; }
  limit(n: number) { this.lim = n; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  single() { this.one = 'one'; return this; }
  insert(p: any) { this.op = 'insert'; this.payload = p; return this; }
  update(p: any) { this.op = 'update'; this.payload = p; return this; }
  upsert(p: any) { this.op = 'upsert'; this.payload = p; return this; }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve().then(() => this.run()).then(res, rej); }

  private out(rows: Row[]) {
    let r = rows.map((x) => ({ ...x }));
    if (this.ord) { const [c, asc] = this.ord; r.sort((a, b) => (asc ? 1 : -1) * cmp(a[c], b[c])); }
    if (this.lim != null) r = r.slice(0, this.lim);
    if (this.one) {
      if (this.one === 'one' && r.length !== 1) return { data: null, error: { message: `expected one row, got ${r.length}` } };
      return { data: r[0] ?? null, error: null };
    }
    return { data: r, error: null };
  }

  private run(): { data: any; error: any } {
    const all = this.db.rows(this.t);
    const match = all.filter((r) => this.f.every((fn) => fn(r)));
    if (this.op === 'select') return this.out(match);
    if (this.op === 'update') { for (const r of match) Object.assign(r, this.payload); return this.ret ? this.out(match) : { data: null, error: null }; }
    const list = Array.isArray(this.payload) ? this.payload : [this.payload];
    const done: Row[] = [];
    for (const p0 of list) {
      const p = { ...p0 };
      if (this.t === 'naked_sell_positions') {
        if (!['PAPER', 'SHADOW', ...(this.db.allowLive ? ['LIVE'] : [])].includes(p.mode)) return { data: null, error: { code: '23514', message: 'violates check constraint "naked_sell_positions_mode_check"' } };
        p.status ??= 'ACTIVE'; p.opened_at ??= this.db.clock();
        if (all.some((r) => r.status === 'ACTIVE' && r.mode === p.mode && r.symbol === p.symbol)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "naked_sell_one_active"' } };
      }
      const key = this.t === 'naked_sell_trend' ? 'symbol' : 'id';
      if (this.op === 'upsert') { const ex = all.find((r) => r[key] === p[key]); if (ex) { Object.assign(ex, p); done.push(ex); continue; } }
      if (p.id == null && key === 'id') p.id = ++this.db.seq;
      p.created_at ??= this.db.clock();
      all.push(p); done.push(p);
    }
    return this.ret ? this.out(done) : { data: null, error: null };
  }
}
