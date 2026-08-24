import { useState, useRef, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CaretLeft, CaretRight, CaretDown, CaretDoubleLeft, CaretDoubleRight,
         Check } from "@phosphor-icons/react";
import { fm, fi, cnt, scnt, cx } from "../lib/format";
import { dte } from "../lib/chain";

/* ── the B / S pills that appear on a hovered premium ─────────────────── */
function Pill({ kind, onClick, title }) {
  const buy = kind === "BUY";
  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.7 }}
      transition={{ type: "spring", stiffness: 520, damping: 26 }}
      whileTap={{ scale: 0.94 }}
      onClick={(e) => { e.stopPropagation(); onClick(); }} title={title}
      className={cx("bs-pill", buy ? "is-buy" : "is-sell")}
    >{buy ? "B" : "S"}</motion.button>
  );
}

function Badge({ pos }) {
  const short = pos.lots < 0;
  return (
    <motion.span layout
      initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: "spring", stiffness: 420, damping: 28 }}
      title={`${short ? "Sold" : "Bought"} ${Math.abs(pos.lots)} lot(s) @ ${fm(pos.avg)}`}
      className={cx("pos-badge", short ? "is-sell" : "is-buy")}>
      {short ? "S" : "B"}{Math.abs(pos.lots)}
    </motion.span>
  );
}

/* ── add-ons menu: which optional columns the chain carries ───────────── */
function AddOns({ cols, setCols }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const items = [["oi", "Open interest"], ["iv", "Implied vol"], ["delta", "Delta"]];
  return (
    <div className="relative" ref={ref}>
      <button className="chip" onClick={() => setOpen((v) => !v)}>
        Add ons <CaretDown size={9} weight="bold" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14, ease: "easeOut" }} className="menu">
            {items.map(([k, label]) => (
              <button key={k} className="menu-item"
                onClick={() => setCols((c) => ({ ...c, [k]: !c[k] }))}>
                <span className={cx("menu-tick", cols[k] && "is-on")}>
                  {cols[k] && <Check size={9} weight="bold" />}
                </span>
                {label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── expiry tab row ───────────────────────────────────────────────────── */
function ExpiryTabs({ expiries, expiry, tags, today, onPick }) {
  const rail = useRef(null);
  const nudge = (dir) => rail.current?.scrollBy({ left: dir * 190, behavior: "smooth" });
  const fmt = (e) => new Date(e + "T00:00:00")
    .toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" })
    .replace(/(\d{2})$/, "'$1").toUpperCase();

  useEffect(() => {
    rail.current?.querySelector("[data-on='true']")
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [expiry]);

  return (
    <div className="exprow">
      <button className="exparrow" onClick={() => nudge(-1)} aria-label="Earlier expiries">
        <CaretLeft size={11} weight="bold" />
      </button>
      <div className="exprail" ref={rail}>
        {expiries.map((e) => {
          const tag = tags[e], d = today ? dte(e, today) : null;
          return (
            <button key={e} data-on={e === expiry} onClick={() => onPick(e)}
              className={cx("exptab", e === expiry && "is-on")}>
              <span className="n exptab-date">{fmt(e)}</span>
              {(tag || d != null) && (
                <span className="exptab-sub">
                  {tag && <b>{tag}</b>}{tag && d != null && ": "}
                  {d != null && `${d} DTE`}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <button className="exparrow" onClick={() => nudge(1)} aria-label="Later expiries">
        <CaretRight size={11} weight="bold" />
      </button>
    </div>
  );
}

/* ── panel ────────────────────────────────────────────────────────────── */
export default function ChainPanel({
  expiries, allExpiries, expiry, tags, today, rows, atm, spot, held, onAdd, lots,
  atmIV, straddle, pcr, oi, maxPain, basis, setBasis, synthFut, onPickExpiry,
  priceBasis, setPriceBasis, collapsed, setCollapsed,
}) {
  const [hover, setHover] = useState(null);
  /* Matches the reference chain out of the box — premium and delta only. The
     OI and IV columns are a click away in Add ons rather than always on. */
  const [cols, setCols] = useState({ oi: false, iv: false, delta: true });
  const body = useRef(null);

  /* Centre the chain on the money whenever the session or expiry changes —
     the ATM strike is where the eye starts, not row one. scrollTop is set
     directly rather than via scrollIntoView, which would drag the whole page
     along with the scroll container. */
  useEffect(() => {
    const c = body.current;
    const el = c?.querySelector("[data-atm='true']");
    if (c && el) c.scrollTop = el.offsetTop - c.clientHeight / 2 + el.clientHeight / 2;
  }, [expiry, atm]);

  /* Grouped by year, chronological. An array rather than an object because
     object keys that look like integers ("2019") are ordered numerically by the
     engine no matter what order they were inserted in. */
  const byYear = useMemo(() => {
    const g = new Map();
    (allExpiries ?? []).forEach((e) => {
      const y = e.slice(0, 4);
      if (!g.has(y)) g.set(y, []);
      g.get(y).push(e);
    });
    return [...g.entries()];
  }, [allExpiries]);

  const maxOI = useMemo(
    () => Math.max(1, ...rows.map((r) => Math.max(r.co || 0, r.po || 0))), [rows]);

  /* One side of one strike. Slots are fixed-width and always rendered, so
     revealing B/S on hover never nudges a price by a pixel. */
  const Side = ({ r, right }) => {
    const px = right === "CE" ? r.c : r.p;
    const delta = right === "CE" ? r.cDelta : r.pDelta;
    const iv = right === "CE" ? r.cIV : r.pIV;
    const key = `${r.strike}${right}`;
    const on = hover === key, has = px != null;
    const pos = held[key];
    const badge = pos && pos.lots !== 0;
    const itm = right === "CE" ? r.strike < spot : r.strike > spot;
    const rtl = right === "CE";

    const cells = [
      <span key="px" className={cx("n ch-px", on && "is-dim")}>
        {has ? fm(px) : <span className="text-faint">—</span>}
        {cols.delta && delta != null && (
          <span className="ch-delta"> ({fm(delta, 2)})</span>
        )}
      </span>,
      <span key="act" className="ch-act">
        <AnimatePresence>
          {on && has && [
            <Pill key="b" kind="BUY" onClick={() => onAdd(r.strike, right, "BUY")}
              title={`Buy ${lots} lot(s) ${r.strike} ${right}`} />,
            <Pill key="s" kind="SELL" onClick={() => onAdd(r.strike, right, "SELL")}
              title={`Sell ${lots} lot(s) ${r.strike} ${right}`} />,
          ]}
        </AnimatePresence>
        <AnimatePresence>{badge && <Badge pos={pos} />}</AnimatePresence>
      </span>,
    ];

    return (
      <td
        /* Hover reveals B/S on a mouse; tapping does the same on touch, where
           there is no hover at all. Click opens rather than toggles — a mouse
           fires enter before click, so a toggle would shut the pills again the
           moment you reached for them. */
        onMouseEnter={() => has && setHover(key)}
        onMouseLeave={() => setHover((h) => (h === key ? null : h))}
        onClick={() => has && setHover(key)}
        className={cx("ch-cell", has && "cursor-pointer", itm && "is-itm",
          badge && (pos.lots < 0 ? "is-short" : "is-long"), on && "is-hot")}>
        <span className={cx("ch-inner", rtl && "is-rtl")}>
          {cols.iv && (
            <span className="n ch-iv">{iv ? fm(iv * 100, 1) : "—"}</span>
          )}
          {(rtl ? [...cells].reverse() : cells)}
        </span>
        {cols.oi && (
          <span className="ch-oibar" style={{
            width: `${((right === "CE" ? r.co : r.po) / maxOI) * 100}%`,
            [rtl ? "right" : "left"]: 0,
          }} data-side={right} />
        )}
      </td>
    );
  };

  return (
    <section className="panel-e deskpanel">
      <div className="panel-head">
        <AddOns cols={cols} setCols={setCols} />
        {/* The tab rail only carries the expiries live on this session. This
            picker reaches the whole history — every expiry in the bundle,
            grouped by year — so an old cycle can be opened and replayed. */}
        <h2 className="panel-title">
          Option Chain
          <select className="expsel n" value={expiry ?? ""} aria-label="Expiry"
            onChange={(e) => onPickExpiry(e.target.value)}>
            {byYear.map(([yr, list]) => (
              <optgroup key={yr} label={yr}>
                {list.map((e) => (
                  <option key={e} value={e}>
                    {new Date(e + "T00:00:00").toLocaleDateString("en-IN",
                      { day: "2-digit", month: "short", year: "numeric" }).toUpperCase()}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </h2>
        <button className="chip" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? <CaretDoubleRight size={10} weight="bold" />
                     : <CaretDoubleLeft size={10} weight="bold" />}
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>

      {!collapsed && (
        <>
          <ExpiryTabs expiries={expiries} expiry={expiry} tags={tags} today={today}
            onPick={onPickExpiry} />

          {/* stats row one */}
          <div className="statrow">
            <span className="stat">
              <span className="stat-k">ATM IV:</span>
              <span className="n stat-v">{atmIV ? fm(atmIV * 100, 1) : "—"}</span>
            </span>
            <span className="stat gap-2">
              <span className="stat-k">ATM:</span>
              {[["spot", "Spot"], ["synth", "Synth Fut"]].map(([k, label]) => (
                <label key={k} className={cx("radio", basis === k && "is-on")}>
                  <input type="radio" name="atm-basis" checked={basis === k}
                    onChange={() => setBasis(k)}
                    disabled={k === "synth" && synthFut == null} />
                  <span className="radio-dot" />{label}
                </label>
              ))}
            </span>
            <span className="stat gap-2">
              <span className="stat-k">Price:</span>
              {[["open", "Open", "The session's first traded price — what you could actually have entered at that morning"],
                ["settle", "Close", "The exchange's settlement price, computed after the close. Consistent across every strike, but only known once the day is over"]]
                .map(([k, label, hint]) => (
                <label key={k} className={cx("radio", priceBasis === k && "is-on")} title={hint}>
                  <input type="radio" name="price-basis" checked={priceBasis === k}
                    onChange={() => setPriceBasis(k)} />
                  <span className="radio-dot" />{label}
                </label>
              ))}
            </span>
            <span className="stat">
              <span className="stat-k">Straddle Prem:</span>
              <span className="n stat-v">{straddle != null ? fi(straddle) : "—"}</span>
            </span>
          </div>

          {/* stats row two */}
          <div className="statrow">
            <span className="stat">
              <span className="stat-k">PCR:</span>
              <span className="n stat-v">{pcr != null ? fm(pcr, 2) : "—"}</span>
            </span>
            <span className="stat gap-1.5">
              <span className="n stat-v is-down">{cnt(oi?.callOI)}</span>
              <span className="n stat-sub text-loss">({scnt(oi?.dCall)})</span>
              <span className="oi-swatch is-call" />
              <span className="stat-k">OI</span>
              <span className="oi-swatch is-put" />
              <span className="n stat-v is-up">{cnt(oi?.putOI)}</span>
              <span className="n stat-sub text-gain">({scnt(oi?.dPut)})</span>
            </span>
            <span className="stat">
              <span className="stat-k">Max Pain:</span>
              <span className="n stat-v">{maxPain != null ? fi(maxPain) : "—"}</span>
            </span>
          </div>

          <div className="chain-body" ref={body}>
            <table className="chain-table">
              <thead>
                <tr>
                  <th className="text-right">Call LTP{cols.delta && " (Δ)"}</th>
                  <th className="text-center">Strike</th>
                  <th className="text-left">Put LTP{cols.delta && " (Δ)"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const diff = atm != null ? r.strike - atm : null;
                  return (
                    <tr key={r.strike} data-atm={r.strike === atm}
                      className={cx(r.strike === atm && "is-atm-row")}>
                      <Side r={r} right="CE" />
                      <td className={cx("ch-strike", r.strike === atm && "is-atm")}>
                        <span className="n ch-strike-n">{r.strike}</span>
                        {diff != null && (
                          <span className="n ch-strike-rel">
                            {diff === 0 ? "ATM" : `ATM ${diff > 0 ? "+" : "−"} ${Math.abs(diff)}`}
                          </span>
                        )}
                      </td>
                      <Side r={r} right="PE" />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
