/**
 * Chooses which `ObjectStorageClient` backs the VWAP bar archive
 * (VWAP_STORAGE_MIGRATION_PLAN.md, decision: R2 is production, local
 * filesystem is dev/test only). This is the ONLY place that reads
 * `VWAP_ARCHIVE_BACKEND` / decides LOCAL-vs-R2 — nothing else in the
 * archive pipeline should branch on backend.
 *
 * Fail-closed rules, deliberately strict:
 *   - backend=R2 with any required R2_* env var missing -> throws. Never
 *     silently falls back to local filesystem.
 *   - backend=LOCAL in a production environment (NODE_ENV=production /
 *     VERCEL_ENV=production) -> throws unless
 *     VWAP_ALLOW_LOCAL_ARCHIVE_IN_PRODUCTION=true is explicitly set. This
 *     is an intentional escape hatch for a deliberate override, not a
 *     default anyone should reach for.
 */
import type { ObjectStorageClient } from '../data/barArchiveStore.ts';
import { createR2ObjectStorage, readR2ConfigFromEnv } from './r2ObjectStorage.ts';
import { createLocalObjectStorage } from '../data/localObjectStorage.ts';

export type ArchiveBackend = 'LOCAL' | 'R2';

function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}

export function resolveArchiveBackend(): ArchiveBackend {
  const raw = process.env.VWAP_ARCHIVE_BACKEND;
  if (raw !== 'LOCAL' && raw !== 'R2') {
    throw new Error(`VWAP_ARCHIVE_BACKEND must be set to exactly "LOCAL" or "R2" (got: ${raw === undefined ? 'unset' : JSON.stringify(raw)})`);
  }
  return raw;
}

/**
 * Builds the `ObjectStorageClient` for the configured backend. Throws
 * rather than degrading — a caller that wants a soft failure must catch
 * this itself and decide, explicitly, what to do; this function never
 * makes that decision silently.
 */
export function createConfiguredObjectStorage(localRootDirForDevTest?: string): ObjectStorageClient {
  const backend = resolveArchiveBackend();

  if (backend === 'LOCAL') {
    const allowedInProduction = process.env.VWAP_ALLOW_LOCAL_ARCHIVE_IN_PRODUCTION === 'true';
    if (isProductionEnvironment() && !allowedInProduction) {
      throw new Error(
        'VWAP_ARCHIVE_BACKEND=LOCAL is rejected in a production environment. ' +
        'Local filesystem is dev/test only. Set VWAP_ARCHIVE_BACKEND=R2, or, ' +
        'if you are certain, explicitly set VWAP_ALLOW_LOCAL_ARCHIVE_IN_PRODUCTION=true.',
      );
    }
    if (!localRootDirForDevTest) {
      throw new Error('VWAP_ARCHIVE_BACKEND=LOCAL requires a local root directory to be provided by the caller.');
    }
    return createLocalObjectStorage(localRootDirForDevTest);
  }

  // backend === 'R2': readR2ConfigFromEnv() itself throws on any missing
  // credential — that IS the fail-closed behavior; nothing to catch here.
  const config = readR2ConfigFromEnv();
  return createR2ObjectStorage(config);
}
