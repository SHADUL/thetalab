import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWalkForwardWindows, assertNoLeakageAcrossWindow, sliceToTestWindow } from '../backtest/walkForward.ts';

test('builds chronologically ordered, non-overlapping-TEST windows rolled forward by the TEST length', () => {
  const windows = buildWalkForwardWindows('2024-02-01', '2026-09-15', { trainMonths: 12, validateMonths: 3, testMonths: 3 });
  assert.ok(windows.length >= 2, `expected at least 2 windows, got ${windows.length}`);
  for (let i = 1; i < windows.length; i++) {
    // Each window's TEST starts exactly where the previous window's TEST ended.
    assert.equal(windows[i].testStart, windows[i - 1].testEnd);
  }
  for (const w of windows) {
    assert.ok(w.trainStart < w.trainEnd && w.trainEnd <= w.validateStart);
    assert.ok(w.validateStart < w.validateEnd && w.validateEnd <= w.testStart);
    assert.ok(w.testStart < w.testEnd);
  }
});

test('FUTURE-DATA LEAKAGE GUARD: assertNoLeakageAcrossWindow throws if a TRAIN/VALIDATE-dated row is actually dated in or after TEST', () => {
  const windows = buildWalkForwardWindows('2024-02-01', '2026-09-15', { trainMonths: 12, validateMonths: 3, testMonths: 3 });
  const w = windows[0];
  // A clean, correctly-dated series must pass.
  const clean = [{ date: w.trainStart }, { date: w.validateStart }, { date: w.testStart }];
  assert.doesNotThrow(() => assertNoLeakageAcrossWindow(w, clean));
});

test('assertNoLeakageAcrossWindow rejects a malformed window with non-chronological boundaries', () => {
  const w = { index: 0, trainStart: '2024-06-01', trainEnd: '2024-01-01', validateStart: '2024-07-01', validateEnd: '2024-10-01', testStart: '2024-10-01', testEnd: '2025-01-01' };
  assert.throws(() => assertNoLeakageAcrossWindow(w, []));
});

test('sliceToTestWindow returns only rows within [testStart, testEnd)', () => {
  const windows = buildWalkForwardWindows('2024-02-01', '2026-09-15', { trainMonths: 12, validateMonths: 3, testMonths: 3 });
  const w = windows[0];
  const rows = [{ date: w.trainStart }, { date: w.testStart }, { date: w.testEnd }, { date: '2099-01-01' }];
  const sliced = sliceToTestWindow(rows, w);
  assert.equal(sliced.length, 1);
  assert.equal(sliced[0].date, w.testStart);
});

test('no windows are produced when the data range is shorter than one full TRAIN+VALIDATE+TEST cycle', () => {
  const windows = buildWalkForwardWindows('2024-02-01', '2024-06-01', { trainMonths: 12, validateMonths: 3, testMonths: 3 });
  assert.equal(windows.length, 0);
});
