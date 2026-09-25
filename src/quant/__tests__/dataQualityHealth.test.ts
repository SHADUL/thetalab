import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeDataQualityHealth, DEFAULT_HEALTH_THRESHOLDS } from '../analytics/dataQualityHealth.ts';

const NOW = Date.parse('2026-09-25T10:00:00Z');

function snap(overrides: Partial<{ bid: number | null; ask: number | null; openInterest: number | null; iv: number | null; capturedAt: string }> = {}) {
  return { bid: 100, ask: 102, openInterest: 5000, iv: 0.14, capturedAt: new Date(NOW - 1000).toISOString(), ...overrides };
}

test('a fully healthy period reports no quality issue', () => {
  const health = computeDataQualityHealth({
    snapshots: Array.from({ length: 100 }, () => snap()),
    expectedSnapshotCount: 100,
    maxQuoteAgeMs: 300_000,
    nowMs: NOW,
    executionRecords: Array.from({ length: 10 }, () => ({ fillIsSimulated: true, actualFill: 100 })),
    expectedExecutionRecordCount: 10,
    ivHistory: [{ symbol: 'NIFTY', expiry: '2026-10-30' }],
    evaluatedSymbolExpiries: [{ symbol: 'NIFTY', expiry: '2026-10-30' }],
  });
  assert.equal(health.hasQualityIssue, false);
  assert.equal(health.snapshotIngestionSuccessPct, 100);
  assert.equal(health.missingBidAskPct, 0);
});

test('missing bid/ask on most snapshots is surfaced as a quality issue, never silently ignored', () => {
  const snapshots = [
    ...Array.from({ length: 20 }, () => snap()),
    ...Array.from({ length: 80 }, () => snap({ bid: null, ask: null })),
  ];
  const health = computeDataQualityHealth({
    snapshots, expectedSnapshotCount: 100, maxQuoteAgeMs: 300_000, nowMs: NOW,
    executionRecords: [], expectedExecutionRecordCount: null, ivHistory: [], evaluatedSymbolExpiries: [],
  });
  assert.equal(health.missingBidAskPct, 80);
  assert.equal(health.hasQualityIssue, true);
});

test('a stale quote past maxQuoteAgeMs is counted as stale', () => {
  const snapshots = [snap({ capturedAt: new Date(NOW - 10 * 60_000).toISOString() })]; // 10 min old
  const health = computeDataQualityHealth({
    snapshots, expectedSnapshotCount: 1, maxQuoteAgeMs: 300_000, nowMs: NOW,
    executionRecords: [], expectedExecutionRecordCount: null, ivHistory: [], evaluatedSymbolExpiries: [],
  });
  assert.equal(health.staleQuotePct, 100);
  assert.equal(health.hasQualityIssue, true);
});

test('IV-history coverage below threshold is flagged, and only counts symbol/expiry pairs actually evaluated', () => {
  const health = computeDataQualityHealth({
    snapshots: [], expectedSnapshotCount: null, maxQuoteAgeMs: 300_000, nowMs: NOW,
    executionRecords: [], expectedExecutionRecordCount: null,
    ivHistory: [{ symbol: 'NIFTY', expiry: '2026-10-30' }],
    evaluatedSymbolExpiries: [{ symbol: 'NIFTY', expiry: '2026-10-30' }, { symbol: 'NIFTY', expiry: '2026-11-27' }],
  });
  assert.equal(health.ivHistoryCoveragePct, 50);
  assert.equal(health.hasQualityIssue, true);
});

test('unknown (null) metrics are reported as null, never fabricated as 100% or 0%', () => {
  const health = computeDataQualityHealth({
    snapshots: [], expectedSnapshotCount: null, maxQuoteAgeMs: 300_000, nowMs: NOW,
    executionRecords: [], expectedExecutionRecordCount: null, ivHistory: [], evaluatedSymbolExpiries: [],
  });
  assert.equal(health.snapshotIngestionSuccessPct, null);
  assert.equal(health.missingBidAskPct, null);
  assert.equal(health.executionTelemetrySuccessPct, null);
  assert.equal(health.ivHistoryCoveragePct, null);
});
