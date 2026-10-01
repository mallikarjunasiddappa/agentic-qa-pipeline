import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequirementGapComment } from './requirementGate';

test('buildRequirementGapComment lists every gap and includes the override command', () => {
  const comment = buildRequirementGapComment([
    { description: 'No acceptance criteria for the error state' },
    { description: 'Unclear whether this applies to guest users' },
  ]);

  assert.match(comment, /No acceptance criteria for the error state/);
  assert.match(comment, /Unclear whether this applies to guest users/);
  assert.match(comment, /approve-requirements/);
});

test('buildRequirementGapComment handles a single gap without a stray bullet list artifact', () => {
  const comment = buildRequirementGapComment([{ description: 'Missing expected error message text' }]);
  assert.match(comment, /^- Missing expected error message text$/m);
});
