import nodemailer, { Transporter } from 'nodemailer';
import { requireTenantEnv } from '../config/env';
import { BlockerScanFlaggedIssue } from '../scrum/stages/blockerScan';

/**
 * Generic SMTP email client (Real email delivery follow-on to blocker-scan - see
 * blockerScan.ts's own header comment for the surrounding escalation design, and this project's
 * standing "no hardcoded provider logic" rule, same reasoning as vcsClient.ts's `provider` field
 * or ScrumVcsConfigSchema's own comment). Deliberately built on nodemailer's plain SMTP transport,
 * not a vendor SDK (SendGrid's, SES's, etc.) - a bare host/port/user/pass works against Gmail
 * SMTP, SendGrid SMTP, AWS SES SMTP, Outlook/Exchange Online SMTP, or any other provider that
 * speaks SMTP, with no provider-specific branch anywhere in this file. A tenant switching email
 * providers only ever needs to change its SMTP_* env vars, never this code.
 *
 * Same shape as jiraClient.ts/agileClient.ts: a class wrapping the real transport, constructed
 * from requireTenantEnv() the same as every other credential in this codebase, plus a
 * getEmailClient() singleton getter so callers never construct this directly (same "one
 * transport per process" convention as JiraClient/AgileClient's own singletons).
 *
 * FIRE-AND-LOG IS THE CALLER'S JOB, NOT THIS CLASS'S: unlike sendTicketSummaryDm() (which
 * swallows its own errors and returns a result object), sendMail() below lets a failed send
 * throw - the same "own the network call, own the try/catch" convention pipeline.ts's
 * stageBlockerScan() already uses for its inline 'slack-channel' webhook POST (a plain
 * axios.post() call wrapped in try/catch at the call site, not inside a helper). This keeps
 * EmailClient a thin, honest wrapper over nodemailer, and keeps the one place that decides
 * "log a warning and move on" (stageBlockerScan) in a single, already-audited location rather
 * than duplicating that policy inside every client.
 *
 * NOT YET SUPPORTED: OAuth2/XOAUTH2 SMTP auth. This client only ever authenticates with a plain
 * SMTP_USER/SMTP_PASS pair (nodemailer's default 'login'/'plain' auth). Microsoft has been
 * walking back its Basic-Auth-for-SMTP-AUTH deprecation timeline (still works for existing
 * tenants as of this writing, not defaulting to disabled tenant-wide until end of Dec 2026 per
 * Microsoft's own Community Hub posts) - but any tenant that has already disabled it as its own
 * security default will see SMTP_USER/SMTP_PASS auth fail here. That is expected in that case,
 * not a bug in this client - wiring XOAUTH2 support is a separate future PR, not something to
 * build speculatively into this one.
 */
export class EmailClient {
  private transporter: Transporter;
  private from: string;

  // Constructor is now private - credentials must be resolved async (requireTenantEnv is async
  // since the Secrets-manager fix), so construction goes through the static async create()
  // factory below instead of `new EmailClient()`.
  private constructor(host: string, port: number, user: string, pass: string, from: string) {
    this.from = from;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      // Port 465 is implicit TLS from the first byte of the connection; every other port
      // (587, 25, ...) negotiates STARTTLS itself once connected - nodemailer handles that
      // negotiation automatically, this flag only controls which of the two connection styles
      // to start with. Same convention every major SMTP provider (Gmail, SendGrid, SES,
      // Outlook/Exchange Online) documents for their own 465 vs 587 endpoints.
      secure: port === 465,
      auth: { user, pass },
    });
  }

  static async create(): Promise<EmailClient> {
    const host = await requireTenantEnv('SMTP_HOST', 'Email Client (blocker-scan)');
    const portRaw = await requireTenantEnv('SMTP_PORT', 'Email Client (blocker-scan)');
    const user = await requireTenantEnv('SMTP_USER', 'Email Client (blocker-scan)');
    const pass = await requireTenantEnv('SMTP_PASS', 'Email Client (blocker-scan)');
    const from = await requireTenantEnv('SMTP_FROM', 'Email Client (blocker-scan)');
    return new EmailClient(host, Number(portRaw), user, pass, from);
  }

  /**
   * Sends one plain-text email. Deliberately throws on failure rather than returning a
   * {ok, error} result (unlike sendTicketSummaryDm) - see this file's header comment for why:
   * the caller (stageBlockerScan) already owns try/catch + logging for every other delivery
   * channel's inline network call, and this keeps that policy in one place.
   */
  async sendMail(to: string, subject: string, text: string): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to, subject, text });
  }
}

let client: EmailClient | null = null;
export async function getEmailClient(): Promise<EmailClient> {
  if (!client) client = await EmailClient.create();
  return client;
}

/**
 * Pure message-building for a blocker escalation email - same {subject, text} shape every other
 * email-sending caller would expect, mirroring blockerScan.ts's own
 * buildBlockerEscalationSlackMessage() (same headline/summary/status/assignee/updated content,
 * reformatted as a plain-text email rather than Slack mrkdwn blocks). Lives here rather than in
 * blockerScan.ts itself, per this feature's own design: the email client file owns its own
 * message builder, the same way blockerScan.ts owns buildBlockerEscalationSlackMessage() for its
 * own channel.
 */
export function buildBlockerEscalationEmail(
  issue: BlockerScanFlaggedIssue,
  idleDaysThreshold: number,
): { subject: string; text: string } {
  const subject = `[Blocker Scan] ${issue.key} has been idle for ${issue.idleDays} day(s)`;
  const text = [
    `${issue.key} has been idle for ${issue.idleDays} day(s) (no update since ${issue.updated}) - ` +
      `past the configured ${idleDaysThreshold}-day idle threshold.`,
    '',
    `Summary: ${issue.summary}`,
    `Status: ${issue.status}`,
    `Assignee: ${issue.assignee ?? 'Unassigned'}`,
    '',
    'Flagged automatically by blocker-scan. This is a report only - nothing was changed on this ticket.',
  ].join('\n');
  return { subject, text };
}
