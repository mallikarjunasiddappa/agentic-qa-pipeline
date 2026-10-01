import 'dotenv/config';
import { z } from 'zod';
import { getTenantId } from './tenantContext';
import { resolveSecretsProvider } from './capabilityStore';
import {
  SecretsProvider,
  EnvFileSecretsProvider,
  AzureKeyVaultSecretsProvider,
  selectSecretsProvider,
  envFileTenantKey,
} from './secretsProvider';

const EnvSchema = z.object({
  // Which tenant this CLI invocation runs as - see src/pipeline/config/tenantContext.ts's
  // resolveTenantId(). --tenant (parseArgs in pipeline.ts) takes precedence over this; both fall
  // back to 'default' when neither is set, so no existing CI guardrail, cron job, or local
  // invocation needs to change.
  TENANT_ID: z.string().optional(),

  JIRA_BASE_URL: z.string().optional(),
  JIRA_EMAIL: z.string().optional(),
  JIRA_API_TOKEN: z.string().optional(),
  JIRA_PROJECT_KEY: z.string().optional(),

  QASE_API_TOKEN: z.string().optional(),
  QASE_PROJECT_CODE: z.string().optional(),

  // Phase 0 genericity proof: second real TMS adapter (testmgmt/testinyClient.ts), alongside Qase
  // above - same "which TMS provider" selection mechanism (TMS_PROVIDER / capabilityStore.ts's
  // resolveTmsProvider()), just a second real value ('testiny') for it to resolve to. Testiny's
  // REST API auths via a single X-Api-Key header (no separate token/project-code split the way
  // Qase's URL-embedded project code works) - TESTINY_PROJECT_ID is still its own var (not folded
  // into the key) since it's a numeric project id Testiny's API requires in every request body,
  // not a credential.
  TESTINY_API_KEY: z.string().optional(),
  TESTINY_PROJECT_ID: z.string().optional(),

  // VCS Client (Scrum Master Automation Program's dev-status stage, Phase 1) - GitHub REST API.
  // Provider selection itself lives in config/tenants/<tenantId>/scrum.json's vcs.provider
  // (ScrumConfigSchema), not here - these two are connection-level identifiers (a PAT and a
  // "owner/repo" string), same category as JIRA_PROJECT_KEY/QASE_PROJECT_CODE above, which is why
  // they're env vars rather than scrum.json fields. Both are tenant-overridable via the usual
  // <KEY>__<TENANT> mechanism (resolveTenantEnv below) for a future tenant with a different repo.
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().optional(),

  // Phase 1: GitLabCIProvider (src/pipeline/ci/gitlabCIProvider.ts), the second CIProvider adapter
  // per Production Roadmap Section 5 ("GitHub Actions first, GitLab second") - same
  // one-var-per-credential shape as GITHUB_TOKEN/GITHUB_REPO above. GITLAB_BASE_URL defaults to
  // gitlab.com's own API host; only needs overriding for a self-managed GitLab instance.
  // GITLAB_PROJECT_ID is GitLab's numeric project id or URL-encoded path (docs.gitlab.com/api/rest/
  // #namespaced-paths) - GitLab's own API accepts either, so this pipeline doesn't normalize it,
  // same as GITHUB_REPO passing "owner/repo" straight through to GithubClient unmodified.
  GITLAB_BASE_URL: z.string().default('https://gitlab.com'),
  GITLAB_TOKEN: z.string().optional(),
  GITLAB_PROJECT_ID: z.string().optional(),

  // Which CIProvider adapter getCIProvider() (src/pipeline/ci/index.ts) resolves to - same
  // "global env var, defaults to the first-built provider" shape as TMS_PROVIDER below. Not yet
  // wired into capabilityStore.ts's per-tenant resolution (unlike resolveTmsProvider()) - CI
  // provider choice hasn't come up as a per-tenant need yet, only a global one; add that if/when
  // it does, following the exact same pattern TMS_PROVIDER already proved out.
  CI_PROVIDER: z.string().default('github'),

  // Gate 0 headless-agent-cost spike (docs/planning/Production Roadmap - Consolidated
  // Plan.docx section 1; saas-productization-milestone.md's "headless-agent-cost workstream").
  // Anthropic Console API key (console.anthropic.com), a separate product/billing account from
  // claude.ai Pro/Max subscriptions - see src/pipeline/requirementGate/headlessJudge.ts for the
  // one real Messages API call this currently backs. Optional, same "if unset, this feature is
  // just skipped" convention as every other credential in this file - only --stage
  // flag-requirement-gaps-headless needs it; the interactive Planning Agent path
  // (--stage flag-requirement-gaps with a hand-written --gaps-file) is unaffected either way.
  // Tenant-overridable via the usual <KEY>__<TENANT> mechanism (resolveTenantEnv below), same as
  // every other per-tenant credential here.
  ANTHROPIC_API_KEY: z.string().optional(),

  TMS_PROVIDER: z.string().default('qase'),
  // Optional. How many manifest entries drift-check fetches from the TMS concurrently, instead of
  // one at a time (see traceabilityAgent.ts's checkDrift/DEFAULT_DRIFT_CHECK_CONCURRENCY - a real
  // multi-minute-plus bottleneck at thousands of entries otherwise). Not a documented Qase rate
  // limit - the default (5) is a conservative starting point. Raise it if drift-check is still
  // slow and your TMS plan can take it; lower it if you start seeing 429s.
  DRIFT_CHECK_CONCURRENCY: z.string().optional(),

  // Who's running this CLI on this machine, for attribution on workflow gate records
  // (requirementsClearedBy/scenariosApprovedBy/testCasesApprovedBy in traceability/manifest.json -
  // see src/pipeline/config/teamConfig.ts's resolveOperator()). Optional - falls back to JIRA_EMAIL
  // since every team member already needs their own dedicated value there. Only needs setting
  // explicitly when it should differ from your Jira identity, e.g. Jenkins setting this to
  // something like "ci-bot" distinct from whatever account its own JIRA_EMAIL points at.
  PIPELINE_OPERATOR: z.string().optional(),

  // Pipeline health report (src/pipeline/pipelineReport). Optional - if unset, `pipeline-report`
  // still writes report.json/report.html, it just skips the Slack notification step.
  SLACK_WEBHOOK_URL: z.string().optional(),
  // Slack posts from `pipeline-report`/`drift-check` are CI-only by default (see
  // teamConfig.ts's allowSlackNotify()) - with more than one person on this pipeline, everyone
  // running these locally to sanity-check before pushing would otherwise spam the shared channel
  // every time. Set to "true" in your own .env to opt back in locally, e.g. to test the Slack
  // integration itself. Has no effect in CI (GitHub Actions sets CI=true, which already allows it).
  SLACK_NOTIFY_LOCAL: z.string().optional(),
  // Traceability drift check (src/pipeline/traceability). Deliberately a separate webhook/channel
  // from SLACK_WEBHOOK_URL above, not a fallback to it - drift alerts and the general pipeline
  // health heartbeat are different audiences/urgency, so they're kept independent rather than
  // cross-posting. Optional, same skip-silently-if-unset behavior as SLACK_WEBHOOK_URL.
  DRIFT_CHECK_SLACK_WEBHOOK_URL: z.string().optional(),
  // Cost & Latency report (`npm run cost:report` / `--stage cost-report [--issue PROJ-123]`).
  // Deliberately its own webhook/channel, same "different audience" reasoning as
  // DRIFT_CHECK_SLACK_WEBHOOK_URL above - cost visibility is its own concern from drift alerts or
  // the general health heartbeat. Optional - if unset, the report is still written to
  // cost/report.json/.md (or cost/report-<key>.json/.md for a --issue-scoped run), the Slack post
  // is just skipped. Same CI-only-by-default gating as every other Slack integration here (see
  // SLACK_NOTIFY_LOCAL below).
  COST_REPORT_SLACK_WEBHOOK_URL: z.string().optional(),
  // blocker-scan's related-recipient "slack-channel" delivery (Phase 2, ScrumBlockerEscalationSchema's
  // relatedRecipients[].channels). Deliberately its own webhook/channel, same "different audience"
  // reasoning as DRIFT_CHECK_SLACK_WEBHOOK_URL/COST_REPORT_SLACK_WEBHOOK_URL above. A Slack
  // incoming webhook is bound to one fixed channel at creation time, so every relatedRecipient
  // configured with channel: 'slack-channel' posts here regardless of that recipient's own
  // `target` value - `target` is echoed into the message/report for context, not used to route
  // dynamically (see blockerScan.ts's own header comment for the fork this resolves). Same
  // CI-only-by-default gating as every other Slack channel-post here (see SLACK_NOTIFY_LOCAL
  // below) - unlike a DM, this posts to a real shared channel, so a local test run shouldn't spam
  // it by default. Optional - if unset, blocker-scan still writes its report and still posts the
  // Jira comment/Slack DM side of escalation, it just skips this one channel for any recipient
  // configured to use it.
  BLOCKER_SCAN_SLACK_WEBHOOK_URL: z.string().optional(),
  // blocker-scan's related-recipient "email" delivery (Real email delivery follow-on to Phase 2 -
  // see blockerScan.ts's header comment and src/pipeline/email/emailClient.ts's own doc comment
  // for the full design). Generic SMTP transport (nodemailer), not a vendor SDK - these five work
  // against Gmail SMTP, SendGrid SMTP, AWS SES SMTP, Outlook/Exchange Online SMTP, or any other
  // provider that speaks SMTP, with no provider-specific code anywhere in this file, same
  // "no hardcoded provider logic" rule this project already follows for VCS providers
  // (ScrumVcsConfigSchema's `provider` field). All five are needed together for email delivery to
  // actually work (see EmailClient's constructor, which requires each one individually) - they
  // stay independently optional here, same "if unset, this feature is just skipped" convention as
  // every other credential in this file, since most tenants won't configure email delivery at all.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // "From" address blocker-scan's emails are sent as - not necessarily the same account as
  // SMTP_USER (the authenticating account), since some providers (e.g. SendGrid, SES) authenticate
  // with an API-key-style username distinct from the verified sending address.
  SMTP_FROM: z.string().optional(),
  // Same CI-only-by-default gating as SLACK_NOTIFY_LOCAL above, applied to blocker-scan's email
  // channel instead of Slack (see teamConfig.ts's allowEmailNotify()) - a local test run sends a
  // real email to a real recipient's inbox, so it shouldn't do that by default any more than a
  // local Slack test should spam a shared channel. Set to "true" in your own .env to opt back in
  // locally, e.g. to test the SMTP integration itself. Has no effect in CI (GitHub Actions sets
  // CI=true, which already allows it).
  SMTP_NOTIFY_LOCAL: z.string().optional(),
  // Simple merge-ping (.github/workflows/merge-notify.yml) - a generic "PR #X merged: <title>"
  // post, one per merged PR, no per-ticket detail. Deliberately its own webhook/channel rather
  // than reusing SLACK_WEBHOOK_URL above, same "different audience" reasoning as
  // DRIFT_CHECK_SLACK_WEBHOOK_URL: a merge-ping fires far more often than the daily health report,
  // and mixing the two would drown the report's signal in routine merge noise. CI-only (this is a
  // GitHub Actions secret, never read locally). Optional - if unset, the workflow step just skips.
  MERGE_NOTIFY_SLACK_WEBHOOK_URL: z.string().optional(),
  // Full ticket summary (--stage ticket-summary --issue KEY). A Bot User OAuth Token (starts
  // "xoxb-"), not a webhook - unlike every other Slack integration in this file, this one DMs a
  // *specific person* (whoever ran the command) rather than posting to a fixed channel, which a
  // webhook has no way to do. Requires a Slack App with the users:read.email and chat:write bot
  // scopes, installed once by a workspace admin and shared team-wide (same distribution model as
  // the shared Qase account) - see docs/onboarding/internal-runbook.md (Step 5) for step-by-step
  // setup, or docs/onboarding/client-setup-guide.md (Section 2, Option B) for the version to hand
  // a client's own IT. Optional - if unset, the stage still prints the summary to the console, it
  // just skips the DM.
  SLACK_BOT_TOKEN: z.string().optional(),
  // Which email address --stage ticket-summary looks up (via users.lookupByEmail) to find your
  // Slack account for the DM. Optional - falls back to JIRA_EMAIL below, same fallback pattern as
  // PIPELINE_OPERATOR, since every team member already needs their own dedicated value there.
  // Only set this explicitly if your Slack account uses a different email than your Jira identity.
  SLACK_USER_EMAIL: z.string().optional(),
  // Public URL the *current* report.html is (or will be) reachable at - e.g. the repo's GitHub
  // Pages URL, sourced in CI from a repo Actions variable (see README's Pipeline Health Report
  // section). When set, the Slack message links directly to it, and report.html's per-domain
  // "Full X report" links point at that same site's self-hosted cost/report.html etc. (see
  // deriveSiteRoot/writeSubReportPages in pipelineReport.ts) instead of a relative path that only
  // resolves for a local repo checkout. When unset (e.g. running locally), both fall back
  // accordingly - Slack names the local file path as plain text, and the dashboard's sub-links
  // use the relative .md paths that work when opened from a real checkout.
  PIPELINE_REPORT_PUBLIC_URL: z.string().optional(),

  // Secrets-manager fix (per-tenant credential isolation) - the Key Vault URL AzureKeyVaultSecretsProvider
  // connects to (secretsProvider.ts). Deliberately a single global env var, not per-tenant: this
  // project's Key Vault deployment is one vault shared across every tenant that opts into it, with
  // per-tenant isolation achieved through secret *naming* (AzureKeyVaultSecretsProvider.toSecretName())
  // rather than one vault per tenant - see that class's own doc comment. Optional here because most
  // tenants stay on the 'env-file' default and never touch this; only required (via requireEnv(),
  // thrown lazily the first time a tenant actually selects 'azure-key-vault') once at least one
  // tenant's config/tenants/<id>.json sets integrations.secrets.provider to 'azure-key-vault'.
  AZURE_KEY_VAULT_URL: z.string().optional(),

  // Phase C ("AI-Assisted Scrum and SDLC Console - Development Plan", docs/planning/) - the AI
  // Queue backend (backend/, Phase 2) this CLI writes SUGGESTED items into. First-ever CLI ->
  // backend HTTP integration (see src/pipeline/queueClient/queueClient.ts) - everything before this
  // was flat-file-only on the CLI side, synced to Postgres later by a separate script
  // (backend/scripts/migrate-tenant.mjs). --stage draft-story genuinely has nowhere else useful to
  // put its output, so it calls the backend directly instead of writing yet another flat file for a
  // bridge script to pick up later. Optional here (same "if unset, this feature is just skipped"
  // convention as every other credential in this file) - only --stage draft-story needs these;
  // every other stage is completely unaffected either way. Tenant-overridable via the usual
  // <KEY>__<TENANT> mechanism (resolveTenantEnv below), same as every other per-tenant value here -
  // a real deployment maps one CLI tenant to one backend Project. No BACKEND_ORGANIZATION_ID here -
  // the queue-create route this calls (POST /api/projects/:projectId/queue, see
  // backend/src/app.mjs) is project-scoped only, same as every other create/list AI Queue route;
  // only the resolve route needs an organizationId, and nothing on the CLI side resolves a queue
  // item today.
  BACKEND_API_URL: z.string().optional(),
  BACKEND_PROJECT_ID: z.string().optional(),

  OUTPUT_DIR: z.string().default('output'),

  // Test Data via API - Restful-Booker-Platform (src/api/testData/booking.ts). Dedicated test
  // credentials for a free public practice app, never a real application session.
  RBP_API_BASE_URL: z.string().default('https://automationintesting.online/api'),
  RBP_AUTH_USERNAME: z.string().optional(),
  RBP_AUTH_PASSWORD: z.string().optional(),

  // Manual-Tester Agent target application (persona exploration + ticket-driven verification).
  // The live web app under test and its seeded, disposable test account - credentials by reference
  // only, never inlined into personas.json (Secrets Guardrail). Tenant-overridable via the usual
  // <KEY>__<TENANT> mechanism, same as every other per-tenant value here. Optional: only the
  // manual-tester stages need them; every other stage is unaffected.
  APP_BASE_URL: z.string().optional(),
  APP_TEST_USERNAME: z.string().optional(),
  APP_TEST_PASSWORD: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);

export function requireEnv<K extends keyof typeof env>(
  key: K,
  context: string,
): NonNullable<(typeof env)[K]> {
  const value = env[key];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required env var ${String(key)} (needed by ${context}). Copy .env.example to .env and set it.`,
    );
  }
  return value as NonNullable<(typeof env)[K]>;
}

// The default secrets backend - wraps the exact resolution env.ts always used before the
// Secrets-manager fix (see secretsProvider.ts's EnvFileSecretsProvider doc comment). Constructed
// once, eagerly, since it does no I/O or credential work itself (unlike the Key Vault provider
// below, which is genuinely lazy).
const envFileProvider = new EnvFileSecretsProvider(env);

// The Key Vault backend, by contrast, IS genuinely lazy: constructing it requires
// AZURE_KEY_VAULT_URL to be set, which most tenants (still on the 'env-file' default) never set at
// all. Building it eagerly at module load would make every single pipeline invocation - even one
// that never touches a Key Vault tenant - fail on missing AZURE_KEY_VAULT_URL. Built once and
// cached on first real use instead.
let azureKeyVaultProvider: SecretsProvider | undefined;
function getAzureKeyVaultProvider(): SecretsProvider {
  if (!azureKeyVaultProvider) {
    const vaultUrl = requireEnv('AZURE_KEY_VAULT_URL', 'Azure Key Vault secrets provider');
    azureKeyVaultProvider = new AzureKeyVaultSecretsProvider(vaultUrl);
  }
  return azureKeyVaultProvider;
}

/**
 * Per-tenant credential/config resolution, for values that can legitimately differ per tenant
 * (Jira/Qase/Slack credentials - see jiraClient.ts/qaseClient.ts/pipeline.ts's Slack stage
 * handlers). Delegates to this tenant's configured SecretsProvider (config/tenants/<id>.json's
 * integrations.secrets.provider, via capabilityStore.ts's resolveSecretsProvider() -
 * secretsProvider.ts's SecretsProvider interface / EnvFileSecretsProvider / AzureKeyVaultSecretsProvider)
 * - defaulting to 'env-file', which reproduces this function's exact original (pre-Secrets-manager-fix)
 * behavior: the tenant-specific override env var (<KEY>__<TENANT>, read directly off process.env -
 * never declared in EnvSchema, since only the bare keys are validated/typed), then the bare <KEY>
 * (today's single-tenant value, from the already-parsed `env` object). Every existing
 * single-tenant .env keeps working completely unchanged, since nobody sets a <KEY>__DEFAULT
 * override and no tenant has opted into a different provider - same non-breaking precedence
 * pattern as resolveTenantId() in tenantContext.ts.
 *
 * ASYNC, unlike the pre-Secrets-manager-fix version of this function - a real secrets-manager call
 * is inherently network I/O, so this can no longer be a synchronous process.env read once a tenant
 * is on a real provider. This ripples through every one of this function's 8 real callers
 * (env.ts itself, emailClient.ts, jiraClient.ts, pipeline.ts, agileClient.ts,
 * vcsClient/githubClient.ts, vcsClient/index.ts, qaseClient.ts) - each now awaits it rather than
 * reading a plain return value.
 *
 * Must be called after setTenantId() has run in main() to resolve the *real* tenant - like
 * getTenantId() itself, it silently falls back to 'default' if called earlier (e.g. in a test
 * that never calls setTenantId()), which is intentional so existing tests don't need tenant setup
 * just to exercise a credential-consuming code path.
 */
export async function resolveTenantEnv<K extends keyof typeof env>(key: K): Promise<(typeof env)[K]> {
  const tenantId = getTenantId();
  const providerName = resolveSecretsProvider();
  const provider = selectSecretsProvider(providerName, {
    envFile: envFileProvider,
    azureKeyVault: getAzureKeyVaultProvider,
  });
  const value = await provider.getSecret(tenantId, String(key));
  return (value !== undefined && value !== '' ? value : undefined) as (typeof env)[K];
}

/** Tenant-aware counterpart to requireEnv() above - see resolveTenantEnv's doc comment. */
export async function requireTenantEnv<K extends keyof typeof env>(
  key: K,
  context: string,
): Promise<NonNullable<(typeof env)[K]>> {
  const tenantId = getTenantId();
  const value = await resolveTenantEnv(key);
  if (value === undefined || value === '') {
    const providerName = resolveSecretsProvider();
    const howToFix =
      providerName === 'env-file'
        ? `Set ${envFileTenantKey(String(key), tenantId)} for this tenant specifically, or ${String(key)} as ` +
          'the shared/default value. Copy .env.example to .env and set it.'
        : `Provision it in the "${providerName}" secrets provider under the name this provider ` +
          'expects (see docs/onboarding/internal-runbook.md\'s secrets-manager section) - a ' +
          "missing secret is deliberately not left to fall back to the shared .env value.";
    throw new Error(
      `Missing required secret ${String(key)} (needed by ${context}) for tenant "${tenantId}" via ` +
        `the "${providerName}" secrets provider. ${howToFix}`,
    );
  }
  return value as NonNullable<(typeof env)[K]>;
}
