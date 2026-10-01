import path from 'node:path';
import { getCommitHistory, PromptVersionCommit } from './gitLog';

export interface AgentChangelog {
  agentFile: string;
  commits: PromptVersionCommit[];
}

export interface PromptVersionReport {
  generatedAt: string;
  agents: AgentChangelog[];
}

export const AGENTS_DIR = path.join('.claude', 'agents');

// The six agents in scope - .claude/skills/playwright-cli/references/*.md is deliberately excluded.
export const AGENT_FILES = [
  'jira-agent.md',
  'planning-agent.md',
  'excel-agent.md',
  'tms-agent.md',
  'generator-agent.md',
  'healer-agent.md',
];

/**
 * Builds one changelog per agent, each keyed by its *current* filename - `getCommits` (defaults
 * to the real `git log --follow` wrapper, injectable here for tests) already resolves each
 * agent's pre-rename history (e.g. tms-agent.md's changelog includes its qase-agent.md-era
 * commits) since it's called against the current path.
 */
export function buildPromptVersionReport(
  now: Date = new Date(),
  agentsDir: string = AGENTS_DIR,
  getCommits: (filePath: string) => PromptVersionCommit[] = getCommitHistory,
): PromptVersionReport {
  const agents: AgentChangelog[] = AGENT_FILES.map((agentFile) => {
    const filePath = path.join(agentsDir, agentFile);
    const commits = [...getCommits(filePath)].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { agentFile, commits };
  });

  return { generatedAt: now.toISOString(), agents };
}
