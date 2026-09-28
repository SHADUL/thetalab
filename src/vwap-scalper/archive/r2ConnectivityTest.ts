/**
 * The connectivity test required before ANY real export or backfill write
 * (VWAP_STORAGE_MIGRATION_PLAN.md task 12): write one tiny synthetic
 * Parquet object to a throwaway key, read it back, verify byte-for-byte
 * row equality, list it, then delete it. Only reports
 * "R2 CONNECTIVITY: PASS" if every step succeeds — a partial success
 * (e.g. write worked but delete failed, leaving a stray object) is
 * reported as FAIL with the exact failing step named, never rounded up
 * to PASS.
 *
 * Generic over `ObjectStorageClient` + a delete function so the exact
 * same logic can be exercised against local filesystem in tests before
 * ever touching real R2 — this file does not hardcode R2 specifics.
 */
import fs from 'node:fs';
import os from 'node:crypto';
import path from 'node:path';
import type { ArchiveBarRow, ObjectStorageClient } from '../data/barArchiveStore.ts';
import { writeParquetFile, readParquetFile } from '../data/parquetCodec.ts';

export interface ConnectivityTestResult {
  pass: boolean;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
}

const SYNTHETIC_KEY_PREFIX = '_connectivity_test/';

function syntheticRow(): ArchiveBarRow {
  return {
    symbol: '__CONNECTIVITY_TEST__',
    instrumentToken: 1,
    t: Date.parse('2020-01-01T00:00:00.000Z'),
    o: 1, h: 2, l: 0.5, c: 1.5, v: 100,
    oi: null,
    source: 'KITE_HISTORICAL',
    ingestionVersion: 'connectivity-test',
  };
}

export async function runR2ConnectivityTest(
  client: ObjectStorageClient,
  deleteObject: (key: string) => Promise<{ ok: true } | { error: string }>,
  scratchDir: string,
): Promise<ConnectivityTestResult> {
  fs.mkdirSync(scratchDir, { recursive: true });
  const objectKey = `${SYNTHETIC_KEY_PREFIX}${os.randomUUID()}.parquet`;
  const localWrite = path.join(scratchDir, `${os.randomUUID()}-write.parquet`);
  const localRead = path.join(scratchDir, `${os.randomUUID()}-read.parquet`);
  const steps: ConnectivityTestResult['steps'] = [];
  const row = syntheticRow();

  try {
    try {
      await writeParquetFile(localWrite, [row]);
      steps.push({ step: 'write synthetic Parquet locally', ok: true });
    } catch (err: any) {
      steps.push({ step: 'write synthetic Parquet locally', ok: false, detail: err.message });
      return { pass: false, steps };
    }

    const uploadResult = await client.upload(objectKey, localWrite);
    if ('error' in uploadResult) {
      steps.push({ step: 'upload to backend', ok: false, detail: uploadResult.error });
      return { pass: false, steps };
    }
    steps.push({ step: 'upload to backend', ok: true });

    const existsAfterUpload = await client.exists(objectKey);
    steps.push({ step: 'exists() confirms the object after upload', ok: existsAfterUpload });
    if (!existsAfterUpload) return { pass: false, steps };

    const downloadResult = await client.download(objectKey, localRead);
    if ('error' in downloadResult) {
      steps.push({ step: 'download from backend', ok: false, detail: downloadResult.error });
      return { pass: false, steps };
    }
    steps.push({ step: 'download from backend', ok: true });

    let readRows: ArchiveBarRow[];
    try {
      readRows = await readParquetFile(localRead);
    } catch (err: any) {
      steps.push({ step: 'read downloaded Parquet', ok: false, detail: err.message });
      return { pass: false, steps };
    }

    const roundTripOk = readRows.length === 1 && JSON.stringify(readRows[0]) === JSON.stringify(row);
    steps.push({ step: 'byte-for-byte row equality after round trip', ok: roundTripOk, detail: roundTripOk ? undefined : JSON.stringify(readRows) });
    if (!roundTripOk) return { pass: false, steps };

    const listResult = await client.list(SYNTHETIC_KEY_PREFIX);
    const listedOk = 'ok' in listResult && listResult.paths.includes(objectKey);
    steps.push({ step: 'list() includes the uploaded object', ok: listedOk, detail: 'error' in listResult ? listResult.error : undefined });
    if (!listedOk) return { pass: false, steps };

    const deleteResult = await deleteObject(objectKey);
    if ('error' in deleteResult) {
      steps.push({ step: 'delete synthetic object', ok: false, detail: deleteResult.error });
      return { pass: false, steps };
    }
    steps.push({ step: 'delete synthetic object', ok: true });

    const existsAfterDelete = await client.exists(objectKey);
    steps.push({ step: 'exists() confirms deletion', ok: !existsAfterDelete });
    if (existsAfterDelete) return { pass: false, steps };

    return { pass: true, steps };
  } finally {
    fs.rmSync(localWrite, { force: true });
    fs.rmSync(localRead, { force: true });
  }
}
