/**
 * eval-contradictions/actionability — deterministic health-surface classifier.
 *
 * The contradiction judge is intentionally broad: it can surface doc drift,
 * temporal movement, and possible KB conflicts. Doctor needs a narrower lens:
 * only actionable durable-brain contradictions should reduce health_score.
 */

import type {
  ContradictionFinding,
  FindingActionability,
  FindingClaimType,
  FindingScope,
  PairMember,
  Verdict,
} from './types.ts';

const DOC_SOURCE_PREFIXES = [
  'docs/',
  'website/docs/',
  'skills/migrations/',
];

const USER_AUTHORED_PREFIXES = [
  'wiki/',
  'concepts/',
  'entities/',
  'people/',
  'companies/',
  'reflections/',
  'originals/',
];

const GENERATED_OR_TRANSCRIPT_PREFIXES = [
  'transcripts/',
  'chat/',
  'daily/',
  'bookmarks/',
  'media/',
  'reports/',
];

function startsWithAny(slug: string, prefixes: readonly string[]): boolean {
  const lower = slug.toLowerCase();
  return prefixes.some((prefix) => lower.startsWith(prefix));
}

export function isUserAuthoredContradictionSlug(slug: string): boolean {
  const lower = slug.toLowerCase();
  return startsWithAny(lower, USER_AUTHORED_PREFIXES) || lower.includes('/wiki/');
}

export function isDocSourceContradictionSlug(slug: string): boolean {
  return startsWithAny(slug, DOC_SOURCE_PREFIXES);
}

function isGeneratedOrTranscriptSlug(slug: string): boolean {
  return startsWithAny(slug, GENERATED_OR_TRANSCRIPT_PREFIXES);
}

function memberLooksLikeCodeExample(member: PairMember): boolean {
  const text = String(member.text ?? '').trim();
  if (/^\[[A-Za-z0-9_+-]+\]\s+[^\n]*fence\.[A-Za-z0-9_+-]+:/i.test(text)) return true;
  if (/^```/.test(text)) return true;
  if (/\bfence\.(sh|bash|ts|tsx|js|py|sql|md)\b/i.test(text)) return true;
  return false;
}

function scopeFor(aSlug: string, bSlug: string): FindingScope {
  const aUser = isUserAuthoredContradictionSlug(aSlug);
  const bUser = isUserAuthoredContradictionSlug(bSlug);
  if (aUser && bUser) return 'user_authored';
  if (aUser || bUser) return 'mixed';
  const aDoc = isDocSourceContradictionSlug(aSlug);
  const bDoc = isDocSourceContradictionSlug(bSlug);
  if (aDoc && bDoc) return 'doc_source';
  if (aDoc || bDoc) return 'mixed';
  if (isGeneratedOrTranscriptSlug(aSlug) || isGeneratedOrTranscriptSlug(bSlug)) return 'generated_artifact';
  return 'other';
}

function claimTypeFor(finding: ContradictionFinding): FindingClaimType {
  if (finding.verdict !== 'contradiction') return 'temporal_signal';
  if (memberLooksLikeCodeExample(finding.a) && memberLooksLikeCodeExample(finding.b)) {
    return 'code_example';
  }
  return 'semantic_claim';
}

function actionabilityFor(verdict: Verdict, scope: FindingScope, claimType: FindingClaimType): FindingActionability {
  if (verdict !== 'contradiction') return 'monitor_only';
  if (claimType === 'code_example') return 'monitor_only';
  if (scope === 'user_authored') return 'actionable';
  if (scope === 'mixed') return 'actionable';
  return 'monitor_only';
}

export function classifyFindingActionability<T extends ContradictionFinding>(finding: T): T & {
  actionability: FindingActionability;
  scope: FindingScope;
  claim_type: FindingClaimType;
} {
  const scope = scopeFor(finding.a.slug, finding.b.slug);
  const claimType = claimTypeFor(finding);
  return {
    ...finding,
    actionability: actionabilityFor(finding.verdict, scope, claimType),
    scope,
    claim_type: claimType,
  };
}

export function filterDoctorActionableContradictions(
  findings: readonly ContradictionFinding[],
): ContradictionFinding[] {
  return findings
    .map((finding) => (
      finding.actionability && finding.scope && finding.claim_type
        ? finding
        : classifyFindingActionability(finding)
    ))
    .filter((finding) => finding.actionability === 'actionable' && finding.verdict === 'contradiction');
}
