import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkTimelineCoverage } from '../src/core/onboard/checks.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function resetBrain(): Promise<void> {
  await engine.executeRaw('DELETE FROM timeline_entries', []);
  await engine.executeRaw('DELETE FROM pages', []);
}

async function seedEntity(slug: string, withTimeline = false): Promise<void> {
  await engine.putPage(slug, {
    type: 'person',
    title: slug.split('/').pop(),
    compiled_truth: 'Profile page.',
  });
  if (withTimeline) {
    await engine.addTimelineEntry(slug, {
      date: '2026-06-14',
      summary: 'Source-backed profile event.',
      source: 'test fixture',
    });
  }
}

describe('checkTimelineCoverage residual threshold', () => {
  test('small absolute residual stays ok instead of demanding noisy synthetic timelines', async () => {
    await resetBrain();
    for (let i = 0; i < 18; i++) await seedEntity(`people/covered-${i}`, true);
    for (let i = 0; i < 9; i++) await seedEntity(`people/lightweight-${i}`, false);

    const result = await checkTimelineCoverage(engine);
    expect(result.check.status).toBe('ok');
    expect(result.check.message).toContain('9 entity page(s) without timelines; below action threshold');
    expect(result.remediations).toHaveLength(0);
  });

  test('large residual still warns and emits extraction remediation', async () => {
    await resetBrain();
    for (let i = 0; i < 18; i++) await seedEntity(`people/covered-${i}`, true);
    for (let i = 0; i < 11; i++) await seedEntity(`people/missing-${i}`, false);

    const result = await checkTimelineCoverage(engine);
    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('target 90%');
    expect(result.remediations[0]?.id).toBe('onboard.extract_timeline_from_meetings');
    expect(result.remediations[0]?.rationale).toContain('N=11 entity page(s)');
  });
});
