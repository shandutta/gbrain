/**
 * Tests for the dual orphan semantics added to runPhaseOrphans:
 *   - zero_inbound_count: no inbound links (matches `gbrain orphans` / findOrphans)
 *   - fully_islanded_count: no inbound AND no outbound (matches BrainHealth.orphan_pages)
 *
 * Key invariant: a page with only outgoing links appears in zero_inbound_count
 * but NOT in fully_islanded_count. A page with no links at all appears in both.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';

let engine: PGLiteEngine;

beforeEach(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterEach(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

async function seedPage(slug: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'concept',
    title: slug,
    compiled_truth: `Page: ${slug}`,
    timeline: '',
  });
}

async function runOrphansPhase(): Promise<{ zero_inbound_count: number; fully_islanded_count: number; total_orphans: number }> {
  const report = await runCycle(engine, { phases: ['orphans'], brainDir: null });
  const orphansPhase = report.phases.find((p) => p.phase === 'orphans');
  if (!orphansPhase?.details) throw new Error('orphans phase missing or no details');
  return {
    zero_inbound_count: Number(orphansPhase.details.zero_inbound_count ?? 0),
    fully_islanded_count: Number(orphansPhase.details.fully_islanded_count ?? 0),
    total_orphans: Number(orphansPhase.details.total_orphans ?? 0),
  };
}

describe('cycle orphans phase dual semantics', () => {
  test('outbound-only page: zero-inbound but NOT fully-islanded', async () => {
    // concepts/source links to concepts/target, but nothing links back to concepts/source.
    // source: zero inbound (orphan by `gbrain orphans` definition)
    //         but has outbound → not fully-islanded (not counted by `gbrain health`)
    await seedPage('concepts/source');
    await seedPage('concepts/target');
    await engine.addLink('concepts/source', 'concepts/target', 'mentioned', 'references', 'markdown');

    const { zero_inbound_count, fully_islanded_count, total_orphans } = await runOrphansPhase();

    // concepts/source is zero-inbound → should be in zero_inbound_count
    expect(zero_inbound_count).toBeGreaterThanOrEqual(1);
    // total_orphans is back-compat alias for zero_inbound_count
    expect(total_orphans).toBe(zero_inbound_count);
    // concepts/source has an outbound link → must NOT appear in fully_islanded_count
    expect(fully_islanded_count).toBe(0);
  });

  test('unlinked page: both zero-inbound AND fully-islanded', async () => {
    // concepts/lonely has no links in either direction — counted by both metrics.
    await seedPage('concepts/lonely');

    const { zero_inbound_count, fully_islanded_count } = await runOrphansPhase();

    expect(zero_inbound_count).toBeGreaterThanOrEqual(1);
    expect(fully_islanded_count).toBeGreaterThanOrEqual(1);
  });

  test('fully_islanded_count <= zero_inbound_count always', async () => {
    // Set up a mix: one isolated page and one outbound-only page.
    await seedPage('concepts/isolated');
    await seedPage('concepts/emitter');
    await seedPage('concepts/receiver');
    await engine.addLink('concepts/emitter', 'concepts/receiver', 'mentioned', 'references', 'markdown');

    const { zero_inbound_count, fully_islanded_count } = await runOrphansPhase();

    // Invariant: fully islanded is always a subset of zero-inbound.
    expect(fully_islanded_count).toBeLessThanOrEqual(zero_inbound_count);
  });

  test('CycleReport.totals includes fully_islanded_found', async () => {
    await seedPage('concepts/orphaned');

    const report = await runCycle(engine, { phases: ['orphans'], brainDir: null });

    expect(typeof report.totals.fully_islanded_found).toBe('number');
    expect(report.totals.fully_islanded_found).toBeGreaterThanOrEqual(1);
    expect(report.totals.orphans_found).toBeGreaterThanOrEqual(1);
  });

  test('total_orphans back-compat key matches zero_inbound_count', async () => {
    await seedPage('concepts/alpha');

    const { zero_inbound_count, total_orphans } = await runOrphansPhase();

    expect(total_orphans).toBe(zero_inbound_count);
  });

  test('empty brain: both counts are zero', async () => {
    const { zero_inbound_count, fully_islanded_count } = await runOrphansPhase();

    expect(zero_inbound_count).toBe(0);
    expect(fully_islanded_count).toBe(0);
  });
});
