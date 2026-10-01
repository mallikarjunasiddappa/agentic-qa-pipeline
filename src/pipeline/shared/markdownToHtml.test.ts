import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownToHtml, wrapReportPage } from './markdownToHtml';

test('renderMarkdownToHtml converts headers at all three levels', () => {
  const html = renderMarkdownToHtml('# Title\n\n## Section\n\n### Subsection');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<h2>Section<\/h2>/);
  assert.match(html, /<h3>Subsection<\/h3>/);
});

test('renderMarkdownToHtml converts a bullet list with inline bold and code', () => {
  const html = renderMarkdownToHtml('- **Agent** at 2026-08-08: `foo.spec.ts`\n- Second item');
  assert.match(html, /<ul>.*<\/ul>/s);
  assert.match(html, /<li><strong>Agent<\/strong> at 2026-08-08: <code>foo\.spec\.ts<\/code><\/li>/);
  assert.match(html, /<li>Second item<\/li>/);
});

test('renderMarkdownToHtml converts a pipe table, skipping the separator row', () => {
  const md = '| Agent | Cost |\n|---|---|\n| jira-agent | $0.03 |\n| excel-agent | $0.05 |';
  const html = renderMarkdownToHtml(md);
  assert.match(html, /<table><thead><tr><th>Agent<\/th><th>Cost<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>jira-agent<\/td><td>\$0\.03<\/td>/);
  assert.match(html, /<td>excel-agent<\/td><td>\$0\.05<\/td>/);
  // The |---|---| separator row must never appear as a data row.
  assert.doesNotMatch(html, /<td>---<\/td>/);
});

test('renderMarkdownToHtml escapes HTML-significant characters', () => {
  const html = renderMarkdownToHtml('- cost < 5 & status is "ok"');
  assert.match(html, /cost &lt; 5 &amp; status is &quot;ok&quot;/);
});

test('renderMarkdownToHtml treats a real report.md shape end-to-end without throwing', () => {
  const md = [
    '# Cost & Latency Report',
    '',
    'Generated: 2026-08-08T12:00:00.000Z',
    '',
    '## Overall',
    '',
    '- Total events: 2',
    '- Total cost: $0.068408',
    '',
    '## Week-over-week trend by agent',
    '',
    '| Agent | Previous week | This week | Δ |',
    '|---|---|---|---|',
    '| jira-agent | $0.01 (2026-W31) | $0.02 (2026-W32) | +100.0% |',
    '',
  ].join('\n');
  const html = renderMarkdownToHtml(md);
  assert.match(html, /<h1>Cost &amp; Latency Report<\/h1>/);
  assert.match(html, /<h2>Overall<\/h2>/);
  assert.match(html, /<li>Total events: 2<\/li>/);
  assert.match(html, /<table>/);
});

test('wrapReportPage includes the title, the body, and a back link when given one', () => {
  const page = wrapReportPage('Cost & Latency Report', '<h1>Cost & Latency Report</h1>', 'report.html');
  assert.match(page, /<title>Cost & Latency Report<\/title>/);
  assert.match(page, /<h1>Cost & Latency Report<\/h1>/);
  assert.match(page, /href="report\.html"/);
  assert.match(page, /Back to pipeline health dashboard/);
});

test('wrapReportPage omits the back link when none is given', () => {
  const page = wrapReportPage('Cost & Latency Report', '<h1>x</h1>');
  // CSS for .back-link is always present (shared stylesheet) - what must be absent is the
  // actual anchor element using it.
  assert.doesNotMatch(page, /<a class="back-link"/);
});

test('wrapReportPage uses a caller-supplied backLabel instead of the default text when given one', () => {
  const page = wrapReportPage('Scrum Dashboard', '<h1>x</h1>', '../scrumDashboard/report.html', 'Back to Scrum Dashboard');
  assert.match(page, /Back to Scrum Dashboard/);
  assert.doesNotMatch(page, /Back to pipeline health dashboard/);
});

test('wrapReportPage falls back to the original default text when backLabel is not given', () => {
  const page = wrapReportPage('Cost & Latency Report', '<h1>x</h1>', 'report.html');
  assert.match(page, /Back to pipeline health dashboard/);
});
