/**
 * v0.41.x — "is this page a genuine conversation transcript?" classifier.
 *
 * `inferType` maps a Markdown page to email/meeting/slack whenever its path
 * contains an email/, meetings/, or slack/ directory anywhere. That is useful
 * for normal brain namespaces but creates false positives for synced code
 * sources such as skills/email/... docs or test/e2e/fixtures/meetings/...
 * fixtures. This read-time filter lets doctor count real transcript pages
 * without weakening the conversation parser or mass-retyping DB rows.
 */
import type { PageType } from '../types.ts';

export const CONVERSATION_SLUG_ROOTS: readonly string[] = [
  'email/',
  'emails/',
  'meeting/',
  'meetings/',
  'slack/',
  'conversation/',
  'conversations/',
  'chat/',
  'chats/',
];

const PATH_INFERRABLE_CONVERSATION_TYPES: ReadonlySet<PageType> = new Set<PageType>([
  'email',
  'meeting',
  'slack',
]);

export function isGenuineConversationPage(page: { slug: string; type: PageType }): boolean {
  if (page.type === 'conversation') return true;
  if (!PATH_INFERRABLE_CONVERSATION_TYPES.has(page.type)) return false;
  const slug = page.slug.toLowerCase().replace(/^\/+/, '');
  return CONVERSATION_SLUG_ROOTS.some((root) => slug.startsWith(root));
}
