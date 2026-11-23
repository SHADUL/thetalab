/**
 * Deterministic SIMULATION fixtures — one synthetic session per strategy
 * path. Prices are invented to exercise the rules; they are not market data
 * and their P&L is not evidence of anything. Tests assert that each fixture
 * really produces the outcome it was designed for.
 *
 * Shared previous day: 15:15 close 25,100 · highest close 25,260 · lowest
 * close 25,010 → Williams range R = 250 → levels today_open ± 125.
 */
import type { Scenario } from './market.ts';

const PREV: Array<[string, number]> = [['09:15', 25150], ['11:00', 25260], ['13:30', 25010], ['15:15', 25100], ['15:29', 25105]];

export const FIXTURES: Scenario[] = [
  {
    id: 'gg-ce-trail', title: 'Gap-and-Go CE · trailing stop',
    summary: 'Gap up 0.60%. Upside breakout after the opening range; the CE rallies, the trail activates and a pullback exits it.',
    expect: { outcome: 'TRADE', reason: 'TRAILING_STOP', bot: 'GAP_AND_GO' },
    date: '2026-11-02', prevDate: '2026-10-30', prevAnchors: PREV, seed: 11, noise: 3, iv: 0.12, noPrint: ['10:31'],
    anchors: [['09:15:00', 25250], ['09:22', 25288], ['09:30', 25262], ['09:38', 25238], ['09:45', 25268], ['10:00', 25280], ['10:06', 25315],
      ['11:30', 25430], ['12:10', 25445], ['12:40', 25355], ['13:30', 25362], ['15:29', 25370]],
  },
  {
    id: 'gg-pe-fixed', title: 'Gap-and-Go PE · fixed stop',
    summary: 'Gap down 0.56%. Downside breakout; NIFTY reverses and the PE premium falls through the −30% stop.',
    expect: { outcome: 'TRADE', reason: 'FIXED_STOP', bot: 'GAP_AND_GO' },
    date: '2026-11-04', prevDate: '2026-11-03', prevAnchors: PREV, seed: 22, noise: 3, iv: 0.095,
    anchors: [['09:15:00', 24960], ['09:25', 24985], ['09:33', 24937], ['09:45', 24955], ['10:10', 24945], ['10:16', 24916],
      ['10:50', 24985], ['11:20', 25040], ['12:10', 25050], ['15:29', 25035]],
  },
  {
    id: 'williams-pe-time', title: 'opposite_first → Williams PE · 15:15 time exit',
    summary: 'Gap up 0.12% (Williams-eligible). The downside band breaks first; Williams takes the PE when NIFTY closes below its PE level and holds to 15:15.',
    expect: { outcome: 'TRADE', reason: 'TIME_EXIT', bot: 'WILLIAMS', standDown: 'opposite_first' },
    date: '2026-11-05', prevDate: '2026-11-04', prevAnchors: PREV, seed: 33, noise: 2.5, iv: 0.10,
    anchors: [['09:15:00', 25130], ['09:25', 25158], ['09:35', 25113], ['09:45', 25138], ['10:00', 25126], ['10:12', 25088],
      ['10:40', 25060], ['11:20', 24988], ['12:30', 24930], ['13:30', 24902], ['14:30', 24884], ['15:15', 24872], ['15:29', 24876]],
  },
  {
    id: 'filled-williams-ce', title: 'filled → Williams CE · fixed stop',
    summary: 'Gap up 0.60%. A one-tick dip fills the gap inside a minute (the minute still closes above the band), so the later upside breakout stands down as `filled`. Williams buys the CE and is stopped.',
    expect: { outcome: 'TRADE', reason: 'FIXED_STOP', bot: 'WILLIAMS', standDown: 'filled' },
    date: '2026-11-06', prevDate: '2026-11-05', prevAnchors: PREV, seed: 44, noise: 2.5, iv: 0.10,
    anchors: [['09:15:00', 25250], ['09:24', 25278], ['09:34', 25237], ['09:45', 25255], ['10:12:00', 25248], ['10:12:15', 25098], ['10:12:30', 25246],
      ['10:20', 25262], ['10:40', 25302], ['11:10', 25340], ['11:30', 25381], ['12:00', 25300], ['12:30', 25255], ['15:29', 25270]],
  },
  {
    id: 'no-break-filled', title: 'Gap filled, no breakout → no_break',
    summary: 'Gap down 0.40%. A tick spike fills the gap but no qualifying breakout happens by 12:00, so the reason is `no_break` and Williams never activates (Q4) — even when NIFTY later falls hard.',
    expect: { outcome: 'NO_TRADE', reason: 'no_break', standDown: 'no_break' },
    date: '2026-11-09', prevDate: '2026-11-06', prevAnchors: PREV, seed: 55, noise: 2, iv: 0.11,
    anchors: [['09:15:00', 25000], ['09:25', 25022], ['09:35', 24985], ['09:45', 25004], ['10:30:00', 25010], ['10:30:12', 25101], ['10:30:25', 25008],
      ['11:15', 25014], ['12:00', 25006], ['13:00', 24900], ['15:29', 24920]],
  },
  {
    id: 'mid-gap-blocked', title: 'Gap 0.30% → Williams forbidden',
    summary: 'Gap up 0.30%. The downside band breaks first (`opposite_first`), but a gap in [0.2%, 0.5%) forbids Williams.',
    expect: { outcome: 'NO_TRADE', reason: 'williams_gap_ineligible', standDown: 'opposite_first' },
    date: '2026-11-10', prevDate: '2026-11-09', prevAnchors: PREV, seed: 66, noise: 2, iv: 0.11,
    anchors: [['09:15:00', 25175], ['09:25', 25196], ['09:35', 25161], ['09:45', 25180], ['10:05', 25170], ['10:15', 25138], ['11:00', 25010], ['15:29', 25020]],
  },
  {
    id: 'zero-gap', title: 'Zero gap → no trade',
    summary: 'Today opens exactly at yesterday’s 15:15 close: no Gap-and-Go direction and no Williams (Q14).',
    expect: { outcome: 'NO_TRADE', reason: 'no_gap' },
    date: '2026-11-11', prevDate: '2026-11-10', prevAnchors: PREV, seed: 77, noise: 2, iv: 0.11,
    anchors: [['09:15:00', 25100], ['09:30', 25130], ['10:30', 25210], ['13:00', 25150], ['15:29', 25160]],
  },
  {
    id: 'data-error-or', title: 'Missing opening-range minute → DATA_ERROR',
    summary: 'No NIFTY tick arrives during 09:31. A required opening-range bar is missing, so the day is marked DATA_ERROR with no trade (Q5).',
    expect: { outcome: 'DATA_ERROR', reason: 'data_error' },
    date: '2026-11-12', prevDate: '2026-11-11', prevAnchors: PREV, seed: 88, noise: 2, iv: 0.11, missing: [['09:31:00', '09:31:59']],
    anchors: [['09:15:00', 25250], ['09:30', 25270], ['09:45', 25262], ['10:10', 25320], ['15:29', 25330]],
  },
  {
    id: 'budget-reject', title: 'Signal, but one lot exceeds the ₹15,000 budget',
    summary: 'Gap up 0.60% and a clean CE breakout, but implied volatility is high: one lot of the 150-ITM CE costs more than ₹15,000 including fees, so the entry is rejected (Q13). Strike and quantity are never changed to force a trade.',
    expect: { outcome: 'NO_TRADE', reason: 'entry_rejected', bot: 'GAP_AND_GO' },
    date: '2026-11-13', prevDate: '2026-11-12', prevAnchors: PREV, seed: 99, noise: 3, iv: 0.30,
    anchors: [['09:15:00', 25250], ['09:22', 25288], ['09:30', 25262], ['09:38', 25238], ['09:45', 25268], ['10:00', 25280], ['10:06', 25315], ['15:29', 25400]],
  },
  {
    id: 'boundary-0-2', title: 'Gap exactly 0.2000% → Williams forbidden',
    summary: 'Gap up exactly 0.2000% (25,100 → 25,150.20). 0.2% is the first ineligible value, so the `opposite_first` handover does not arm Williams.',
    expect: { outcome: 'NO_TRADE', reason: 'williams_gap_ineligible', standDown: 'opposite_first' },
    date: '2026-11-16', prevDate: '2026-11-13', prevAnchors: PREV, seed: 110, noise: 2, iv: 0.11,
    anchors: [['09:15:00', 25150.2], ['09:25', 25172], ['09:35', 25138], ['09:45', 25155], ['10:00', 25146], ['10:10', 25110], ['11:30', 24990], ['15:29', 25000]],
  },
  {
    id: 'williams-same-bar', title: 'Same-minute handover → Williams PE · trailing stop',
    summary: 'Gap up 0.10% (expiry day, so the next weekly expiry is used — Q9). One sharp minute closes below both the downside band and the Williams PE level: Gap-and-Go stands down and Williams triggers on that same completed bar (Q15).',
    expect: { outcome: 'TRADE', reason: 'TRAILING_STOP', bot: 'WILLIAMS', standDown: 'opposite_first' },
    date: '2026-11-17', prevDate: '2026-11-16', prevAnchors: PREV, seed: 121, noise: 2, iv: 0.085,
    anchors: [['09:15:00', 25125], ['09:25', 25140], ['09:35', 25113], ['09:45', 25128], ['10:15', 25122], ['10:21:00', 25118], ['10:21:50', 24990], ['10:22:30', 24985],
      ['11:30', 24860], ['12:30', 24965], ['15:29', 24970]],
  },
];

export const fixtureById = (id: string) => FIXTURES.find((f) => f.id === id);
