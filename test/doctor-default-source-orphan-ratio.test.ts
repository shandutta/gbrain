/**
 * Tests for the `default_source_orphan_ratio` doctor check.
 *
 * This check surfaces pages in source_id='default' that have no inbound
 * wikilinks — the human-visible graph health signal. It is distinct from:
 *   - `orphan_ratio`  : entity-scoped, brain-wide, entity-count-gated
 *   - `orphan_pages`  : islanded pages (no inbound AND no outbound)
 *
 * Regression: large default sources with ~45% no-inbound pages must NOT
 * produce status 'ok', preventing the false-assurance pattern that originally
 * hid Obsidian graph debt behind `orphan_pages: 0`.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runDoctor, type DoctorReport } from '../src/commands/doctor.ts';
import { setCliOptions } from '../src/core/cli-options.ts';
import { BRAIN_CHECK_NAMES } from '../src/core/doctor-categories.ts';
import { readFileSync } from 'node:fs';

let engine: PGLiteEngine;
let stdoutBuffer: string[];
const origLog = console.log;
const origErr = console.error;
const origExit = process.exit;

function captureCli(): void {
  stdoutBuffer = [];
  console.log = (msg?: unknown) => { stdoutBuffer.push(typeof msg === 'string' ? msg : String(msg)); };
  console.error = () => {};
  (process as { exit: unknown }).exit = (() => { throw new Error('__exit'); }) as unknown as typeof process.exit;
}

function restoreCli(): void {
  console.log = origLog;
  console.error = origErr;
  (process as { exit: unknown }).exit = origExit;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  restoreCli();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
});

async function runDoctorJson(): Promise<DoctorReport> {
  captureCli();
  try {
    await runDoctor(engine, ['--json']);
  } catch (e) {
    if (!(e instanceof Error && e.message === '__exit')) throw e;
  } finally {
    restoreCli();
  }
  for (let i = stdoutBuffer.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(stdoutBuffer[i]!);
      if (parsed && typeof parsed === 'object' && 'checks' in parsed) {
        return parsed as DoctorReport;
      }
    } catch {
      // skip non-JSON lines
    }
  }
  throw new Error('No DoctorReport JSON found in stdout');
}

function findCheck(report: DoctorReport, name: string) {
  return report.checks.find(c => c.name === name);
}

async function putDefaultPage(slug: string, type = 'note') {
  await engine.putPage(slug, {
    type,
    title: slug,
    compiled_truth: 'x',
    timeline: '',
    frontmatter: {},
  });
  // Force source_id='default'
  await engine.executeRaw(
    `UPDATE pages SET source_id = 'default' WHERE slug = $1`,
    [slug],
  );
}

describe('default_source_orphan_ratio doctor check', () => {
  test('empty brain → vacuous ok', async () => {
    const report = await runDoctorJson();
    const check = findCheck(report, 'default_source_orphan_ratio');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toMatch(/vacuous/i);
  });

  test('appears in check list (JSON envelope shape)', async () => {
    const report = await runDoctorJson();
    const names = report.checks.map(c => c.name);
    expect(names).toContain('default_source_orphan_ratio');
  });

  test('low no-inbound ratio (≤35%) → status ok', async () => {
    // Seed 60 default-source pages, link most of them inbound.
    for (let i = 0; i < 60; i++) {
      await putDefaultPage(`wiki/page-${i}`);
    }
    await putDefaultPage('index/hub');
    // Add inbound links to 55 of the 60 pages (~8% orphan ratio).
    const links = [];
    for (let i = 0; i < 55; i++) {
      links.push({
        from_slug: 'index/hub',
        to_slug: `wiki/page-${i}`,
        link_type: 'mentions',
        link_source: 'markdown',
        context: '',
      });
    }
    await engine.addLinksBatch(links);
    const report = await runDoctorJson();
    const check = findCheck(report, 'default_source_orphan_ratio');
    expect(check!.status).toBe('ok');
    expect(check!.message).toMatch(/no-inbound ratio/i);
  });

  test('moderate no-inbound ratio (>35%, ≤70%) → status warn', async () => {
    // Seed 100 pages, link only ~50% inbound.
    for (let i = 0; i < 100; i++) {
      await putDefaultPage(`bookmarks/bk-${i}`);
    }
    await putDefaultPage('index/hub');
    const links = [];
    for (let i = 0; i < 50; i++) {
      links.push({
        from_slug: 'index/hub',
        to_slug: `bookmarks/bk-${i}`,
        link_type: 'mentions',
        link_source: 'markdown',
        context: '',
      });
    }
    await engine.addLinksBatch(links);
    const report = await runDoctorJson();
    const check = findCheck(report, 'default_source_orphan_ratio');
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('gbrain orphans --source default');
  });

  test('very high no-inbound ratio (>70%) → status fail', async () => {
    // Seed 100 pages, link only 10% inbound.
    for (let i = 0; i < 100; i++) {
      await putDefaultPage(`archive/ar-${i}`);
    }
    await putDefaultPage('index/hub');
    const links = [];
    for (let i = 0; i < 10; i++) {
      links.push({
        from_slug: 'index/hub',
        to_slug: `archive/ar-${i}`,
        link_type: 'mentions',
        link_source: 'markdown',
        context: '',
      });
    }
    await engine.addLinksBatch(links);
    const report = await runDoctorJson();
    const check = findCheck(report, 'default_source_orphan_ratio');
    expect(check!.status).toBe('fail');
    expect(check!.message).toContain('no-inbound ratio');
  });

  test('REGRESSION: 45% no-inbound must NOT be ok (false-assurance prevention)', async () => {
    // Simulate the ~1395/3089 situation: 100 pages, ~45% no inbound.
    for (let i = 0; i < 100; i++) {
      await putDefaultPage(`mixed/page-${i}`);
    }
    await putDefaultPage('index/hub');
    const links = [];
    for (let i = 0; i < 55; i++) {
      links.push({
        from_slug: 'index/hub',
        to_slug: `mixed/page-${i}`,
        link_type: 'mentions',
        link_source: 'markdown',
        context: '',
      });
    }
    await engine.addLinksBatch(links);
    const report = await runDoctorJson();
    const check = findCheck(report, 'default_source_orphan_ratio');
    // 45/100 ≈ 45% > 35% threshold → must warn or fail, never ok.
    expect(check!.status).not.toBe('ok');
  });

  test('check is categorized as brain (not meta/ops/skill)', async () => {
    expect(BRAIN_CHECK_NAMES.has('default_source_orphan_ratio')).toBe(true);
  });

  test('message includes top-domain breakdown when there are no-inbound pages', async () => {
    for (let i = 0; i < 80; i++) {
      await putDefaultPage(`bookmarks/bk-${i}`);
    }
    await putDefaultPage('index/hub');
    // Leave 60 un-linked → 60/80 = 75% → fail
    const links = [];
    for (let i = 0; i < 20; i++) {
      links.push({
        from_slug: 'index/hub',
        to_slug: `bookmarks/bk-${i}`,
        link_type: 'mentions',
        link_source: 'markdown',
        context: '',
      });
    }
    await engine.addLinksBatch(links);
    const report = await runDoctorJson();
    const check = findCheck(report, 'default_source_orphan_ratio');
    // Should include domain info in message.
    expect(check!.message).toContain('bookmarks');
  });
});

describe('default_source_orphan_ratio source contract', () => {
  test('check name appears in doctor.ts source', () => {
    const doctor = readFileSync('src/commands/doctor.ts', 'utf8');
    expect(doctor).toContain("name: 'default_source_orphan_ratio'");
  });

  test('check references the right fix command', () => {
    const doctor = readFileSync('src/commands/doctor.ts', 'utf8');
    expect(doctor).toContain('gbrain orphans --source default');
  });
});
