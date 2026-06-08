/**
 * Regression coverage for source/claim-type aware contradiction actionability.
 *
 * The probe should not treat documentation code examples as durable brain
 * contradictions that degrade doctor health, while real user-authored KB
 * contradictions must remain actionable.
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyFindingActionability,
  filterDoctorActionableContradictions,
} from '../src/core/eval-contradictions/actionability.ts';
import type { ContradictionFinding } from '../src/core/eval-contradictions/types.ts';

function finding(overrides: Partial<ContradictionFinding> = {}): ContradictionFinding {
  return {
    kind: 'cross_slug_chunks',
    a: {
      slug: 'docs/tutorials/company-brain',
      chunk_id: 1,
      take_id: null,
      source_tier: 'other',
      holder: null,
      text: '[Bash] fence.sh:1-1 module\n\ngbrain sources status',
      effective_date: null,
      effective_date_source: null,
    },
    b: {
      slug: 'website/docs/user-guide/features/acp',
      chunk_id: 2,
      take_id: null,
      source_tier: 'other',
      holder: null,
      text: '[Bash] fence.sh:1-1 module\n\nhermes model',
      effective_date: null,
      effective_date_source: null,
    },
    combined_score: 1,
    verdict: 'contradiction',
    severity: 'high',
    axis: 'project status or model reference',
    confidence: 0.85,
    resolution_kind: 'manual_review',
    resolution_command: '# manual review',
    ...overrides,
  };
}

describe('contradiction actionability classifier', () => {
  test('classifies doc-source Bash/code-fence contradictions as monitor-only code examples', () => {
    const f = finding();

    const classified = classifyFindingActionability(f);

    expect(classified.actionability).toBe('monitor_only');
    expect(classified.scope).toBe('doc_source');
    expect(classified.claim_type).toBe('code_example');
    expect(filterDoctorActionableContradictions([f])).toEqual([]);
  });

  test('keeps user-authored durable KB contradictions actionable even when high severity', () => {
    const f = finding({
      a: {
        ...finding().a,
        slug: 'wiki/personal/preferences/agent-boundaries',
        text: 'Shan wants Telegram-originated work to stay lightweight.',
      },
      b: {
        ...finding().b,
        slug: 'people/shan-dutta',
        text: 'Shan prefers heavy browser swarms directly in Telegram lanes.',
      },
      axis: 'Telegram resource boundary preference',
    });

    const classified = classifyFindingActionability(f);

    expect(classified.actionability).toBe('actionable');
    expect(classified.scope).toBe('user_authored');
    expect(classified.claim_type).toBe('semantic_claim');
    expect(filterDoctorActionableContradictions([f])).toHaveLength(1);
  });

  test('does not count temporal evolution as a doctor-actionable contradiction', () => {
    const f = finding({
      verdict: 'temporal_evolution',
      severity: 'info',
      axis: 'legitimate change over time',
      a: { ...finding().a, slug: 'wiki/personal/reflections/old', text: 'Older preference.' },
      b: { ...finding().b, slug: 'wiki/personal/reflections/new', text: 'Newer preference.' },
    });

    const classified = classifyFindingActionability(f);

    expect(classified.actionability).toBe('monitor_only');
    expect(classified.claim_type).toBe('temporal_signal');
    expect(filterDoctorActionableContradictions([f])).toEqual([]);
  });
});
