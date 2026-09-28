/**
 * Generic bounded retry for object-storage operations
 * (VWAP_STORAGE_MIGRATION_PLAN.md task 13: partial upload retry, network
 * timeout). Object-storage failures (a dropped connection, a transient
 * 5xx) are generically worth one or two retries — unlike Kite's
 * TRANSIENT/PERMANENT classification, there is no equivalent "this will
 * never succeed" signal from a plain upload/download call, so every
 * failure gets the same bounded number of attempts, then gives up and
 * reports the last error explicitly. Never retries forever.
 */
export async function withBoundedRetry<T extends { ok: true } | { error: string }>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 50,
): Promise<T> {
  let lastResult: T | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastResult = await fn();
    if (!('error' in lastResult)) return lastResult;
    if (attempt < attempts) await sleep(delayMs * attempt);
  }
  return lastResult as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
