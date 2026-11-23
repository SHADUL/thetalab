/**
 * 1-minute bar builder (Kite start-labelled bars, Q2).
 *
 * Data policy (documented in NIFTY_ASCENT.md):
 *  - A tick belongs to the bar containing its EXCHANGE timestamp.
 *  - A bar is confirmed once the clock passes its end + grace; it is never
 *    used before then and never changed afterwards.
 *  - Out-of-order ticks (exchange time earlier than the last accepted tick)
 *    and exact duplicates (same exchange time and price) are dropped.
 *  - Ticks for an already-confirmed bar are LATE: counted, never applied.
 *  - A bar with no accepted tick is MISSING (index) / NO_PRINT (option LTP);
 *    nothing is ever carried forward into it.
 */
import { barLabelOf, barStart } from './rules.ts';

export type BarStatus = 'OK' | 'MISSING' | 'NO_PRINT';

export interface Bar {
  label: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  ticks: number;
  firstExchTs: number | null;
  lastExchTs: number | null;
  lastRecvTs: number | null;
  status: BarStatus;
}

export interface BarStats { accepted: number; duplicates: number; outOfOrder: number; late: number; outOfSession: number }

export class MinuteBarBuilder {
  readonly bars: Bar[] = [];
  readonly stats: BarStats = { accepted: 0, duplicates: 0, outOfOrder: 0, late: 0, outOfSession: 0 };
  private forming: Bar | null = null;
  private lastExchTs = -Infinity;
  private lastPrice: number | null = null;
  /** Next bar label awaiting confirmation. */
  nextLabel: number;
  private readonly date: string;
  private readonly firstLabel: number;
  private readonly lastLabel: number;
  private readonly emptyStatus: BarStatus;
  constructor(date: string, firstLabel: number, lastLabel: number, emptyStatus: BarStatus = 'MISSING') {
    this.date = date; this.firstLabel = firstLabel; this.lastLabel = lastLabel; this.emptyStatus = emptyStatus;
    this.nextLabel = firstLabel;
  }

  /** Returns 'ok' | the reason the tick was not applied. */
  add(exchTs: number, recvTs: number, price: number): 'ok' | 'duplicate' | 'out_of_order' | 'late' | 'out_of_session' {
    const label = barLabelOf(this.date, exchTs);
    if (label < this.firstLabel || label > this.lastLabel) { this.stats.outOfSession++; return 'out_of_session'; }
    if (label < this.nextLabel) { this.stats.late++; return 'late'; }
    if (exchTs < this.lastExchTs) { this.stats.outOfOrder++; return 'out_of_order'; }
    if (exchTs === this.lastExchTs && price === this.lastPrice) { this.stats.duplicates++; return 'duplicate'; }
    this.lastExchTs = exchTs; this.lastPrice = price;
    if (!this.forming || this.forming.label !== label) {
      // A tick for a later bar: earlier unconfirmed bars stay empty until the clock confirms them.
      this.pending.set(label, this.pending.get(label) ?? emptyBar(label));
      this.forming = this.pending.get(label)!;
    }
    const b = this.forming;
    if (b.open == null) { b.open = price; b.high = price; b.low = price; b.firstExchTs = exchTs; }
    b.high = Math.max(b.high!, price); b.low = Math.min(b.low!, price);
    b.close = price; b.ticks++; b.lastExchTs = exchTs; b.lastRecvTs = recvTs;
    this.stats.accepted++;
    return 'ok';
  }
  private pending = new Map<number, Bar>();

  /** Confirm every bar whose end + grace ≤ now. Returns the newly confirmed bars in order. */
  confirmUntil(nowMs: number, graceMs: number): Bar[] {
    const out: Bar[] = [];
    while (this.nextLabel <= this.lastLabel && nowMs >= barStart(this.date, this.nextLabel + 1) + graceMs) {
      const b = this.pending.get(this.nextLabel) ?? emptyBar(this.nextLabel);
      this.pending.delete(this.nextLabel);
      if (b.ticks === 0) b.status = this.emptyStatus;
      if (this.forming === b) this.forming = null;
      this.bars.push(b); out.push(b);
      this.nextLabel++;
    }
    return out;
  }

  get(label: number): Bar | undefined {
    const i = label - this.firstLabel;
    const b = this.bars[i];
    return b && b.label === label ? b : this.bars.find((x) => x.label === label);
  }
  /** The bar still forming (not yet confirmed), for display only. */
  formingBar(): Bar | null { return this.forming; }
}

function emptyBar(label: number): Bar {
  return { label, open: null, high: null, low: null, close: null, ticks: 0, firstExchTs: null, lastExchTs: null, lastRecvTs: null, status: 'OK' };
}
