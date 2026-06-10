import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', '85');
});

describe('MinionQueue idempotency retry semantics', () => {
  test('retry_terminal_failure replaces a stale dead row for the same idempotency key', async () => {
    const first = await queue.add('subagent', { prompt: 'old' }, {
      idempotency_key: 'dream:synth:test:abc123',
    }, { allowProtectedSubmit: true });
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'dead', error_text = 'transient provider bug' WHERE id = $1`,
      [first.id],
    );

    const retry = await queue.add('subagent', { prompt: 'new' }, {
      idempotency_key: 'dream:synth:test:abc123',
      retry_terminal_failure: true,
    }, { allowProtectedSubmit: true });

    expect(retry.id).not.toBe(first.id);
    expect(retry.status).toBe('waiting');
    expect(retry.data.prompt).toBe('new');

    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs WHERE idempotency_key = $1`,
      ['dream:synth:test:abc123'],
    );
    expect(rows[0].count).toBe('1');
  });

  test('retry_terminal_failure still dedups completed rows', async () => {
    const first = await queue.add('subagent', { prompt: 'done' }, {
      idempotency_key: 'dream:synth:test:done',
    }, { allowProtectedSubmit: true });
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'completed', result = '{}'::jsonb WHERE id = $1`,
      [first.id],
    );

    const retry = await queue.add('subagent', { prompt: 'new' }, {
      idempotency_key: 'dream:synth:test:done',
      retry_terminal_failure: true,
    }, { allowProtectedSubmit: true });

    expect(retry.id).toBe(first.id);
    expect(retry.status).toBe('completed');
    expect(retry.data.prompt).toBe('done');
  });
});
