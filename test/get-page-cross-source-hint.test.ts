/**
 * Cwd/source-scoped page_not_found UX.
 *
 * Local CLI callers can be scoped to a code source via cwd local_path. When a
 * slug exists in a different source, `get_page` should not silently look like a
 * data-loss bug; it should name the active source and the source(s) containing
 * the exact slug.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, operationsByName } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('code-src', 'code-src', '/tmp/project') ON CONFLICT (id) DO NOTHING`);
  await engine.putPage('plans/thing', {
    type: 'plan',
    title: 'Default plan',
    compiled_truth: 'Default source plan body.',
    frontmatter: { type: 'plan' },
  }, { sourceId: 'default' });
});

describe('get_page local source-scoped miss hint', () => {
  test('local caller gets exact cross-source hit suggestion instead of generic soft-delete hint', async () => {
    const op = operationsByName.get_page;
    let err: unknown;
    try {
      await op.handler({
        engine,
        config: { engine: 'pglite' },
        logger: { info() {}, warn() {}, error() {} },
        remote: false,
        dryRun: false,
        sourceId: 'code-src',
      }, { slug: 'plans/thing' });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(OperationError);
    const opErr = err as OperationError;
    expect(opErr.code).toBe('page_not_found');
    expect(opErr.message).toContain('active source "code-src"');
    expect(opErr.suggestion).toContain('slug exists in source(s): default');
    expect(opErr.suggestion).toContain('GBRAIN_SOURCE=default gbrain get plans/thing');
  });

  test('remote scoped caller keeps generic hint and does not learn cross-source existence', async () => {
    const op = operationsByName.get_page;
    let err: unknown;
    try {
      await op.handler({
        engine,
        config: { engine: 'pglite' },
        logger: { info() {}, warn() {}, error() {} },
        remote: true,
        dryRun: false,
        sourceId: 'code-src',
      }, { slug: 'plans/thing' });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(OperationError);
    const opErr = err as OperationError;
    expect(opErr.message).toBe('Page not found: plans/thing');
    expect(opErr.suggestion).not.toContain('default');
  });
});
