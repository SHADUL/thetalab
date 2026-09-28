/**
 * DuckDB-based Parquet codec (VWAP_STORAGE_MIGRATION_PLAN.md §2/§4) — the
 * ONLY module that touches DuckDB directly. Writes/reads a LOCAL .parquet
 * file; uploading/downloading that file to/from wherever it actually
 * lives is `ObjectStorageClient`'s job (barArchiveStore.ts), not this
 * module's.
 *
 * KNOWN, WORKED-AROUND BUG: the `duckdb` npm package's Node binding
 * hard-CRASHES the process (a native abort, not a catchable JS
 * exception — `Napi::Error: Do not know how to serialize a BigInt`) if a
 * query result includes a raw BIGINT column. Confirmed by direct
 * reproduction this phase. Every read query in this file explicitly
 * CASTs `volume`/`instrument_token` to DOUBLE before returning — safe,
 * since neither value ever approaches 2^53 — and this must remain true
 * for any future query added here. Never remove this cast to "simplify"
 * the SQL; doing so reintroduces a process crash, not a bug report.
 */
import duckdb from 'duckdb';
import type { ArchiveBarRow } from './barArchiveStore.ts';

function withConnection<T>(fn: (conn: duckdb.Connection) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const db = new duckdb.Database(':memory:');
    const conn = db.connect();
    fn(conn).then(
      (result) => { conn.close(); resolve(result); },
      (err) => { conn.close(); reject(err); },
    );
  });
}

function run(conn: duckdb.Connection, sql: string): Promise<void> {
  return new Promise((resolve, reject) => conn.run(sql, (err: Error | null) => (err ? reject(err) : resolve())));
}

function all(conn: duckdb.Connection, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => conn.all(sql, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows))));
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/** Writes `rows` to a local Parquet file at `localFilePath`, ZSTD-compressed. Overwrites any existing file — the caller (barArchiveStore.ts) is what makes a re-run of the same partition idempotent, by always producing the identical output for the identical input rows. */
export async function writeParquetFile(localFilePath: string, rows: ArchiveBarRow[]): Promise<void> {
  await withConnection(async (conn) => {
    await run(conn, `
      CREATE TABLE bars (
        symbol VARCHAR, instrument_token BIGINT, ts TIMESTAMP, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
        volume BIGINT, oi BIGINT, source VARCHAR, ingestion_version VARCHAR
      );
    `);
    // Batched multi-row INSERT rather than one INSERT per row — a single
    // 60-day/one-symbol partition can be ~15,000-30,000 rows; one INSERT
    // per row would be needlessly slow for no benefit.
    const BATCH_SIZE = 2000;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const values = batch.map((r) =>
        `('${sqlEscape(r.symbol)}', ${r.instrumentToken}, '${new Date(r.t).toISOString()}', ${r.o}, ${r.h}, ${r.l}, ${r.c}, ${r.v}, ${r.oi ?? 'NULL'}, '${sqlEscape(r.source)}', '${sqlEscape(r.ingestionVersion)}')`,
      ).join(',\n');
      await run(conn, `INSERT INTO bars VALUES ${values};`);
    }
    await run(conn, `COPY bars TO '${sqlEscape(localFilePath)}' (FORMAT PARQUET, COMPRESSION ZSTD);`);
  });
}

/** Reads every row from a local Parquet file. Empty array (never an error) for a genuinely empty partition — a missing FILE is the caller's concern (barArchiveStore.ts's readBars checks existence first). */
export async function readParquetFile(localFilePath: string): Promise<ArchiveBarRow[]> {
  return withConnection(async (conn) => {
    // CAST(... AS DOUBLE) on every BIGINT column — see this file's own
    // header comment on why this is mandatory, not optional styling.
    const rows = await all(conn, `
      SELECT symbol, CAST(instrument_token AS DOUBLE) AS instrument_token, ts, open, high, low, close,
             CAST(volume AS DOUBLE) AS volume, oi, source, ingestion_version
      FROM read_parquet('${sqlEscape(localFilePath)}')
      ORDER BY ts;
    `);
    return rows.map((r): ArchiveBarRow => ({
      symbol: r.symbol, instrumentToken: Number(r.instrument_token), t: new Date(r.ts).getTime(),
      o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume),
      oi: r.oi === null ? null : Number(r.oi), source: r.source, ingestionVersion: r.ingestion_version,
    }));
  });
}
