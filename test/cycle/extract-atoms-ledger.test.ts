/**
 * Tests for atom_extraction_attempts ledger semantics.
 *
 * Covers:
 *  1. skipped ledger entry excludes a page from countExtractAtomsBacklog
 *  2. extracted ledger entry excludes a page from countExtractAtomsBacklog
 *  3. failed ledger entry keeps the page in the backlog (retryable)
 *  4. content_hash change makes a skipped/extracted page eligible again
 *  5. upsertAtomExtractionAttempt is idempotent (UPSERT semantics)
 *  6. skipped page excluded from scoped (per-source) backlog count
 *
 * Integration tests for runPhaseExtractAtoms ledger writes are in
 * test/extract-atoms-page-discovery.test.ts (that file already imports
 * the phase function; the 'ai' package gateway is wired there).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  countExtractAtomsBacklog,
  upsertAtomExtractionAttempt,
} from '../../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const BODY = 'x'.repeat(600); // >= MIN_PAGE_CHARS_FOR_EXTRACTION (500)

async function seedArticle(slug: string): Promise<void> {
  await engine.putPage(slug, { type: 'article', title: slug, compiled_truth: BODY });
}

async function getHash(slug: string): Promise<string> {
  const rows = await engine.executeRaw<{ content_hash: string }>(
    `SELECT content_hash FROM pages WHERE slug = $1 AND source_id = 'default'`,
    [slug],
  );
  return rows[0]?.content_hash ?? '';
}

// ────────────────────────────────────────────────────────────────────────────
describe('upsertAtomExtractionAttempt + countExtractAtomsBacklog ledger semantics', () => {
  test('skipped ledger entry excludes the page from brain-wide backlog', async () => {
    await seedArticle('article-a');
    const hash = await getHash('article-a');
    expect(await countExtractAtomsBacklog(engine)).toBe(1);

    await upsertAtomExtractionAttempt(engine, {
      sourceId: 'default',
      sourceSlug: 'article-a',
      contentHash16: hash.slice(0, 16),
      status: 'skipped',
      reason: 'empty_model_output',
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  });

  test('skipped ledger entry excludes the page from scoped (per-source) backlog', async () => {
    await seedArticle('article-scope');
    const hash = await getHash('article-scope');
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);

    await upsertAtomExtractionAttempt(engine, {
      sourceId: 'default',
      contentHash16: hash.slice(0, 16),
      status: 'skipped',
    });
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
  });

  test('extracted ledger entry excludes the page from backlog', async () => {
    await seedArticle('article-b');
    const hash = await getHash('article-b');
    expect(await countExtractAtomsBacklog(engine)).toBe(1);

    await upsertAtomExtractionAttempt(engine, {
      sourceId: 'default',
      sourceSlug: 'article-b',
      contentHash16: hash.slice(0, 16),
      status: 'extracted',
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  });

  test('failed ledger entry keeps the page in the backlog (retryable)', async () => {
    await seedArticle('article-c');
    const hash = await getHash('article-c');
    expect(await countExtractAtomsBacklog(engine)).toBe(1);

    await upsertAtomExtractionAttempt(engine, {
      sourceId: 'default',
      sourceSlug: 'article-c',
      contentHash16: hash.slice(0, 16),
      status: 'failed',
      error: 'network timeout',
    });
    // 'failed' must NOT exclude from backlog — the next cycle should retry.
    expect(await countExtractAtomsBacklog(engine)).toBe(1);
  });

  test('content_hash change makes a skipped page eligible again', async () => {
    await seedArticle('article-d');
    const hash1 = await getHash('article-d');

    await upsertAtomExtractionAttempt(engine, {
      sourceId: 'default',
      contentHash16: hash1.slice(0, 16),
      status: 'skipped',
      reason: 'empty_model_output',
    });
    expect(await countExtractAtomsBacklog(engine)).toBe(0);

    // Simulate content update: re-put with different compiled_truth → new hash.
    await engine.putPage('article-d', {
      type: 'article',
      title: 'article-d',
      compiled_truth: BODY + ' extra content that changes the hash',
    });
    const hash2 = await getHash('article-d');
    expect(hash2.slice(0, 16)).not.toBe(hash1.slice(0, 16));

    // New hash has no ledger entry → page is eligible again.
    expect(await countExtractAtomsBacklog(engine)).toBe(1);
  });

  test('upsertAtomExtractionAttempt is idempotent: UPSERT overwrites status', async () => {
    await seedArticle('article-e');
    const hash = await getHash('article-e');
    const h16 = hash.slice(0, 16);

    // First: record as 'failed'
    await upsertAtomExtractionAttempt(engine, {
      sourceId: 'default',
      contentHash16: h16,
      status: 'failed',
      error: 'first error',
    });
    let rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM atom_extraction_attempts
       WHERE source_id = 'default' AND content_hash16 = $1`,
      [h16],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    // 'failed' stays in backlog.
    expect(await countExtractAtomsBacklog(engine)).toBe(1);

    // Second call: upgrade to 'extracted' (e.g. retry succeeded).
    await upsertAtomExtractionAttempt(engine, {
      sourceId: 'default',
      contentHash16: h16,
      status: 'extracted',
    });
    rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM atom_extraction_attempts
       WHERE source_id = 'default' AND content_hash16 = $1`,
      [h16],
    );
    // Still one row (UPSERT, not INSERT), now shows 'extracted'.
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('extracted');
    // Now excluded from backlog.
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  });

  test('cross-source isolation: skipped in source-a does not affect source-b backlog', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('src-a', 'src-a'), ('src-b', 'src-b')
       ON CONFLICT DO NOTHING`,
    );
    // Seed same slug in both sources.
    await engine.putPage('article-x', {
      type: 'article', title: 'x', compiled_truth: BODY,
    }, { sourceId: 'src-a' });
    await engine.putPage('article-x', {
      type: 'article', title: 'x', compiled_truth: BODY,
    }, { sourceId: 'src-b' });

    const rowsA = await engine.executeRaw<{ content_hash: string }>(
      `SELECT content_hash FROM pages WHERE slug = 'article-x' AND source_id = 'src-a'`,
    );
    const h16 = rowsA[0]!.content_hash.slice(0, 16);

    // Mark as skipped only in src-a.
    await upsertAtomExtractionAttempt(engine, {
      sourceId: 'src-a',
      contentHash16: h16,
      status: 'skipped',
    });

    // src-a backlog = 0 (excluded); src-b backlog = 1 (unaffected).
    expect(await countExtractAtomsBacklog(engine, 'src-a')).toBe(0);
    expect(await countExtractAtomsBacklog(engine, 'src-b')).toBe(1);
  });
});
