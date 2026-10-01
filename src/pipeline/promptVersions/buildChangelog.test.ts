import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptVersionReport, AGENT_FILES } from './buildChangelog';
import type { PromptVersionCommit } from './gitLog';

function commit(overrides: Partial<PromptVersionCommit> = {}): PromptVersionCommit {
  return {
    sha: 'sha1',
    shortSha: 'sha1',
    author: 'A',
    date: '2026-08-05T10:00:00+00:00',
    message: 'msg',
    path: 'x',
    insertions: 1,
    deletions: 0,
    ...overrides,
  };
}

test('buildPromptVersionReport produces one changelog per agent, in the fixed six-agent order', () => {
  const report = buildPromptVersionReport(new Date('2026-08-06T00:00:00Z'), '.claude/agents', () => []);
  assert.equal(report.agents.length, 6);
  assert.deepEqual(report.agents.map((a) => a.agentFile), AGENT_FILES);
  assert.equal(report.generatedAt, '2026-08-06T00:00:00.000Z');
});

test('buildPromptVersionReport sorts each agent\'s commits newest first by date', () => {
  const commits: Record<string, PromptVersionCommit[]> = {
    'healer-agent.md': [
      commit({ sha: 'older', date: '2026-08-01T00:00:00+00:00' }),
      commit({ sha: 'newer', date: '2026-08-05T00:00:00+00:00' }),
    ],
  };
  const report = buildPromptVersionReport(new Date(), '.claude/agents', (filePath) => {
    const name = filePath.replace(/\\/g, '/').split('/').pop()!;
    return commits[name] ?? [];
  });
  const healer = report.agents.find((a) => a.agentFile === 'healer-agent.md')!;
  assert.deepEqual(healer.commits.map((c) => c.sha), ['newer', 'older']);
});

test('buildPromptVersionReport groups tms-agent.md commits under the current filename, including pre-rename entries', () => {
  const commits: Record<string, PromptVersionCommit[]> = {
    'tms-agent.md': [
      commit({ sha: 'rename', date: '2026-08-06T09:45:53+00:00', path: '.claude/agents/tms-agent.md' }),
      commit({ sha: 'orig', date: '2026-08-05T08:31:24+00:00', path: '.claude/agents/qase-agent.md' }),
    ],
  };
  const report = buildPromptVersionReport(new Date(), '.claude/agents', (filePath) => {
    const name = filePath.replace(/\\/g, '/').split('/').pop()!;
    return commits[name] ?? [];
  });
  const tms = report.agents.find((a) => a.agentFile === 'tms-agent.md')!;
  assert.equal(tms.commits.length, 2);
  assert.equal(tms.commits[1].path, '.claude/agents/qase-agent.md');
});
