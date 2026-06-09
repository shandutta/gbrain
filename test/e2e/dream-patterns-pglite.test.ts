/**
 * E2E patterns phase — PGLite, no API key required.
 *
 * Mirrors the per-test-rig pattern from dream-synthesize-pglite.test.ts.
 * Each test creates and tears down its own PGLite engine to avoid
 * cross-test contention (CLAUDE.md issue #223 macOS WASM bug).
 *
 * Covers the runPhasePatterns skip paths that don't require a real
 * Anthropic call:
 *   - disabled: dream.patterns.enabled=false → skipped
 *   - insufficient_evidence: <min_evidence reflections → skipped
 *   - dry-run: passes through with reflections_considered + zero pages
 *
 * Regression guard (removed no_api_key gate):
 *   - enough reflections + no ANTHROPIC_API_KEY → phase must NOT skip with
 *     reason 'no_api_key'; it proceeds to subagent submission instead.
 *
 * The Sonnet detection path is structurally covered in
 * test/cycle-patterns.test.ts (asserts queue + waitForCompletion are
 * wired, allow-list reads from filing-rules JSON, slug provenance from
 * subagent_tool_executions, no raw_data dependency).
 *
 * Run: bun test test/e2e/dream-patterns-pglite.test.ts
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhasePatterns } from '../../src/core/cycle/patterns.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';

interface TestRig {
  engine: PGLiteEngine;
  brainDir: string;
  cleanup: () => Promise<void>;
}

async function setupRig(): Promise<TestRig> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  return {
    engine,
    brainDir: '/tmp/gbrain-patterns-test',
    cleanup: async () => {
      try { await engine.disconnect(); } catch { /* */ }
    },
  };
}

async function withoutAnthropicKey<T>(body: () => Promise<T>): Promise<T> {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
}

/**
 * Insert N reflection pages directly via engine.putPage so the patterns
 * gather query has data without going through the synthesize phase.
 * Slugs follow the v0.23 wiki/personal/reflections/<topic>-<hash> shape.
 */
async function seedReflections(engine: PGLiteEngine, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const slug = `wiki/personal/reflections/2026-04-${String(15 + i).padStart(2, '0')}-test-pattern-aaa${i}`;
    await engine.putPage(slug, {
      type: 'note',
      title: `Reflection ${i}`,
      compiled_truth: `Sample reflection content ${i} discussing recurring theme of work-life balance.`,
      timeline: '',
      frontmatter: { type: 'note', title: `Reflection ${i}` },
    });
  }
}

describe('E2E patterns — disabled', () => {
  test('skipped when dream.patterns.enabled=false', async () => {
    // 30s timeout: a fresh PGLiteEngine + initSchema (36 migrations,
    // pgvector WASM cold start) clears in ~3s but spikes to 6-15s under
    // full-e2e-suite load contention. Default 5s timeout was eating the
    // happy path.
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.patterns.enabled', 'false');
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('disabled');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('default-enabled when config key unset', async () => {
    const rig = await setupRig();
    try {
      // No reflections seeded → falls through to insufficient_evidence,
      // not disabled. Confirms the default-true semantics.
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('insufficient_evidence');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E patterns — insufficient_evidence', () => {
  test('skipped with 0 reflections', async () => {
    const rig = await setupRig();
    try {
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('insufficient_evidence');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);

  test('skipped with reflections below min_evidence', async () => {
    const rig = await setupRig();
    try {
      await rig.engine.setConfig('dream.patterns.min_evidence', '5');
      await seedReflections(rig.engine, 3); // below 5
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: false,
      });
      expect(result.status).toBe('skipped');
      expect((result.details as { reason?: string }).reason).toBe('insufficient_evidence');
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E patterns — no API key gate removed (regression)', () => {
  test('enough reflections + no ANTHROPIC_API_KEY → does NOT skip with no_api_key', async () => {
    // Regression guard: the hard ANTHROPIC_API_KEY env-var gate was removed
    // so that non-Anthropic providers (DeepSeek, etc.) work. With enough
    // reflections and the phase enabled, the code must reach the subagent
    // submission step rather than returning an early skip.
    //
    // We spy on MinionQueue.prototype.add to intercept the submission and
    // throw a sentinel so the test completes quickly without a real worker.
    const rig = await setupRig();
    try {
      await seedReflections(rig.engine, 5); // above default min_evidence (3)

      const sentinel = new Error('__sentinel_queue_add_intercepted__');
      const addSpy = spyOn(MinionQueue.prototype, 'add').mockRejectedValue(sentinel);

      await withoutAnthropicKey(async () => {
        const result = await runPhasePatterns(rig.engine, {
          brainDir: rig.brainDir,
          dryRun: false,
        });
        // Must NOT be the removed skip reason.
        expect((result.details as { reason?: string }).reason).not.toBe('no_api_key');
        // The sentinel from queue.add propagates as a patterns_phase_fail,
        // proving the code reached the submission step.
        if (result.status === 'fail') {
          expect(result.error?.code).toBe('PATTERNS_PHASE_FAIL');
          expect(result.error?.message).toContain('__sentinel_queue_add_intercepted__');
        }
        // The spy must have been called (confirmed phase reached submission).
        expect(addSpy).toHaveBeenCalled();
      });

      addSpy.mockRestore();
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});

describe('E2E patterns — dry-run', () => {
  test('dry-run returns ok with reflections_considered and zero patterns_written', async () => {
    const rig = await setupRig();
    try {
      await seedReflections(rig.engine, 5);
      const result = await runPhasePatterns(rig.engine, {
        brainDir: rig.brainDir,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      expect((result.details as { dryRun: boolean }).dryRun).toBe(true);
      expect((result.details as { reflections_considered: number }).reflections_considered).toBe(5);
      expect((result.details as { patterns_written: number }).patterns_written).toBe(0);
    } finally {
      await rig.cleanup();
    }
  }, 30_000);
});
