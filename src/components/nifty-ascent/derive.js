/**
 * View model for NIFTY ASCENT: turns the engine's state into the words,
 * statuses and numbers the workspaces show. Read-only; no decisions are made
 * here — every decision already happened inside the engine.
 */
import { hm, num, pct, EXIT_LABEL, BOT_LABEL, REASON_LABEL } from "./format.js";
import { barStart, RESEARCH_RULES_V1 as R } from "../../nifty-ascent/core/rules.ts";

export function lastIndex(e) {
  const f = e.index.formingBar();
  if (f?.close != null) return { price: f.close, ts: f.lastExchTs, forming: true };
  const b = [...e.index.bars].reverse().find((x) => x.close != null);
  return b ? { price: b.close, ts: b.lastExchTs, forming: false } : null;
}

export function premiumNow(e) {
  const p = e.position;
  if (!p) return null;
  const q = e.lastQuote.get(p.instrument.token);
  return { ltp: p.lastPremium ?? q?.ltp ?? null, bid: q?.bid ?? null, ask: q?.ask ?? null, ts: q?.exchTs ?? null };
}

export function positionPnl(e) {
  const p = e.position;
  if (!p) return null;
  const q = premiumNow(e);
  if (q?.bid == null) return null;
  const gross = (q.bid - p.entryPremium) * p.qty;
  return { gross, mark: q.bid };
}

const done = (v) => ({ s: "done", v }), active = (v) => ({ s: "active", v }), blocked = (v) => ({ s: "blocked", v }), skipped = (v) => ({ s: "skipped", v }), idle = (v) => ({ s: "idle", v });

/** The seven flow nodes, each with a status and a one-line reason. */
export function flow(e) {
  const st = e.state, sd = e.standDown, sig = e.signal;
  const dataErr = e.outcome?.kind === "DATA_ERROR";
  const n = [];
  // 1 Opening range
  if (e.or) n.push(done(`H ${num(e.or.high, 2)} · L ${num(e.or.low, 2)} · W ${num(e.or.width, 2)}`));
  else if (dataErr) n.push(blocked(e.outcome.detail));
  else if (st === "COLLECTING_OPENING_RANGE" || e.reference) n.push(active(`${e.orCollected}/31 closes · 09:15–09:45`));
  else n.push(idle("waiting for 09:15"));
  // 2 Gap-and-Go
  if (e.outcome?.reason === "no_gap") n.push(blocked("zero gap — no direction"));
  else if (sig?.bot === "GAP_AND_GO") n.push(done(`${sig.right} breakout ${hm(sig.bar)} · close ${num(sig.close, 2)}`));
  else if (sd) n.push(blocked(`stood down: ${sd.reason} at ${hm(sd.bar)}`));
  else if (st === "GAP_GO_ARMED") n.push(active(`watching ${e.gap.direction === "UP" ? `close > ${num(e.or.upsideBand, 2)}` : `close < ${num(e.or.downsideBand, 2)}`} until 12:00`));
  else n.push(dataErr ? skipped("—") : idle(e.gap ? `gap ${e.gap.direction}` : "—"));
  // 3 Handover check
  if (!sd) n.push(sig?.bot === "GAP_AND_GO" ? skipped("not needed — Gap-and-Go traded") : idle("only after opposite_first / filled"));
  else if (sd.reason === "no_break") n.push(blocked("no_break never hands over"));
  else if (!e.williamsEligible) n.push(blocked(`gap ${pct(e.gap.pct, 4, { sign: false })} in [0.2%, 0.5%)`));
  else n.push(done(`${sd.reason} · gap ${pct(e.gap.pct, 4, { sign: false })} eligible`));
  // 4 Williams
  if (sig?.bot === "WILLIAMS") n.push(done(`${sig.right} trigger ${hm(sig.bar)} · close ${num(sig.close, 2)}`));
  else if (st === "WILLIAMS_ARMED") n.push(active(`CE > ${num(e.williams.ceLevel, 2)} · PE < ${num(e.williams.peLevel, 2)} · until 14:29`));
  else if (e.outcome?.reason === "williams_no_trigger") n.push(blocked("no level broke by 14:29"));
  else if (e.handover) n.push(done("armed"));
  else n.push(sd && (sd.reason === "no_break" || !e.williamsEligible) ? skipped("not activated") : sig ? skipped("not needed") : idle("inactive until handover"));
  // 5 Entry
  const eo = e.entryOrder;
  if (eo?.status === "FILLED") n.push(done(`filled ₹${num(eo.fill.price, 2)} · ${hm(Math.floor((eo.fill.quoteExchTs - barStart(e.date, 0)) / 60000))}`));
  else if (eo?.status === "PENDING") n.push(active(`seeking first fresh ask in ${hm(eo.signalBar + 1)}`));
  else if (eo?.status === "REJECTED" || e.outcome?.reason === "entry_rejected") n.push(blocked(e.outcome?.detail?.split(":")[0] ?? eo?.rejectReason ?? "rejected"));
  else n.push(idle("one position per day"));
  // 6 Position
  if (e.position && !e.exitOrder) n.push(active(`${e.position.trailActive ? "trail ACTIVE" : "trail not active"} · ${e.position.instrument.tradingsymbol.replace(/^NIFTY/, "")}`));
  else if (e.position || e.trade) n.push(done(e.trade ? `${e.trade.right} ${e.trade.strike} · peak ₹${num(e.trade.highest, 2)}` : "exit in progress"));
  else n.push(idle("—"));
  // 7 Exit
  if (e.trade) n.push(done(`${EXIT_LABEL[e.trade.exitReason]} · net ₹${num(e.trade.net, 0)}`));
  else if (e.outcome?.kind === "UNRESOLVED_EXIT") n.push(blocked("no bid observed — unresolved"));
  else if (e.exitOrder?.status === "PENDING") n.push(active(`${EXIT_LABEL[e.exitOrder.reason]} · seeking fresh bid`));
  else n.push(idle("stops · trail · 15:15"));
  return n;
}

export const FLOW_TITLES = ["Opening range", "Gap-and-Go", "Handover check", "Williams", "Entry", "Position", "Exit"];

/** The single "what is happening and why" explanation. */
export function explain(e) {
  const st = e.state, o = e.outcome;
  const px = lastIndex(e)?.price;
  if (o?.kind === "DATA_ERROR") return { tone: "loss", tag: "DATA ERROR", text: `${o.detail}. No trade is taken on incomplete data.` };
  if (st === "NO_TRADE" || (st === "SESSION_COMPLETE" && o?.kind === "NO_TRADE")) {
    const why = REASON_LABEL[o.reason] ?? o.reason;
    return { tone: o.reason === "entry_rejected" ? "loss" : "warn", tag: o.reason === "entry_rejected" ? "REJECTED" : "STAND DOWN", text: `${why}. ${o.detail ?? ""}`.trim() };
  }
  if (o?.kind === "UNRESOLVED_EXIT") return { tone: "loss", tag: "UNRESOLVED", text: o.detail };
  if (e.trade) return { tone: e.trade.net >= 0 ? "gain" : "loss", tag: "CLOSED", text: `${BOT_LABEL[e.trade.bot]} ${e.trade.right} closed by ${EXIT_LABEL[e.trade.exitReason]} · net ₹${num(e.trade.net, 0)} after ₹${num(e.trade.costs, 0)} costs. One position per day — no further entries today.` };
  if (st === "WAITING_FOR_MARKET") return { tone: undefined, tag: "WAIT", text: "Waiting for the first valid NIFTY tick at or after 09:15:00 — that tick is today’s reference price (Q1)." };
  if (st === "COLLECTING_OPENING_RANGE") return { tone: undefined, tag: "WAIT", text: `Collecting the opening range: ${e.orCollected}/31 one-minute closes (09:15–09:45). No signal can occur before the 09:46 bar closes.` };
  if (st === "GAP_GO_ARMED") {
    const up = e.gap.direction === "UP", lvl = up ? e.or.upsideBand : e.or.downsideBand, opp = up ? e.or.downsideBand : e.or.upsideBand;
    return { tone: "accent", tag: "WAIT", text: `Gap ${up ? "UP" : "DOWN"}: Gap-and-Go buys ${up ? "CE" : "PE"} on a 1-minute close ${up ? "above" : "below"} ${num(lvl, 2)}${px != null ? ` (${num(Math.abs(lvl - px), 2)} pts away)` : ""}. Stands down if a close ${up ? "below" : "above"} ${num(opp, 2)} comes first${e.gapFill ? ", and the gap has already filled — a breakout now would stand down as `filled`" : ""}. Window ends 12:00.` };
  }
  if (st === "WILLIAMS_ARMED") return { tone: "accent", tag: "WAIT", text: `Williams armed after \`${e.handover.reason}\` at ${hm(e.handover.bar)}: buys CE on a close above ${num(e.williams.ceLevel, 2)} or PE on a close below ${num(e.williams.peLevel, 2)} — whichever breaks first — until 14:29.` };
  if (st === "ENTRY_PENDING") return { tone: "accent", tag: "ENTRY", text: `${BOT_LABEL[e.signal.bot]} ${e.signal.right} signal on the ${hm(e.signal.bar)} close (${num(e.signal.close, 2)}). Paper order fills only at the first fresh executable ask in ${hm(e.signal.bar + 1)} — never at the signal close.` };
  if (e.position && e.exitOrder) return { tone: "warn", tag: "EXIT", text: `${EXIT_LABEL[e.exitOrder.reason]} signalled — filling at the first fresh executable bid${e.exitOrder.late ? " (late: none seen in the exit minute yet)" : ""}. No price is assumed.` };
  if (e.position) {
    const p = e.position;
    return { tone: "accent", tag: "MANAGING", text: `Holding ${p.instrument.tradingsymbol}. Exits on a 1-minute premium close ≤ ₹${num(p.fixedStop, 2)} (−30%)${p.trailActive ? ` or ≤ trail ₹${num(p.trailStop, 2)} (20% off the ₹${num(p.highest, 2)} high)` : `; the trail arms on a close above ₹${num(p.trailActivation, 2)}`}; otherwise at 15:15.` };
  }
  return { tone: undefined, tag: "WAIT", text: "—" };
}

/** Next action, one short line. */
export function nextAction(e) {
  const st = e.state;
  if (st === "WAITING_FOR_MARKET") return "Wait for 09:15:00 reference tick";
  if (st === "COLLECTING_OPENING_RANGE") return `Collect OR (${e.orCollected}/31)`;
  if (st === "GAP_GO_ARMED") return `Watch ${e.gap.direction === "UP" ? "upside" : "downside"} band until 12:00`;
  if (st === "WILLIAMS_ARMED") return "Watch Williams CE/PE levels until 14:29";
  if (st === "ENTRY_PENDING") return "Fill at first fresh ask (next minute)";
  if (e.position && e.exitOrder) return "Fill exit at first fresh bid";
  if (e.position) return "Manage stops; time exit 15:15";
  return "Nothing — session decided";
}

export function minutesLeft(e, nowMs, label) {
  const ms = barStart(e.date, label + 1) - nowMs;
  return ms > 0 ? ms : 0;
}
export { R };
