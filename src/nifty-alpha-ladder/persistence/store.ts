/**
 * The AlphaLadderStore abstraction: everything durable state the worker
 * and API need, behind ONE interface with two implementations —
 * `createSupabaseAlphaLadderStore` (real, production) and
 * `createInMemoryAlphaLadderStore` (a test double that enforces the same
 * unique constraints the real migration declares, so idempotency and
 * crash-recovery tests can run without a live database — per your
 * instruction, "if persistence tests can run against mocks/test DB, use
 * that").
 *
 * BLOCKED ON DB MIGRATION: `createSupabaseAlphaLadderStore` will fail at
 * runtime against production right now — migrations/001_alpha_ladder_
 * schema.sql has NOT been applied. This file is safe to import and test
 * (via the in-memory store) without that migration; it must not be
 * exercised against the real Supabase client until the migration is
 * applied and you've confirmed that.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Direction, ExecutionMode, LegSide, OptionRight, SignalRecord, SignalPath, SignedDirection } from '../types.ts';
import type { AccumulatorCheckpoint } from '../live/sessionAccumulator.ts';

export type CallKind = 'MONITOR' | 'STRUCTURE';
export type CallStatus = 'PUBLISHED' | 'LIVE' | 'EXIT_REQUESTED' | 'EXITING' | 'CLOSED' | 'LEFTOVER_ALERT';
export type LegStatus = 'IDLE' | 'SIZED' | 'PLACING' | 'GATING' | 'COMPLETE' | 'ROLLBACK' | 'ABANDONED';
export type ShadowOrderKind = 'ENTRY' | 'ROLLBACK_EXIT' | 'EXIT';
export type ShadowOrderFillStatus = 'PLACEMENT' | 'ACKNOWLEDGED' | 'OPEN' | 'COMPLETE' | 'REJECTED' | 'CANCELLED' | 'TIMEOUT';
export type PositionStatus = 'ACTIVE' | 'CLOSED' | 'CLOSE_FAILED' | 'STRUCTURE_RESOLUTION_FAILED';

export interface SignalRow extends SignalRecord {
  id: number;
}

export interface CallRow {
  id: number;
  signalId: number;
  kind: CallKind;
  status: CallStatus;
  direction: Direction;
  executionMode: ExecutionMode;
}

export interface PositionRow {
  id: number;
  callId: number;
  status: PositionStatus;
  exitReason: string | null;
  realizedPnl: number | null;
  netDebitPoints: number | null;
  units: number;
  lotSize: number;
}

export interface LegRow {
  id: number;
  positionId: number;
  placementOrder: number;
  side: LegSide;
  optionRight: OptionRight;
  strike: number;
  ratio: number;
  quantity: number;
  status: LegStatus;
}

export interface ShadowOrderRow {
  id: number;
  legId: number;
  orderKind: ShadowOrderKind;
  side: LegSide;
  quantity: number;
  fillPriceSimulated: number | null;
  fillStatus: ShadowOrderFillStatus;
  slippageVsReference: number | null;
}

export interface WorkerHealthRow {
  id: number;
  workerInstance: string;
  connectionGeneration: number;
  status: string;
  workerStartedAt: string;
  reconnectCount: number;
  currentInstrumentToken?: number | null;
  currentFutureSymbol?: string | null;
}

export interface AlphaLadderStore {
  // --- signals: Gate 5.4 idempotency, DB-enforced via a unique constraint on weekKey ---
  getSignalByWeekKey(weekKey: string): Promise<SignalRow | null>;
  insertSignal(row: SignalRecord): Promise<{ ok: true; row: SignalRow } | { ok: false; reason: 'duplicate' }>;

  // --- calls: one per (signalId, kind), DB-enforced ---
  getCall(signalId: number, kind: CallKind): Promise<CallRow | null>;
  insertCall(signalId: number, kind: CallKind, direction: Direction, executionMode: ExecutionMode): Promise<{ ok: true; row: CallRow } | { ok: false; reason: 'duplicate' }>;
  updateCallStatus(callId: number, status: CallStatus): Promise<void>;

  // --- positions/legs ---
  getPositionByCall(callId: number): Promise<PositionRow | null>;
  insertPosition(callId: number, fields: Omit<PositionRow, 'id' | 'callId'>): Promise<PositionRow>;
  updatePosition(positionId: number, patch: Partial<PositionRow>): Promise<void>;
  getLegs(positionId: number): Promise<LegRow[]>;
  insertLeg(positionId: number, fields: Omit<LegRow, 'id' | 'positionId'>): Promise<LegRow>;
  updateLegStatus(legId: number, status: LegStatus): Promise<void>;

  // --- shadow orders (entry/rollback/exit) ---
  getShadowOrders(legId: number, kind?: ShadowOrderKind): Promise<ShadowOrderRow[]>;
  insertShadowOrder(legId: number, fields: Omit<ShadowOrderRow, 'id' | 'legId'>): Promise<ShadowOrderRow>;

  // --- large-order reference threshold (Definition 13.3's durable state) ---
  getReferenceThreshold(side: 'b' | 'a'): Promise<{ cumulativeCount: number; runningThreshold: number }>;
  setReferenceThreshold(side: 'b' | 'a', state: { cumulativeCount: number; runningThreshold: number }): Promise<void>;

  // --- worker health ---
  insertWorkerHealth(row: Omit<WorkerHealthRow, 'id'>): Promise<WorkerHealthRow>;
  getLatestWorkerHealth(workerInstance: string): Promise<WorkerHealthRow | null>;

  // --- activity log ---
  logActivity(level: 'info' | 'error', message: string, detail?: unknown, callId?: number, positionId?: number): Promise<void>;

  // --- accumulator checkpoint (partial-bucket recovery) ---
  saveAccumulatorCheckpoint(sessionDate: string, checkpoint: AccumulatorCheckpoint): Promise<void>;
  loadAccumulatorCheckpoint(sessionDate: string): Promise<AccumulatorCheckpoint | null>;
}

// ---------------------------------------------------------------------------
// In-memory test double — enforces the same idempotency invariants the real
// migration's unique constraints do, without needing a live database.
// ---------------------------------------------------------------------------

export function createInMemoryAlphaLadderStore(): AlphaLadderStore {
  let signalId = 0;
  const signals: SignalRow[] = [];
  let callId = 0;
  const calls: CallRow[] = [];
  let positionId = 0;
  const positions: PositionRow[] = [];
  let legId = 0;
  const legs: LegRow[] = [];
  let shadowOrderId = 0;
  const shadowOrders: ShadowOrderRow[] = [];
  const referenceThresholds = new Map<'b' | 'a', { cumulativeCount: number; runningThreshold: number }>([
    ['b', { cumulativeCount: 0, runningThreshold: 0 }],
    ['a', { cumulativeCount: 0, runningThreshold: 0 }],
  ]);
  let workerHealthId = 0;
  const workerHealth: WorkerHealthRow[] = [];
  const activityLog: Array<{ level: string; message: string; detail?: unknown; callId?: number; positionId?: number }> = [];
  const checkpoints = new Map<string, AccumulatorCheckpoint>();

  return {
    async getSignalByWeekKey(weekKey) {
      return signals.find((s) => s.weekKey === weekKey) ?? null;
    },
    async insertSignal(row) {
      if (signals.some((s) => s.weekKey === row.weekKey)) return { ok: false, reason: 'duplicate' };
      const stored: SignalRow = { ...row, id: ++signalId };
      signals.push(stored);
      return { ok: true, row: stored };
    },
    async getCall(signalId_, kind) {
      return calls.find((c) => c.signalId === signalId_ && c.kind === kind) ?? null;
    },
    async insertCall(signalId_, kind, direction, executionMode) {
      if (calls.some((c) => c.signalId === signalId_ && c.kind === kind)) return { ok: false, reason: 'duplicate' };
      const stored: CallRow = { id: ++callId, signalId: signalId_, kind, status: 'PUBLISHED', direction, executionMode };
      calls.push(stored);
      return { ok: true, row: stored };
    },
    async updateCallStatus(callId_, status) {
      const c = calls.find((c) => c.id === callId_);
      if (c) c.status = status;
    },
    async getPositionByCall(callId_) {
      return positions.find((p) => p.callId === callId_) ?? null;
    },
    async insertPosition(callId_, fields) {
      const stored: PositionRow = { id: ++positionId, callId: callId_, ...fields };
      positions.push(stored);
      return stored;
    },
    async updatePosition(positionId_, patch) {
      const p = positions.find((p) => p.id === positionId_);
      if (p) Object.assign(p, patch);
    },
    async getLegs(positionId_) {
      return legs.filter((l) => l.positionId === positionId_).sort((a, b) => a.placementOrder - b.placementOrder);
    },
    async insertLeg(positionId_, fields) {
      const stored: LegRow = { id: ++legId, positionId: positionId_, ...fields };
      legs.push(stored);
      return stored;
    },
    async updateLegStatus(legId_, status) {
      const l = legs.find((l) => l.id === legId_);
      if (l) l.status = status;
    },
    async getShadowOrders(legId_, kind) {
      return shadowOrders.filter((o) => o.legId === legId_ && (kind === undefined || o.orderKind === kind));
    },
    async insertShadowOrder(legId_, fields) {
      const stored: ShadowOrderRow = { id: ++shadowOrderId, legId: legId_, ...fields };
      shadowOrders.push(stored);
      return stored;
    },
    async getReferenceThreshold(side) {
      return referenceThresholds.get(side)!;
    },
    async setReferenceThreshold(side, state) {
      referenceThresholds.set(side, state);
    },
    async insertWorkerHealth(row) {
      const stored: WorkerHealthRow = { id: ++workerHealthId, ...row };
      workerHealth.push(stored);
      return stored;
    },
    async getLatestWorkerHealth(workerInstance) {
      const rows = workerHealth.filter((w) => w.workerInstance === workerInstance);
      return rows.length ? rows[rows.length - 1] : null;
    },
    async logActivity(level, message, detail, callId, positionId) {
      activityLog.push({ level, message, detail, callId, positionId });
    },
    async saveAccumulatorCheckpoint(sessionDate, checkpoint) {
      checkpoints.set(sessionDate, checkpoint);
    },
    async loadAccumulatorCheckpoint(sessionDate) {
      return checkpoints.get(sessionDate) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Real Supabase-backed implementation. NOT exercised against production in
// this milestone — see this file's header. Column names match
// migrations/001_alpha_ladder_schema.sql exactly.
// ---------------------------------------------------------------------------

export function createSupabaseAlphaLadderStore(client: SupabaseClient): AlphaLadderStore {
  return {
    async getSignalByWeekKey(weekKey) {
      const { data } = await client.from('alpha_ladder_signals').select('*').eq('week_key', weekKey).maybeSingle();
      return data ? rowToSignal(data) : null;
    },
    async insertSignal(row) {
      const { data, error } = await client.from('alpha_ladder_signals').insert(signalToRow(row)).select('*').single();
      if (error) {
        if (error.code === '23505') return { ok: false, reason: 'duplicate' }; // unique_violation
        throw error;
      }
      return { ok: true, row: rowToSignal(data) };
    },
    async getCall(signalId, kind) {
      const { data } = await client.from('alpha_ladder_calls').select('*').eq('signal_id', signalId).eq('kind', kind).maybeSingle();
      return data ? rowToCall(data) : null;
    },
    async insertCall(signalId, kind, direction, executionMode) {
      const { data, error } = await client
        .from('alpha_ladder_calls')
        .insert({ signal_id: signalId, kind, direction, execution_mode: executionMode, status: 'PUBLISHED' })
        .select('*')
        .single();
      if (error) {
        if (error.code === '23505') return { ok: false, reason: 'duplicate' };
        throw error;
      }
      return { ok: true, row: rowToCall(data) };
    },
    async updateCallStatus(callId, status) {
      await client.from('alpha_ladder_calls').update({ status, updated_at: new Date().toISOString() }).eq('id', callId);
    },
    async getPositionByCall(callId) {
      const { data } = await client.from('alpha_ladder_positions').select('*').eq('call_id', callId).maybeSingle();
      return data ? rowToPosition(data) : null;
    },
    async insertPosition(callId, fields) {
      const { data } = await client.from('alpha_ladder_positions').insert({ call_id: callId, ...positionFieldsToRow(fields) }).select('*').single();
      return rowToPosition(data);
    },
    async updatePosition(positionId, patch) {
      await client.from('alpha_ladder_positions').update({ ...positionFieldsToRow(patch as any), updated_at: new Date().toISOString() }).eq('id', positionId);
    },
    async getLegs(positionId) {
      const { data } = await client.from('alpha_ladder_legs').select('*').eq('position_id', positionId).order('placement_order', { ascending: true });
      return (data ?? []).map(rowToLeg);
    },
    async insertLeg(positionId, fields) {
      const { data } = await client.from('alpha_ladder_legs').insert({ position_id: positionId, ...legFieldsToRow(fields) }).select('*').single();
      return rowToLeg(data);
    },
    async updateLegStatus(legId, status) {
      await client.from('alpha_ladder_legs').update({ status }).eq('id', legId);
    },
    async getShadowOrders(legId, kind) {
      let query = client.from('alpha_ladder_shadow_orders').select('*').eq('leg_id', legId);
      if (kind) query = query.eq('order_kind', kind);
      const { data } = await query;
      return (data ?? []).map(rowToShadowOrder);
    },
    async insertShadowOrder(legId, fields) {
      const { data } = await client.from('alpha_ladder_shadow_orders').insert({ leg_id: legId, ...shadowOrderFieldsToRow(fields) }).select('*').single();
      return rowToShadowOrder(data);
    },
    async getReferenceThreshold(side) {
      const { data } = await client.from('alpha_ladder_large_order_reference').select('*').eq('side', side).maybeSingle();
      return data ? { cumulativeCount: data.cumulative_count, runningThreshold: data.running_threshold } : { cumulativeCount: 0, runningThreshold: 0 };
    },
    async setReferenceThreshold(side, state) {
      await client.from('alpha_ladder_large_order_reference').upsert({ side, cumulative_count: state.cumulativeCount, running_threshold: state.runningThreshold, updated_at: new Date().toISOString() });
    },
    async insertWorkerHealth(row) {
      const { data } = await client
        .from('alpha_ladder_worker_health')
        .insert({
          worker_instance: row.workerInstance, connection_generation: row.connectionGeneration, status: row.status,
          worker_started_at: row.workerStartedAt, reconnect_count: row.reconnectCount,
          current_instrument_token: row.currentInstrumentToken ?? null, current_future_symbol: row.currentFutureSymbol ?? null,
        })
        .select('*')
        .single();
      return {
        id: data.id, workerInstance: data.worker_instance, connectionGeneration: data.connection_generation, status: data.status,
        workerStartedAt: data.worker_started_at, reconnectCount: data.reconnect_count,
        currentInstrumentToken: data.current_instrument_token, currentFutureSymbol: data.current_future_symbol,
      };
    },
    async getLatestWorkerHealth(workerInstance) {
      const { data } = await client.from('alpha_ladder_worker_health').select('*').eq('worker_instance', workerInstance).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      return data ? {
        id: data.id, workerInstance: data.worker_instance, connectionGeneration: data.connection_generation, status: data.status,
        workerStartedAt: data.worker_started_at, reconnectCount: data.reconnect_count,
        currentInstrumentToken: data.current_instrument_token, currentFutureSymbol: data.current_future_symbol,
      } : null;
    },
    async logActivity(level, message, detail, callId, positionId) {
      await client.from('alpha_ladder_activity_log').insert({ level, message, detail: detail ?? null, call_id: callId ?? null, position_id: positionId ?? null });
    },
    async saveAccumulatorCheckpoint(sessionDate, checkpoint) {
      await client.from('alpha_ladder_accumulator_checkpoint').upsert({
        session_date: sessionDate,
        session_origin_ms: checkpoint.sessionOriginMs,
        aggregate_snapshots: checkpoint.aggregateSnapshots,
        pending_interval_observations: checkpoint.pendingIntervalObservations,
        last_interval_end_ms: checkpoint.lastIntervalEndMs,
        reference_threshold_bid: checkpoint.referenceThresholds.b,
        reference_threshold_ask: checkpoint.referenceThresholds.a,
        pending_window_observations_bid: checkpoint.pendingWindowObservations.b,
        pending_window_observations_ask: checkpoint.pendingWindowObservations.a,
        last_window_folded_at_ms: checkpoint.lastWindowFoldedAtMs,
        updated_at: new Date().toISOString(),
      });
    },
    async loadAccumulatorCheckpoint(sessionDate) {
      const { data } = await client.from('alpha_ladder_accumulator_checkpoint').select('*').eq('session_date', sessionDate).maybeSingle();
      if (!data) return null;
      return {
        sessionOriginMs: data.session_origin_ms,
        aggregateSnapshots: data.aggregate_snapshots,
        pendingIntervalObservations: data.pending_interval_observations,
        lastIntervalEndMs: data.last_interval_end_ms,
        referenceThresholds: { b: data.reference_threshold_bid, a: data.reference_threshold_ask },
        pendingWindowObservations: { b: data.pending_window_observations_bid, a: data.pending_window_observations_ask },
        lastWindowFoldedAtMs: data.last_window_folded_at_ms,
      };
    },
  };
}

function rowToSignal(data: any): SignalRow {
  return {
    id: data.id, weekKey: data.week_key, signalDate: data.signal_date, signalInstantSec: Date.parse(data.signal_instant) / 1000,
    path: data.path as SignalPath, d1: data.d1 as SignedDirection, d2: data.d2 as SignedDirection, alpha: data.alpha,
    baseDirection: data.base_direction, finalDirection: data.final_direction, area1: data.area1, area2: data.area2,
    g1AtSignal: data.g1_at_signal, g2AtSignal: data.g2_at_signal, crossingTimeSec: data.crossing_time ? Date.parse(data.crossing_time) / 1000 : null,
    crossingG2Value: data.crossing_g2_value, vixValue: data.vix_value, vixAvailable: data.vix_available,
    variationCActed: data.variation_c_acted, sourceDataset: 'primary', createdAtMs: Date.parse(data.created_at),
  };
}
function signalToRow(row: SignalRecord) {
  return {
    week_key: row.weekKey, signal_date: row.signalDate, signal_instant: new Date(row.signalInstantSec * 1000).toISOString(),
    path: row.path, d1: row.d1, d2: row.d2, alpha: row.alpha, base_direction: row.baseDirection, final_direction: row.finalDirection,
    area1: row.area1, area2: row.area2, g1_at_signal: row.g1AtSignal, g2_at_signal: row.g2AtSignal,
    crossing_time: row.crossingTimeSec !== null ? new Date(row.crossingTimeSec * 1000).toISOString() : null,
    crossing_g2_value: row.crossingG2Value, vix_value: row.vixValue, vix_available: row.vixAvailable, variation_c_acted: row.variationCActed,
    strategy_version: 'HEDGED133_V3_0',
  };
}
function rowToCall(data: any): CallRow {
  return { id: data.id, signalId: data.signal_id, kind: data.kind, status: data.status, direction: data.direction, executionMode: data.execution_mode };
}
function rowToPosition(data: any): PositionRow {
  return { id: data.id, callId: data.call_id, status: data.status, exitReason: data.exit_reason, realizedPnl: data.realized_pnl, netDebitPoints: data.net_debit_points, units: data.units, lotSize: data.lot_size };
}
function positionFieldsToRow(fields: Partial<Omit<PositionRow, 'id' | 'callId'>>) {
  const out: Record<string, unknown> = {};
  if (fields.status !== undefined) out.status = fields.status;
  if (fields.exitReason !== undefined) out.exit_reason = fields.exitReason;
  if (fields.realizedPnl !== undefined) out.realized_pnl = fields.realizedPnl;
  if (fields.netDebitPoints !== undefined) out.net_debit_points = fields.netDebitPoints;
  if (fields.units !== undefined) out.units = fields.units;
  if (fields.lotSize !== undefined) out.lot_size = fields.lotSize;
  return out;
}
function rowToLeg(data: any): LegRow {
  return { id: data.id, positionId: data.position_id, placementOrder: data.placement_order, side: data.side, optionRight: data.option_right, strike: data.strike, ratio: data.ratio, quantity: data.quantity, status: data.status };
}
function legFieldsToRow(fields: Omit<LegRow, 'id' | 'positionId'>) {
  return { placement_order: fields.placementOrder, side: fields.side, option_right: fields.optionRight, strike: fields.strike, ratio: fields.ratio, quantity: fields.quantity, status: fields.status };
}
function rowToShadowOrder(data: any): ShadowOrderRow {
  return { id: data.id, legId: data.leg_id, orderKind: data.order_kind, side: data.side, quantity: data.quantity, fillPriceSimulated: data.fill_price_simulated, fillStatus: data.fill_status, slippageVsReference: data.slippage_vs_reference };
}
function shadowOrderFieldsToRow(fields: Omit<ShadowOrderRow, 'id' | 'legId'>) {
  return { order_kind: fields.orderKind, side: fields.side, quantity: fields.quantity, fill_price_simulated: fields.fillPriceSimulated, fill_status: fields.fillStatus, slippage_vs_reference: fields.slippageVsReference };
}
