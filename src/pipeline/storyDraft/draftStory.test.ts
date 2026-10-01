import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStoryDraftResponse } from './draftStory';

test('parseStoryDraftResponse parses a well-formed model response', () => {
  const raw = JSON.stringify({
    title: 'Allow guest checkout',
    description: 'As a shopper, I want to check out without an account, so that I can buy quickly.',
    acceptanceCriteria: ['Guest can complete checkout without registering', 'Order confirmation email is sent to the guest email'],
  });
  const draft = parseStoryDraftResponse(raw);
  assert.equal(draft.title, 'Allow guest checkout');
  assert.equal(draft.acceptanceCriteria.length, 2);
});

test('parseStoryDraftResponse tolerates surrounding prose/markdown fences around the JSON object', () => {
  const raw = '```json\n' + JSON.stringify({ title: 't', description: 'd', acceptanceCriteria: ['a'] }) + '\n```';
  const draft = parseStoryDraftResponse(raw);
  assert.equal(draft.title, 't');
});

test('parseStoryDraftResponse throws a clear error when the response has no JSON object at all', () => {
  assert.throws(() => parseStoryDraftResponse('Sorry, I cannot help with that.'), /non-JSON-object/);
});

test('parseStoryDraftResponse throws a clear error when a required field is missing', () => {
  const raw = JSON.stringify({ title: 't', description: 'd' }); // no acceptanceCriteria
  assert.throws(() => parseStoryDraftResponse(raw), /malformed JSON/);
});

test('parseStoryDraftResponse throws a clear error when acceptanceCriteria is not a string array', () => {
  const raw = JSON.stringify({ title: 't', description: 'd', acceptanceCriteria: [1, 2, 3] });
  assert.throws(() => parseStoryDraftResponse(raw), /malformed JSON/);
});
