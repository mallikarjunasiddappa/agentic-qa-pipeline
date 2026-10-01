/**
 * Shared CSS for every self-hosted HTML report page (the pipelineReport dashboard and, via
 * markdownToHtml.ts, each domain's own report.html) - factored out so they look like one
 * consistent site rather than five differently-styled pages bolted together. Domain report pages
 * add a few extra selectors on top (article/table/h3 styling) not needed by the dashboard, so
 * this only covers the shared subset; see markdownToHtml.ts for the additions.
 */
export const REPORT_PAGE_BASE_CSS = `
  :root {
    --bg: #f7f7f8; --surface: #ffffff; --border: #e2e2e2; --text: #1a1a1a; --text-secondary: #6b7280;
    --alert-bg: #fef2f2; --alert-border: #fecaca; --alert-text: #991b1b;
    --clear-bg: #f0fdf4; --clear-border: #bbf7d0; --clear-text: #166534;
    --stale-bg: #fef3c7; --stale-text: #92400e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 24px 48px; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .generated { color: var(--text-secondary); font-size: 13px; margin: 0 0 24px; }
  .attention { border-radius: 10px; padding: 14px 16px; margin-bottom: 28px; border: 1px solid; }
  .attention-alert { background: var(--alert-bg); border-color: var(--alert-border); color: var(--alert-text); }
  .attention-clear { background: var(--clear-bg); border-color: var(--clear-border); color: var(--clear-text); }
  .attention .badge { font-weight: 600; font-size: 13px; }
  .attention ul { margin: 8px 0 0; padding-left: 20px; }
  .attention li { margin-bottom: 4px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
  .card h2 { font-size: 14px; margin: 0 0 12px; }
  .card dl { margin: 0; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
  .row:last-child { border-bottom: none; }
  .row dt { color: var(--text-secondary); }
  .row dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  .detail-link, .back-link { display: inline-block; margin-top: 12px; font-size: 12px; color: #2563eb; text-decoration: none; }
  .detail-link:hover, .back-link:hover { text-decoration: underline; }
  .tag { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; }
  .tag-stale { background: var(--stale-bg); color: var(--stale-text); }
  code { background: #f0f0f0; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
`;
