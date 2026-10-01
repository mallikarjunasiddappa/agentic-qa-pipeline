import axios from 'axios';

export interface SlackDmResult {
  ok: boolean;
  error?: string;
}

/**
 * Slack Bot API DM send: resolves an email to a Slack user id (users.lookupByEmail), opens/
 * fetches that user's DM channel (conversations.open), then posts to it (chat.postMessage).
 * Deliberately the Bot API rather than the SLACK_WEBHOOK_URL-style incoming webhook used elsewhere
 * in this project (see pipelineReport/slackNotify.ts, traceability/slackNotify.ts) - a webhook
 * always posts to the one fixed channel it was created for, with no way to address a specific
 * person, which is the entire point of this command: whoever runs --stage ticket-summary gets
 * their own DM, not a channel broadcast. Requires a Slack App with the users:read.email,
 * im:write, and chat:write bot scopes - see the onboarding doc for setup. im:write is the one
 * that's easy to miss: it's not needed for the lookup or the final post, only for
 * conversations.open itself (opening a new DM channel with someone the bot hasn't messaged
 * before) - without it, lookup succeeds but this fails with "conversations.open failed:
 * missing_scope".
 *
 * Fire-and-log like postToSlack/postDriftCheckToSlack elsewhere: never throws, so a Slack outage
 * or a misconfigured token never fails the ticket-summary stage itself (the summary is always
 * printed to the console regardless). Returns a result instead of void (unlike those two) because
 * this stage's entire purpose is the DM - the caller needs to tell the person running it whether
 * the message actually landed, not just log a warning nobody will see.
 */
export async function sendTicketSummaryDm(
  botToken: string | undefined,
  recipientEmail: string | undefined,
  message: { text: string; blocks: unknown[] },
): Promise<SlackDmResult> {
  if (!botToken) {
    return {
      ok: false,
      error: 'SLACK_BOT_TOKEN not set - see the onboarding doc for Slack App setup.',
    };
  }
  if (!recipientEmail) {
    return {
      ok: false,
      error: 'No recipient email - set SLACK_USER_EMAIL (or JIRA_EMAIL) in your .env.',
    };
  }

  const authHeader = { headers: { Authorization: `Bearer ${botToken}` } };
  try {
    const lookup = await axios.get('https://slack.com/api/users.lookupByEmail', {
      ...authHeader,
      params: { email: recipientEmail },
    });
    if (!lookup.data.ok) {
      return {
        ok: false,
        error: `users.lookupByEmail failed: ${lookup.data.error} (email: ${recipientEmail}) - is this the email your Slack account uses?`,
      };
    }
    const userId = lookup.data.user.id;

    const open = await axios.post('https://slack.com/api/conversations.open', { users: userId }, authHeader);
    if (!open.data.ok) {
      return { ok: false, error: `conversations.open failed: ${open.data.error}` };
    }
    const channelId = open.data.channel.id;

    const post = await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel: channelId, text: message.text, blocks: message.blocks },
      authHeader,
    );
    if (!post.data.ok) {
      return { ok: false, error: `chat.postMessage failed: ${post.data.error}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
