import { describe, expect, test } from 'bun:test';
import { MIGRATIONS } from '../src/core/migrate.ts';

describe('migration v118 — autopilot fanout backpressure index', () => {
  const migration = MIGRATIONS.find(m => m.version === 118);

  test('is registered as the latest schema migration', () => {
    expect(migration).toBeDefined();
    expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBe(118);
  });

  test('creates a partial expression index for source-scoped active/waiting autopilot cycles', () => {
    expect(migration?.name).toBe('minion_autopilot_cycle_source_backpressure_index');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.transaction).toBe(false);

    const sql = migration?.sql ?? '';
    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_minion_jobs_autopilot_source_backpressure');
    expect(sql).toContain('ON minion_jobs (name, status, ((data->>\'source_id\')))');
    expect(sql).toContain("WHERE name = 'autopilot-cycle'");
    expect(sql).toContain("status IN ('waiting', 'active')");
  });

  test('has a non-concurrent PGLite variant', () => {
    const sql = migration?.sqlFor?.pglite ?? '';
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_minion_jobs_autopilot_source_backpressure');
    expect(sql).not.toContain('CONCURRENTLY');
    expect(sql).toContain('((data->>\'source_id\'))');
  });
});
