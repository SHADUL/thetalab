/**
 * Detects drift between the Postgres checkpoint's recorded coverage and
 * the archive's actual coverage (VWAP_STORAGE_MIGRATION_PLAN.md task 13:
 * "archive ahead of checkpoint" / "checkpoint ahead of archive"). Both are
 * real failure modes once writes and checkpoint updates are two separate
 * steps: a crash between "archive write succeeded" and "checkpoint
 * updated" leaves the archive ahead; a crash the other way around (or a
 * stale/incorrectly-restored checkpoint) leaves the checkpoint ahead.
 *
 * Pure and side-effect-free — callers decide what to DO about drift
 * (refuse to resume, re-verify, alert); this only detects and classifies
 * it. Never silently proceeds as if the two agreed.
 */
export type CheckpointDriftStatus = 'CONSISTENT' | 'ARCHIVE_AHEAD_OF_CHECKPOINT' | 'CHECKPOINT_AHEAD_OF_ARCHIVE';

export function detectCheckpointArchiveDrift(
  checkpointLatestMs: number | null,
  archiveLatestMs: number | null,
): CheckpointDriftStatus {
  if (checkpointLatestMs === archiveLatestMs) return 'CONSISTENT';
  if (checkpointLatestMs === null) return 'ARCHIVE_AHEAD_OF_CHECKPOINT'; // archive has data, checkpoint claims none
  if (archiveLatestMs === null) return 'CHECKPOINT_AHEAD_OF_ARCHIVE'; // checkpoint claims coverage, archive has nothing
  if (archiveLatestMs > checkpointLatestMs) return 'ARCHIVE_AHEAD_OF_CHECKPOINT';
  return 'CHECKPOINT_AHEAD_OF_ARCHIVE';
}
