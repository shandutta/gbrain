import { describe, expect, test } from 'bun:test';
import {
  CONVERSATION_SLUG_ROOTS,
  isGenuineConversationPage,
} from '../../src/core/conversation-parser/conversation-page.ts';
import type { PageType } from '../../src/core/types.ts';

const page = (slug: string, type: PageType) => ({ slug, type });

describe('isGenuineConversationPage', () => {
  describe('code-source false positives are excluded', () => {
    const emailFalsePositives = [
      'optional-skills/email/agentmail/skill',
      'skills/email/himalaya/skill',
      'skills/email/description',
      'website/docs/user-guide/skills/bundled/email/email-himalaya',
      'website/docs/user-guide/skills/optional/email/email-agentmail',
      'website/i18n/zh-hans/docusaurus-plugin-content-docs/current/user-guide/skills/bundled/email/email-himalaya',
      'website/i18n/zh-hans/docusaurus-plugin-content-docs/current/user-guide/skills/optional/email/email-agentmail',
    ];
    for (const slug of emailFalsePositives) {
      test(`email type at "${slug}" is not a conversation page`, () => {
        expect(isGenuineConversationPage(page(slug, 'email'))).toBe(false);
      });
    }

    const meetingFalsePositives = [
      'test/e2e/fixtures/meetings/novamind-demo-day',
      'test/e2e/fixtures/meetings/weekly-sync-mar28',
    ];
    for (const slug of meetingFalsePositives) {
      test(`meeting type at "${slug}" is not a conversation page`, () => {
        expect(isGenuineConversationPage(page(slug, 'meeting'))).toBe(false);
      });
    }

    test('nested slack/ directory in a code source is excluded', () => {
      expect(isGenuineConversationPage(page('skills/slack/notifier/skill', 'slack'))).toBe(false);
    });
  });

  describe('genuine top-level transcripts are counted', () => {
    test('emails/ namespace', () => {
      expect(isGenuineConversationPage(page('emails/2026-05-30-acme-intro', 'email'))).toBe(true);
    });
    test('singular email/ namespace', () => {
      expect(isGenuineConversationPage(page('email/2026-05-30-note', 'email'))).toBe(true);
    });
    test('meetings/ namespace', () => {
      expect(isGenuineConversationPage(page('meetings/2026-04-03-standup', 'meeting'))).toBe(true);
    });
    test('slack/ namespace', () => {
      expect(isGenuineConversationPage(page('slack/general/2026-05-30', 'slack'))).toBe(true);
    });
    test('leading slash and uppercase slug segments are tolerated', () => {
      expect(isGenuineConversationPage(page('/Emails/Inbox/2026-05', 'email'))).toBe(true);
    });
  });

  describe('explicit `type: conversation` is always trusted', () => {
    test('nested explicit conversation type is trusted', () => {
      expect(isGenuineConversationPage(page('wintermute/chat/2026-05-30-foo', 'conversation'))).toBe(
        true,
      );
    });
  });

  describe('non-conversation types are never conversation pages', () => {
    for (const t of ['concept', 'person', 'company', 'note', 'code', 'guide'] as PageType[]) {
      test(`type ${t} is excluded even with a conversation-ish slug`, () => {
        expect(isGenuineConversationPage(page('emails/whatever', t))).toBe(false);
      });
    }
  });

  test('CONVERSATION_SLUG_ROOTS covers singular and plural forms', () => {
    for (const stem of ['email', 'meeting', 'conversation', 'chat']) {
      expect(CONVERSATION_SLUG_ROOTS).toContain(`${stem}/`);
      expect(CONVERSATION_SLUG_ROOTS).toContain(`${stem}s/`);
    }
    expect(CONVERSATION_SLUG_ROOTS).toContain('slack/');
  });
});
