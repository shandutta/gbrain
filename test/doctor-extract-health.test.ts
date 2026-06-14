// v0.42 — Doctor extract_health check unit tests.
//
// Pins:
//   - Empty rollup → OK with kinds: []
//   - Per-kind halt rate > 10% → WARN with top-3 kinds in message
//   - rollup_write_failures > 0 → WARN (when halt rates are clean)
//   - Pre-v106 brain (no extract_rollup_7d table) → OK (best-effort)
//   - JSON envelope stamps schema_version: 1
//   - last_updated_at coerces to ISO string regardless of engine

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeExtractHealthCheck } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function clearRollup() {
  await engine.executeRaw('DELETE FROM extract_rollup_7d', []);
  await engine.executeRaw('DELETE FROM atom_extraction_attempts', []);
}

describe('computeExtractHealthCheck — empty + happy paths', () => {
  test('empty rollup returns OK with empty kinds array', async () => {
    await clearRollup();
    const check = await computeExtractHealthCheck(engine);
    expect(check.name).toBe('extract_health');
    expect(check.status).toBe('ok');
    expect(check.message).toBe('no extractions in last 7 days');
    expect((check.details as any)?.schema_version).toBe(1);
    expect((check.details as any)?.kinds).toEqual([]);
  });

  test('healthy rollup (zero halts) returns OK with kind aggregates', async () => {
    await clearRollup();
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d (kind, source_id, day, cost_usd, eval_pass_count, eval_fail_count, halt_count, round_completed_count, rollup_write_failures, updated_at)
       VALUES ('facts.conversation', 'default', CURRENT_DATE, 1.23, 5, 0, 0, 10, 0, NOW())`,
      [],
    );
    const check = await computeExtractHealthCheck(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('1 kind(s) tracked');
    expect((check.details as any)?.kinds).toHaveLength(1);
    expect((check.details as any)?.kinds[0].kind).toBe('facts.conversation');
    expect((check.details as any)?.kinds[0].cost_7d_usd).toBeCloseTo(1.23, 4);
    expect((check.details as any)?.kinds[0].halt_rate).toBe(0);
  });
});

describe('computeExtractHealthCheck — WARN paths', () => {
  test('halt rate > 10% on one kind returns WARN with top-3 in message', async () => {
    await clearRollup();
    // facts.conversation: 5 halts, 5 completed = 50% halt rate (WARN)
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d (kind, source_id, day, cost_usd, eval_pass_count, eval_fail_count, halt_count, round_completed_count, rollup_write_failures, updated_at)
       VALUES ('facts.conversation', 'default', CURRENT_DATE, 0.50, 5, 0, 5, 5, 0, NOW())`,
      [],
    );
    const check = await computeExtractHealthCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('halt rate');
    expect(check.message).toContain('facts.conversation');
    expect(check.message).toContain('50');
    expect((check.details as any)?.kinds[0].halt_rate).toBe(0.5);
  });

  test('multiple kinds with high halt rate: top-3 listed in message', async () => {
    await clearRollup();
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d (kind, source_id, day, cost_usd, eval_pass_count, eval_fail_count, halt_count, round_completed_count, rollup_write_failures, updated_at)
       VALUES
         ('atoms', 'default', CURRENT_DATE, 0.10, 0, 0, 3, 7, 0, NOW()),
         ('facts.conversation', 'default', CURRENT_DATE, 0.40, 0, 0, 5, 5, 0, NOW()),
         ('concepts', 'default', CURRENT_DATE, 0.05, 0, 0, 2, 8, 0, NOW())`,
      [],
    );
    const check = await computeExtractHealthCheck(engine);
    expect(check.status).toBe('warn');
    // Top-3 by halt rate: facts.conversation (50%), atoms (30%), concepts (20%)
    expect(check.message).toContain('facts.conversation');
    expect(check.message).toContain('atoms');
    expect(check.message).toContain('concepts');
  });

  test('atoms halt rate uses extraction attempt ledger successes as denominator', async () => {
    await clearRollup();
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d (kind, source_id, day, cost_usd, eval_pass_count, eval_fail_count, halt_count, round_completed_count, rollup_write_failures, updated_at)
       VALUES ('atoms', 'default', CURRENT_DATE, 0.35, 0, 0, 3, 2, 0, NOW())`,
      [],
    );
    for (let i = 0; i < 82; i++) {
      await engine.executeRaw(
        `INSERT INTO atom_extraction_attempts (source_id, source_slug, content_hash16, status, attempted_at)
         VALUES ('default', 'page-' || $1, 'hash-' || $1, 'extracted', NOW())`,
        [String(i).padStart(2, '0')],
      );
    }
    const check = await computeExtractHealthCheck(engine);
    expect(check.status).toBe('ok');
    expect((check.details as any)?.kinds[0].attempt_success_count).toBe(82);
    expect((check.details as any)?.kinds[0].attempt_failure_count).toBe(0);
    expect((check.details as any)?.kinds[0].suppressed_halt_count).toBe(3);
    expect((check.details as any)?.kinds[0].halt_rate).toBe(0);
  });

  test('atoms halt rate still warns when current attempt ledger has failures', async () => {
    await clearRollup();
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d (kind, source_id, day, cost_usd, eval_pass_count, eval_fail_count, halt_count, round_completed_count, rollup_write_failures, updated_at)
       VALUES ('atoms', 'default', CURRENT_DATE, 0.35, 0, 0, 3, 2, 0, NOW())`,
      [],
    );
    await engine.executeRaw(
      `INSERT INTO atom_extraction_attempts (source_id, source_slug, content_hash16, status, attempted_at)
       VALUES ('default', 'page-ok', 'hash-ok', 'extracted', NOW()),
              ('default', 'page-fail', 'hash-fail', 'failed', NOW())`,
      [],
    );
    const check = await computeExtractHealthCheck(engine);
    expect(check.status).toBe('warn');
    expect((check.details as any)?.kinds[0].attempt_success_count).toBe(1);
    expect((check.details as any)?.kinds[0].attempt_failure_count).toBe(1);
    expect((check.details as any)?.kinds[0].suppressed_halt_count).toBeUndefined();
  });

  test('rollup_write_failures > 0 with clean halt rates returns WARN', async () => {
    await clearRollup();
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d (kind, source_id, day, cost_usd, eval_pass_count, eval_fail_count, halt_count, round_completed_count, rollup_write_failures, updated_at)
       VALUES ('atoms', 'default', CURRENT_DATE, 0.20, 5, 0, 0, 10, 3, NOW())`,
      [],
    );
    const check = await computeExtractHealthCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('rollup write failure');
    expect((check.details as any)?.rollup_write_failures_7d).toBe(3);
  });

  test('high halt rate precedes rollup write failure warn message', async () => {
    // High halt rate is the more critical signal; should win the message.
    await clearRollup();
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d (kind, source_id, day, cost_usd, eval_pass_count, eval_fail_count, halt_count, round_completed_count, rollup_write_failures, updated_at)
       VALUES ('atoms', 'default', CURRENT_DATE, 0.20, 0, 0, 5, 5, 3, NOW())`,
      [],
    );
    const check = await computeExtractHealthCheck(engine);
    expect(check.status).toBe('warn');
    // halt rate WARN takes precedence over rollup WARN
    expect(check.message).toContain('halt rate');
    // rollup failures still in details for forensic recovery
    expect((check.details as any)?.rollup_write_failures_7d).toBe(3);
  });
});

describe('computeExtractHealthCheck — 7-day window', () => {
  test('rows older than 7 days are excluded from aggregation', async () => {
    await clearRollup();
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d (kind, source_id, day, cost_usd, eval_pass_count, eval_fail_count, halt_count, round_completed_count, rollup_write_failures, updated_at)
       VALUES
         ('atoms', 'default', CURRENT_DATE - 30, 100.0, 0, 0, 100, 100, 0, NOW() - INTERVAL '30 days')`,
      [],
    );
    const check = await computeExtractHealthCheck(engine);
    // Old row outside 7-day window → empty result
    expect(check.status).toBe('ok');
    expect(check.message).toBe('no extractions in last 7 days');
  });

  test('rows exactly at day = CURRENT_DATE - 7 ARE included', async () => {
    await clearRollup();
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d (kind, source_id, day, cost_usd, eval_pass_count, eval_fail_count, halt_count, round_completed_count, rollup_write_failures, updated_at)
       VALUES ('atoms', 'default', CURRENT_DATE - 7, 0.50, 5, 0, 0, 10, 0, NOW())`,
      [],
    );
    const check = await computeExtractHealthCheck(engine);
    expect(check.status).toBe('ok');
    expect((check.details as any)?.kinds).toHaveLength(1);
  });
});
