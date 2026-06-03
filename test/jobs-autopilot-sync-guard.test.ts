import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const JOBS_SRC = readFileSync(join(import.meta.dir, '..', 'src/commands/jobs.ts'), 'utf8');
const AUTOPILOT_SRC = readFileSync(join(import.meta.dir, '..', 'src/commands/autopilot.ts'), 'utf8');
const FANOUT_SRC = readFileSync(join(import.meta.dir, '..', 'src/commands/autopilot-fanout.ts'), 'utf8');

describe('autopilot sync overlap guard', () => {
  test('autopilot freshness sync jobs are marked as backstop jobs', () => {
    expect(AUTOPILOT_SRC).toContain('autopilot_freshness: true');
    expect(AUTOPILOT_SRC).toContain('syncBackstopSeconds');
    expect(AUTOPILOT_SRC).toContain('autopilot.sync_freshness_floor_min');
  });

  test('sync handler skips autopilot freshness jobs when a per-source sync lock is already held', () => {
    expect(JOBS_SRC).toContain('job.data.autopilot_freshness === true');
    expect(JOBS_SRC).toContain('inspectLock(engine, syncLockId(sourceIdForJob))');
    expect(JOBS_SRC).toContain("status: 'skipped_lock_held'");
  });

  test('autopilot freshness sync cadence has a floor above the normal autopilot tick', () => {
    expect(FANOUT_SRC).toContain('SYNC_FRESHNESS_FLOOR_MIN');
    expect(FANOUT_SRC).toContain('isSourceSyncStale');
    expect(FANOUT_SRC).toContain('readLastSyncAt');
  });
});
