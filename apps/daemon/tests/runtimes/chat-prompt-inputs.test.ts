import { expect, test } from 'vitest';

import { compactPriorTranscriptForAgentTransport } from '../../src/runtimes/chat-prompt-inputs.js';

test('compacts prior transcript to complete newest turns that fit the transport', () => {
  const notice =
    '## context notice\nOpenDesign omitted older conversation turns to fit this agent transport.';
  const newestTurn = '## assistant\nNEWEST_ANTIGRAVITY_CONTEXT';
  const priorTranscript = [
    `## user\nOLDEST_ANTIGRAVITY_CONTEXT_${'x'.repeat(10_000)}`,
    '## user\nMIDDLE_ANTIGRAVITY_CONTEXT',
    newestTurn,
  ].join('\n\n');
  const maxBytes = Buffer.byteLength(`${notice}\n\n${newestTurn}`, 'utf8');

  const compacted = compactPriorTranscriptForAgentTransport({
    priorTranscript,
    fits: (candidate) => Buffer.byteLength(candidate, 'utf8') <= maxBytes,
  });

  expect(compacted).toBe(`${notice}\n\n${newestTurn}`);
  expect(compacted).not.toContain('OLDEST_ANTIGRAVITY_CONTEXT');
  expect(compacted).not.toContain('MIDDLE_ANTIGRAVITY_CONTEXT');
});

test('drops every prior turn when only the caller-owned current request fits', () => {
  const compacted = compactPriorTranscriptForAgentTransport({
    priorTranscript: '## user\nOLDER_CONTEXT',
    fits: (candidate) => candidate.length === 0,
  });

  expect(compacted).toBe('');
});
