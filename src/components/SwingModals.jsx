import { useState, useEffect } from "react";
import { inr, fm, toneClass } from "./swingFormat.js";

function ModalShell({ title, onClose, children, width = 380 }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }} onClick={onClose}>
      <div className="rounded-[14px] p-4" style={{ width, maxWidth: "100%", border: "1px solid var(--c-line)", background: "var(--c-surface)" }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[14px] font-bold">{title}</h3>
          <button onClick={onClose} className="topstep">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted text-[11px]">{label}</span>
      {children}
      {hint && <span className="text-[10.5px] text-faint">{hint}</span>}
    </label>
  );
}

const inputStyle = { border: "1px solid var(--c-line-2)", background: "var(--c-surface-2)" };

/**
 * Global "how much do I have, how much am I willing to risk per trade"
 * settings — deliberately not per-position, so it's set once (from
 * anywhere: the Scanner header) and every sizing calculation downstream
 * reads the same two numbers.
 */
export function FundSettingsModal({ settings, onClose, onSaved }) {
  const [totalFund, setTotalFund] = useState(String(settings?.totalFund ?? ""));
  const [riskPct, setRiskPct] = useState(String(settings?.riskPct ?? 5));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    const tf = Number(totalFund);
    const rp = Number(riskPct);
    if (!Number.isFinite(tf) || tf < 0) { setError("Enter a valid fund amount."); return; }
    if (!Number.isFinite(rp) || rp <= 0 || rp > 100) { setError("Risk % must be between 0 and 100."); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/swing-settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ totalFund: tf, riskPct: rp }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body.message || body.error || "Failed to save.");
      onSaved({ totalFund: tf, riskPct: rp });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Fund & Risk Settings" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Total Fund (₹)">
          <input type="number" min="0" inputMode="decimal" value={totalFund} onChange={(e) => setTotalFund(e.target.value)}
            className="n px-2.5 py-1.5 rounded-[8px] text-[12px]" style={inputStyle} />
        </Field>
        <Field label="Risk per Trade (%)" hint="Fraction of your total fund you're willing to lose if a position hits its stop.">
          <input type="number" min="0.1" max="100" step="0.1" inputMode="decimal" value={riskPct} onChange={(e) => setRiskPct(e.target.value)}
            className="n px-2.5 py-1.5 rounded-[8px] text-[12px]" style={inputStyle} />
        </Field>
        {error && <p className="text-[11px] text-loss">{error}</p>}
        <button onClick={save} disabled={saving} className="topstep w-full justify-center">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div>
      <div className="text-muted text-[10.5px]">{label}</div>
      <div className={`n font-semibold text-[12px] ${tone ? toneClass(tone) : ""}`}>{value}</div>
    </div>
  );
}

/**
 * Position sizing, shown before a stock is actually added — spec-driven by
 * "risk a fixed % of the fund, size by distance to stop, never by a
 * guessed flat share count." Two independent caps apply: how many shares
 * the risk budget allows (riskAmount / slDistance), and how many shares
 * the remaining fund can actually afford — the smaller one wins, since
 * either alone can violate the other constraint.
 */
export function PositionSizeModal({ stock, onClose, onConfirm }) {
  const [fund, setFund] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [shares, setShares] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    fetch("/api/swing-watchlist")
      .then((r) => r.json())
      .then((body) => {
        if (body.error) throw new Error(body.message || body.error);
        setFund(body.fund ?? { totalFund: 0, riskPct: 5, allocated: 0, available: 0 });
      })
      .catch((e) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const slPoints = stock.stop != null ? stock.price - stock.stop : null;
  const riskAmount = fund ? (fund.totalFund * fund.riskPct) / 100 : 0;
  const sharesByRisk = slPoints != null && slPoints > 0 ? Math.floor(riskAmount / slPoints) : null;
  const sharesByFund = fund && stock.price > 0 ? Math.floor(Math.max(0, fund.available) / stock.price) : 0;
  const suggested = Math.max(0, sharesByRisk != null ? Math.min(sharesByRisk, sharesByFund) : sharesByFund);

  useEffect(() => {
    if (fund && !initialized) {
      setShares(suggested);
      setInitialized(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fund]);

  const capitalRequired = shares * stock.price;
  const remainingAfter = fund ? fund.available - capitalRequired : null;
  const overFund = fund ? capitalRequired > fund.available + 0.01 : false;
  const noFundSet = fund && fund.totalFund <= 0;

  const confirm = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onConfirm(shares);
      onClose();
    } catch (e) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={`Add ${stock.symbol} to Portfolio`} onClose={onClose}>
      {loading ? (
        <p className="text-muted text-[12px]">Loading fund details…</p>
      ) : loadError ? (
        <p className="text-[12px] text-loss">{loadError}</p>
      ) : noFundSet ? (
        <p className="text-[12px] text-warn">Set your total fund first (the fund button in the header) before sizing a position.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2.5">
            <Stat label="Entry" value={inr(stock.price)} />
            <Stat label="Stop" value={stock.stop != null ? inr(stock.stop) : "— (no stop)"} tone={stock.stop == null ? "warn" : undefined} />
            <Stat label="Risk / Trade" value={`${fund.riskPct}% = ${inr(riskAmount)}`} />
            <Stat label="Available Fund" value={inr(fund.available)} />
          </div>

          {slPoints != null ? (
            <p className="text-[11px] text-muted">
              SL distance ₹{fm(slPoints)} → risk allows <b className="text-ink">{sharesByRisk}</b> share{sharesByRisk === 1 ? "" : "s"},
              capped to <b className="text-ink">{sharesByFund}</b> by available fund.
            </p>
          ) : (
            <p className="text-[11px] text-warn">No structural stop for this setup — sizing by available fund only.</p>
          )}

          <Field label="Shares to Add">
            <input type="number" min="0" step="1" value={shares}
              onChange={(e) => setShares(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              className="n px-2.5 py-1.5 rounded-[8px] text-[12px]" style={inputStyle} />
          </Field>

          <div className="flex flex-col gap-1.5 pt-2 text-[11px]" style={{ borderTop: "1px solid var(--c-line)" }}>
            <div className="flex items-center justify-between">
              <span className="text-muted">Capital Required</span>
              <span className="n font-semibold">{inr(capitalRequired)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Fund Remaining After</span>
              <span className={`n font-semibold ${remainingAfter < 0 ? "text-loss" : ""}`}>{inr(remainingAfter)}</span>
            </div>
          </div>

          {overFund && <p className="text-[11px] text-loss">This exceeds your available fund.</p>}
          {submitError && <p className="text-[11px] text-loss">{submitError}</p>}

          <button onClick={confirm} disabled={submitting || shares <= 0 || overFund} className="topstep w-full justify-center">
            {submitting ? "Adding…" : `Add ${shares} share${shares === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </ModalShell>
  );
}
